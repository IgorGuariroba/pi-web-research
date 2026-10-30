/**
 * curation.ts — curadoria do Funil: busca curada (spam, Fora do tema, Nível,
 * Critério), Extração focada e classificação de página lida fora das buscas.
 * Classificador quando houver; regras como caminho padrão e em falha.
 */
import { aggregateSearch, DEFAULT_SEARCH_MODE, type AggregatedResult } from "./aggregate-search.ts";
import { OFF_TOPIC_THRESHOLD, type Classifier } from "./classifier.ts";
import { OTHER_CATEGORY, type Criterion } from "./criteria.ts";
import { focusedCandidates, focusedExtract } from "./focused-extract.ts";
import type { SourceLabel } from "./read-sources.ts";
import {
  classifierFailed, keptCount, recordOffTopic, type CuratedResult, type ReadDiscardReason, type ResearchRun,
} from "./research-run.ts";
import {
  curateByRules, isSpam, MAX_RESULTS_PER_SEARCH, sourceLabelText, sortByLevel, subjectTerms,
} from "./source-level.ts";

/**
 * Curadoria por classificador: spam fixo/blockedDomains sai sem gastar o
 * classificador; uma chamada julga o resto (Fora do tema e Nível). Em falha,
 * devolve undefined (a busca cai nas regras).
 */
async function curateByClassifier(run: ResearchRun, classifier: Classifier, query: string, results: readonly AggregatedResult[], signal?: AbortSignal) {
  const { options } = run;
  const kept = results.filter((result) => !isSpam(result.url, options.blockedDomains));
  let spam = results.length - kept.length;
  let offTopic = 0;
  let criteriaDiscarded = 0;
  if (!kept.length) return { results: [] as CuratedResult[], spam, offTopic, criteriaDiscarded };
  const criteria = run.criteria;
  try {
    const { judgements, costUsd } = await classifier.judgeResults(
      {
        goal: options.goal, focus: options.focus, query,
        results: kept.map(({ url, title, summary }) => ({ url, title, summary })),
        ...(criteria ? { criteria } : {}),
      },
      signal,
    );
    run.classifierCost += costUsd;
    const leveled: CuratedResult[] = [];
    kept.forEach((result, i) => {
      const judgement = judgements[i] ?? { offTopic: 0, level: "blog" as const };
      const criterion = criteria?.find((c) => c.category === judgement.category);
      if (judgement.offTopic > OFF_TOPIC_THRESHOLD) {
        offTopic++;
        recordOffTopic(run, result.url, judgement.offTopic);
      }
      else if (judgement.level === "spam") spam++;
      else if (criterion?.discard) criteriaDiscarded++;
      else if (criteria) leveled.push({ ...result, level: judgement.level, category: criterion?.category ?? OTHER_CATEGORY });
      else leveled.push({ ...result, level: judgement.level });
    });
    return { results: criteria ? sortByCriteria(sortByLevel(leveled), criteria) : sortByLevel(leveled), spam, offTopic, criteriaDiscarded };
  } catch (error) {
    classifierFailed(run, classifier, error, signal, true);
    return undefined;
  }
}

/** Ordena por prioridade do Critério (`outros` por último), estável sobre Nível → Concordância. */
function sortByCriteria(results: CuratedResult[], criteria: readonly Criterion[]): CuratedResult[] {
  const rank = (result: CuratedResult) => {
    const index = criteria.findIndex((c) => c.category === result.category);
    return index < 0 ? criteria.length : index;
  };
  return results.sort((a, b) => rank(a) - rank(b));
}

/** Linha de título do resultado mostrado: `título [categoria · nível · providers]`. */
export const titledLabel = (result: CuratedResult) => `${result.title} ${sourceLabelText(result)}`;

/** Busca agregada + curadoria por regras: spam fora, Nível → Concordância, top 8. */
export async function search(run: ResearchRun, query: string, signal?: AbortSignal) {
  const { options, funnel } = run;
  const response = await aggregateSearch(options.providers, query, options.searchMode ?? DEFAULT_SEARCH_MODE, signal);
  const judged = run.classifier ? await curateByClassifier(run, run.classifier, query, response.results, signal) : undefined;
  const curated = judged ?? curateByRules(response.results, subjectTerms(options.goal, query), options.blockedDomains);
  funnel.found += response.found;
  funnel.unique += response.results.length;
  funnel.duplicates = funnel.found - funnel.unique;
  funnel.spam += curated.spam;
  if (funnel.offTopic !== undefined) funnel.offTopic += judged?.offTopic ?? 0;
  if (funnel.criteriaDiscarded !== undefined) funnel.criteriaDiscarded += judged?.criteriaDiscarded ?? 0;
  run.searchWarnings.push(...response.warnings);
  const kept = keptCount(funnel);
  const discarded = [
    `${funnel.spam} spam`,
    ...(funnel.offTopic === undefined ? [] : [`${funnel.offTopic} fora do tema`]),
    ...(funnel.criteriaDiscarded === undefined ? [] : [`${funnel.criteriaDiscarded} pelo Critério`]),
  ].join(", ");
  options.onProgress?.(`${funnel.found} resultados → ${funnel.unique} únicos → ${kept} após descarte (${discarded})`);
  return { ...response, results: curated.results.slice(0, MAX_RESULTS_PER_SEARCH) };
}

/**
 * Extração focada: com classificador que dá nota a trechos, ~20 candidatos das
 * regras são reordenados pela nota; sem ele (ou em falha), só regras.
 */
export async function focusPage(run: ResearchRun, text: string, queries: readonly string[], signal?: AbortSignal): Promise<string> {
  const { options } = run;
  const context = [options.goal, options.focus, ...queries];
  const classifier = run.classifier;
  const candidates = classifier?.scorePassages ? focusedCandidates(text, context) : undefined;
  if (!classifier?.scorePassages || !candidates) return focusedExtract(text, context);
  try {
    const { scores, costUsd } = await classifier.scorePassages(
      { goal: options.goal, focus: options.focus, query: queries.at(-1), passages: candidates.passages }, signal,
    );
    run.classifierCost += costUsd;
    return candidates.extract(scores);
  } catch (error) {
    classifierFailed(run, classifier, error, signal, false);
    return focusedExtract(text, context);
  }
}

const READ_SUMMARY_MAX = 300;

/** Página lida descartada pela curadoria: não vira Fonte lida nem chega ao subagente. */
export interface DiscardedPage {
  discard: ReadDiscardReason;
}

/**
 * Classificação na leitura de página fora das buscas: Fora do tema, Nível e
 * Categoria do Critério. Fora do tema, Nível spam ou Categoria de descarte →
 * descarte (o mesmo corte das buscas). undefined = sem classificador ou falha.
 */
export async function classifyRead(
  run: ResearchRun, url: string, text: string, queries: readonly string[], signal?: AbortSignal,
): Promise<SourceLabel | DiscardedPage | undefined> {
  const { options, classifier, criteria } = run;
  if (!classifier) return undefined;
  const title = (text.split("\n", 1)[0] ?? "").trim().slice(0, 200) || url;
  try {
    const { judgements, costUsd } = await classifier.judgeResults(
      {
        goal: options.goal, focus: options.focus, query: queries.at(-1) ?? options.goal,
        results: [{ url, title, summary: text.slice(0, READ_SUMMARY_MAX) }],
        ...(criteria ? { criteria } : {}),
      },
      signal,
    );
    run.classifierCost += costUsd;
    const judgement = judgements[0];
    if (!judgement) return undefined;
    if (judgement.offTopic > OFF_TOPIC_THRESHOLD) {
      recordOffTopic(run, url, judgement.offTopic);
      return { discard: "fora do tema" };
    }
    if (judgement.level === "spam") return { discard: "spam" };
    if (!criteria) return { level: judgement.level };
    const criterion = criteria.find((c) => c.category === judgement.category);
    if (criterion?.discard) return { discard: "critério" };
    return { level: judgement.level, category: criterion?.category ?? OTHER_CATEGORY };
  } catch (error) {
    classifierFailed(run, classifier, error, signal, true);
    return undefined;
  }
}

/** Aviso curto devolvido ao subagente no lugar do conteúdo de página descartada. */
const DISCARD_REASON: Record<ReadDiscardReason, string> = {
  "fora do tema": "Fora do tema do Goal",
  spam: "domínio de spam/bloqueado ou fonte julgada spam",
  "critério": "Categoria de descarte do Critério",
};
export const discardedReadNotice = (reason: ReadDiscardReason) =>
  `Página descartada: ${DISCARD_REASON[reason]}. Não é Fonte lida; não a cite em 'Fontes' e não use o conteúdo dela.`;
