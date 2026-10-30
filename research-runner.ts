/**
 * research-runner.ts — núcleo de Research.
 *
 * Ponto único que executa o Funil: Subagente de pesquisa (web_search + fetch_url)
 * e, se ele falhar, o Fallback cru. Todas as fronteiras externas são injetadas:
 * Providers, porta de fetch de páginas e modelo/runtime do subagente. A tool
 * `research` e o `/web-search` são casca fina que montam estas dependências.
 */
import {
  createAgentSession,
  DEFAULT_MAX_BYTES,
  DefaultResourceLoader,
  formatSize,
  SessionManager,
  SettingsManager,
  truncateHead,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import type { WebSearchProvider } from "./search-types.ts";
import { aggregateSearch, type AggregatedResult, type SearchMode } from "./aggregate-search.ts";
import { fetchPage, UnsupportedPdfError, type HttpFetch } from "./fetch-url.ts";
import { focusedCandidates, focusedExtract } from "./focused-extract.ts";
import {
  curateByRules, isSpam, sourceLevel, levelLabel, MAX_RESULTS_PER_SEARCH, shortSnippet, sortByLevel, subjectTerms, type LeveledResult,
} from "./source-level.ts";
import { detectClassifier, OFF_TOPIC_THRESHOLD, type Classifier, type ClassifierChoice } from "./classifier.ts";
import { OTHER_CATEGORY, validateCriteria, type Criterion } from "./criteria.ts";
import {
  correctionMessage, declareGap, labelCitations, readsByCategory, ReadSources, removeUnreadCitations, sourceKey, unreadCitations, type SourceLabel,
} from "./read-sources.ts";
import { buildResearchPrompt, createResearchBudget, getResearchLimits, type ResearchDepth } from "./research.ts";

type Model = NonNullable<ReturnType<ModelRegistry["find"]>>;

export interface RunResearchOptions {
  goal: string;
  focus?: string;
  depth: ResearchDepth;
  /** Critério do Agente pai: 2 a 8 Categorias ordenadas por prioridade. */
  criteria?: readonly Criterion[];
  /** Providers de busca disponíveis, em ordem de preferência. */
  providers: readonly WebSearchProvider[];
  /** Modo de busca: `agregada` (padrão, todos em paralelo) ou `econômica` (um por vez). */
  searchMode?: SearchMode;
  /** Domínios cortados como spam, além da lista fixa. */
  blockedDomains?: readonly string[];
  /**
   * Classificador: instância injetada, ou escolha salva (`auto` detecta pelo model
   * registry; `none` = só regras). Padrão: `auto`.
   */
  classifier?: Classifier | ClassifierChoice;
  /** Porta de HTTP para leitura de páginas (padrão: fetch global). */
  fetch?: HttpFetch;
  modelRegistry: ModelRegistry;
  /** Modelo de pesquisa salvo em /web-search. */
  modelRef?: { provider: string; id: string };
  /** Modelo atual do Agente pai (último recurso do Modelo de pesquisa). */
  parentModel?: Model;
  cwd: string;
  agentDir?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ResearchResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
}

/** Preferência de modelos baratos para o Modelo de pesquisa padrão. */
const CHEAP_MODEL_PATTERNS = [/haiku/i, /flash/i, /(^|[-_/. ])mini($|[-_/. ])/i];

export function chooseResearchModel(
  modelRegistry: ModelRegistry,
  modelRef: { provider: string; id: string } | undefined,
  parentModel: Model | undefined,
): Model | undefined {
  if (modelRef) {
    const saved = modelRegistry.find(modelRef.provider, modelRef.id);
    if (saved) return saved;
  }
  const available = modelRegistry.getAvailable();
  for (const pattern of CHEAP_MODEL_PATTERNS) {
    const cheap = available.find((model) => pattern.test(model.id));
    if (cheap) return cheap;
  }
  return parentModel ?? available[0];
}

function textOfLastAssistant(messages: readonly any[]): string {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  return message?.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n").trim() ?? "";
}

/** Contadores do Funil, acumulados nas buscas de uma Research. */
interface Funnel {
  found: number;
  unique: number;
  duplicates: number;
  /** Resultados descartados como spam. */
  spam: number;
  /** Resultados descartados como Fora do tema (só com classificador). */
  offTopic?: number;
  /** Resultados descartados por Categoria de descarte do Critério (só com Critério ativo). */
  criteriaDiscarded?: number;
}

const emptyFunnel = (classifier: Classifier | undefined, criteria?: readonly Criterion[]): Funnel => ({
  found: 0, unique: 0, duplicates: 0, spam: 0,
  ...(classifier ? { offTopic: 0 } : {}),
  ...(classifier && criteria ? { criteriaDiscarded: 0 } : {}),
});

/** Resultados que sobreviveram ao descarte (spam, Fora do tema, Critério). */
const keptCount = (funnel: Funnel) => funnel.unique - funnel.spam - (funnel.offTopic ?? 0) - (funnel.criteriaDiscarded ?? 0);

/** Resultado curado com a Categoria do Critério, quando houver. */
type CuratedResult = LeveledResult & { category?: string };

interface ResearchRun {
  options: RunResearchOptions;
  funnel: Funnel;
  searchWarnings: string[];
  classifier?: Classifier;
  classifierCost: number;
  /** Critério ativo (só com classificador; sem ele o Critério é ignorado). */
  criteria?: readonly Criterion[];
  /** Julgamentos de resultados/páginas que caíram nas regras por falha do classificador. */
  judgeFailures: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Falha do classificador: cancelamento propaga; senão vira aviso (o chamador cai
 * nas regras). Falha de julgamento (Fora do tema/Nível/Categoria) conta para o
 * Critério degradado.
 */
function classifierFailed(run: ResearchRun, classifier: Classifier, error: unknown, signal: AbortSignal | undefined, judging: boolean) {
  if (signal?.aborted) throw error;
  run.searchWarnings.push(`classificador ${classifier.name} falhou: ${errorText(error)}; usando regras`);
  if (judging) run.judgeFailures++;
}

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
      if (judgement.offTopic > OFF_TOPIC_THRESHOLD) offTopic++;
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

/** Rótulo `[categoria · nível · providers]` (ou `[nível · providers]` sem Categoria). */
const label = (result: CuratedResult) =>
  result.category ? `${result.title} [${result.category} · ${result.level} · ${result.providers.join("+")}]` : `${result.title} ${levelLabel(result)}`;

/** Busca agregada + curadoria por regras: spam fora, Nível → Concordância, top 8. */
async function search(run: ResearchRun, query: string, signal?: AbortSignal) {
  const { options, funnel } = run;
  const response = await aggregateSearch(options.providers, query, options.searchMode ?? "agregada", signal);
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
async function focusPage(run: ResearchRun, text: string, queries: readonly string[], signal?: AbortSignal): Promise<string> {
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

/** Página lida julgada Fora do tema: sempre descartada (não vira Fonte lida). */
interface OffTopicRead {
  offTopic: number;
}

/**
 * Classificação na leitura de página fora das buscas: Fora do tema, Nível e
 * Categoria do Critério. Fora do tema → descarte (com ou sem Critério).
 * Spam → Nível por regras. undefined = sem classificador ou falha.
 */
async function classifyRead(
  run: ResearchRun, url: string, text: string, queries: readonly string[], signal?: AbortSignal,
): Promise<SourceLabel | OffTopicRead | undefined> {
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
    if (judgement.offTopic > OFF_TOPIC_THRESHOLD) return { offTopic: judgement.offTopic };
    const level = judgement.level === "spam" ? sourceLevel(url, subjectTerms(options.goal, ...queries)) : judgement.level;
    if (!criteria) return { level };
    const category = criteria.find((c) => c.category === judgement.category)?.category;
    return { level, category: category ?? OTHER_CATEGORY };
  } catch (error) {
    classifierFailed(run, classifier, error, signal, true);
    return undefined;
  }
}

const OFF_TOPIC_READ =
  "Página descartada: Fora do tema do Goal. Não é Fonte lida; não a cite em 'Fontes' e não use o conteúdo dela.";

function funnelDetails(run: ResearchRun) {
  const details: Record<string, unknown> = {
    searchMode: run.options.searchMode ?? "agregada", funnel: { ...run.funnel },
    classifier: run.classifier?.name ?? "nenhum", classifierCost: run.classifierCost,
  };
  if (run.searchWarnings.length) details.searchWarnings = [...run.searchWarnings];
  return details;
}

interface SubagentOutcome {
  text: string;
  sourcesRead: number;
  removedCitations: string[];
  /** Leituras por Categoria do Critério (só com Critério ativo). */
  readsByCategory?: Record<string, number>;
}

async function runSubagent(run: ResearchRun, model: Model): Promise<SubagentOutcome> {
  const { options } = run;
  const { depth, signal } = options;
  const sources = new ReadSources();
  const budget = createResearchBudget(depth);
  const limits = getResearchLimits(depth);
  const queries: string[] = [];
  /** Classificação dos resultados mostrados nas buscas, pela URL canônica. */
  const seen = new Map<string, SourceLabel>();
  /** Rótulo da Fonte lida; undefined = página Fora do tema (descartada). */
  const labelOf = async (requested: string, final: string, text: string, toolSignal?: AbortSignal): Promise<SourceLabel | undefined> => {
    const known = seen.get(sourceKey(requested)) ?? seen.get(sourceKey(final));
    if (known) return known;
    // Página fora das buscas: classificada na leitura; sem classificador (ou em
    // falha), Nível por regras e Categoria `outros` com Critério ativo.
    const judged = await classifyRead(run, final, text, queries, toolSignal);
    if (judged && "offTopic" in judged) return undefined;
    if (judged) return judged;
    const level = sourceLevel(final, subjectTerms(options.goal, ...queries));
    return run.criteria ? { level, category: OTHER_CATEGORY } : { level };
  };

  // IMPORTANTE: reutiliza o ModelRuntime do agente pai. Sem isso, o SDK cria um
  // runtime novo que NÃO conhece providers registrados dinamicamente por
  // extensões (ex.: omniroute) — a sessão filha roda com noExtensions:true e
  // falharia com "No API key found for <provider>".
  const parentRuntime = (options.modelRegistry as unknown as { runtime?: unknown }).runtime;

  const webSearchTool: ToolDefinition<any> = {
    name: "web_search", label: "Web Search",
    description: "Busca a web. Use queries específicas; prefira fontes primárias.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, params, toolSignal) {
      if (!budget.consumeSearch()) return { content: [{ type: "text", text: "Orçamento de buscas esgotado. Produza a síntese final agora." }] };
      options.onProgress?.(`Buscando: ${params.query}`);
      queries.push(params.query);
      const result = await search(run, params.query, toolSignal);
      for (const item of result.results) {
        seen.set(sourceKey(item.url), item.category ? { level: item.level, category: item.category } : { level: item.level });
      }
      const list = result.results.map((r, i) => `${i + 1}. ${label(r)}\n${r.url}\n${shortSnippet(r.summary)}`).join("\n\n")
        || result.rawText || "Sem resultados.";
      const warnings = result.warnings.map((w) => `Aviso: ${w}`).join("\n");
      return { content: [{ type: "text", text: warnings ? `${warnings}\n\n${list}` : list }] };
    },
  };
  const fetchUrlTool: ToolDefinition<any> = {
    name: "fetch_url", label: "Fetch URL",
    description: "Lê uma página HTTP(S) pública e retorna texto truncado.",
    parameters: Type.Object({ url: Type.String() }),
    async execute(_id, params, toolSignal) {
      if (!budget.consumeFetch()) return { content: [{ type: "text", text: "Orçamento de páginas esgotado. Produza a síntese final agora." }] };
      options.onProgress?.(`Lendo fonte: ${params.url}`);
      let page: Awaited<ReturnType<typeof fetchPage>>;
      try {
        page = await fetchPage(params.url, toolSignal, options.fetch);
      } catch (error) {
        if (error instanceof UnsupportedPdfError) budget.refundFetch();
        throw error;
      }
      const sourceLabel = await labelOf(params.url, page.url, page.text, toolSignal);
      if (!sourceLabel) return { content: [{ type: "text", text: `URL final: ${page.url}\n\n${OFF_TOPIC_READ}` }] };
      sources.add(params.url, page.url, sourceLabel);
      const text = await focusPage(run, page.text, queries, toolSignal);
      return { content: [{ type: "text", text: `URL final: ${page.url}\n\n${text}` }] };
    },
  };

  const agentDir = options.agentDir ?? `${homedir()}/.pi/agent`;
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: options.cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: "Você é um pesquisador web. Use apenas as tools disponíveis e entregue somente a síntese final solicitada, em português do Brasil.",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: options.cwd, agentDir, model, thinkingLevel: "low",
    modelRuntime: parentRuntime as never,
    resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.inMemory(options.cwd),
    noTools: "all", tools: ["web_search", "fetch_url"], customTools: [webSearchTool, fetchUrlTool],
  });
  const abort = () => void session.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    options.onProgress?.(`Pesquisa ${depth} iniciada…`);
    const deadline = Date.now() + limits.timeoutMs;
    const prompt = async (text: string) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          session.prompt(text, { expandPromptTemplates: false, source: "extension" }),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              void session.abort();
              reject(new Error("Pesquisa excedeu o timeout."));
            }, Math.max(0, deadline - Date.now()));
          }),
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      if (signal?.aborted) throw signal.reason ?? new Error("Pesquisa cancelada.");
    };
    await prompt(buildResearchPrompt(options.goal, options.focus, depth, run.criteria));
    let answer = textOfLastAssistant(session.messages);
    if (!answer) throw new Error("Subagente não produziu uma síntese.");
    const unread = unreadCitations(answer, sources);
    if (unread.length) {
      options.onProgress?.(`Fontes não lidas citadas (${unread.length}); pedindo correção…`);
      await prompt(correctionMessage(unread));
      answer = textOfLastAssistant(session.messages) || answer;
    }
    const { text: verified, removed } = removeUnreadCitations(answer, sources);
    const labeled = labelCitations(verified, sources);
    const text = run.criteria ? declareGap(labeled, sources, run.criteria) : labeled;
    options.onProgress?.(`${run.funnel.found} resultados → ${keptCount(run.funnel)} após descarte → ${sources.size} lidos`);
    return {
      text, sourcesRead: sources.size, removedCitations: removed,
      ...(run.criteria ? { readsByCategory: readsByCategory(sources, run.criteria) } : {}),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}

async function rawFallback(run: ResearchRun, error: unknown, researchModel: string | undefined): Promise<ResearchResult> {
  const { options } = run;
  options.onProgress?.("Subagente falhou; buscando fallback sem síntese…");
  // Contadores do Fallback cru descrevem só a busca do fallback.
  run.funnel = emptyFunnel(run.classifier, run.criteria);
  run.searchWarnings = [];
  run.judgeFailures = 0;
  const response = await search(run, options.goal, options.signal);
  const formatted = response.results.length
    ? response.results.map((r, i) => `${i + 1}. ${label(r)}\n   ${r.url}\n   ${shortSnippet(r.summary)}`).join("\n\n")
    : response.rawText || "research: sem resultados.";
  const warnings = response.warnings.map((w) => `[Aviso: ${w}]\n`).join("");
  const truncation = truncateHead(formatted, { maxLines: Number.MAX_SAFE_INTEGER });
  const notice = truncation.truncated ? `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]` : "";
  const criteria = criteriaNotice(run);
  return {
    content: [{ type: "text", text: `${criteria.text ? `[${criteria.text}]\n` : ""}[Fallback sem síntese — o subagente falhou: ${errorText(error)}]\n${warnings}\n${truncation.content}${notice}` }],
    details: {
      provider: response.providers.join("+"), query: options.goal, resultCount: response.results.length,
      fallback: true, researchModel, ...criteria.details, ...funnelDetails(run),
    },
  };
}

const CRITERIA_IGNORED =
  "Critério ignorado — nenhum classificador disponível; resultados curados só por regras (sem Categoria nem descarte por Critério).";

/**
 * Aviso sobre o Critério (topo da Síntese e details): ignorado (sem
 * classificador) ou degradado (classificador falhou em parte dos julgamentos).
 */
function criteriaNotice(run: ResearchRun): { text?: string; details: Record<string, string> } {
  if (run.options.criteria && !run.criteria) return { text: CRITERIA_IGNORED, details: { criteriaIgnored: CRITERIA_IGNORED } };
  if (run.criteria && run.classifier && run.judgeFailures) {
    const text = `Critério degradado — classificador ${run.classifier.name} falhou em ${run.judgeFailures} julgamento(s); `
      + "esses resultados/páginas foram curados só por regras (sem Categoria nem descarte por Critério).";
    return { text, details: { criteriaDegraded: text } };
  }
  return { details: {} };
}

const UNVERIFIED_NOTICE =
  "[Síntese não verificada — nenhuma Fonte lida: o subagente não leu nenhuma página com sucesso; a Síntese se apoia apenas em resultados de busca.]";

/** Núcleo de Research: subagente + Fallback cru. */
export async function runResearch(options: RunResearchOptions): Promise<ResearchResult> {
  validateCriteria(options.criteria);
  const model = chooseResearchModel(options.modelRegistry, options.modelRef, options.parentModel);
  const researchModel = model ? `${model.provider}/${model.id}` : undefined;
  const choice = options.classifier ?? "auto";
  const classifier = typeof choice === "object" && "judgeResults" in choice
    ? choice
    : await detectClassifier(options.modelRegistry, choice);
  const criteria = classifier ? options.criteria : undefined;
  const run: ResearchRun = { options, funnel: emptyFunnel(classifier, criteria), searchWarnings: [], classifier, classifierCost: 0, criteria, judgeFailures: 0 };
  try {
    if (!model) throw new Error("Modelo de pesquisa indisponível; configure-o em /web-search.");
    const outcome = await runSubagent(run, model);
    const unverified = outcome.sourcesRead === 0;
    const criteriaWarning = criteriaNotice(run);
    const text = [criteriaWarning.text && `[${criteriaWarning.text}]`, unverified && UNVERIFIED_NOTICE, outcome.text].filter(Boolean).join("\n\n");
    return {
      content: [{ type: "text", text }],
      details: {
        depth: options.depth, synthesized: true, researchModel,
        sourcesRead: outcome.sourcesRead, removedCitations: outcome.removedCitations,
        ...(outcome.readsByCategory ? { readsByCategory: outcome.readsByCategory } : {}),
        ...(unverified ? { unverified: true } : {}),
        ...criteriaWarning.details,
        ...funnelDetails(run),
      },
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return rawFallback(run, error, researchModel);
  }
}
