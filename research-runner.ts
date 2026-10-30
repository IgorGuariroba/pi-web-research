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
import { focusedExtract } from "./focused-extract.ts";
import {
  curateByRules, isSpam, levelLabel, MAX_RESULTS_PER_SEARCH, shortSnippet, sortByLevel, subjectTerms, type LeveledResult,
} from "./source-level.ts";
import { detectClassifier, OFF_TOPIC_THRESHOLD, type Classifier, type ClassifierChoice } from "./classifier.ts";
import { correctionMessage, ReadSources, removeUnreadCitations, unreadCitations } from "./read-sources.ts";
import { buildResearchPrompt, createResearchBudget, getResearchLimits, type ResearchDepth } from "./research.ts";

type Model = NonNullable<ReturnType<ModelRegistry["find"]>>;

export interface RunResearchOptions {
  goal: string;
  focus?: string;
  depth: ResearchDepth;
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
}

const emptyFunnel = (classifier: Classifier | undefined): Funnel =>
  ({ found: 0, unique: 0, duplicates: 0, spam: 0, ...(classifier ? { offTopic: 0 } : {}) });

interface ResearchRun {
  options: RunResearchOptions;
  funnel: Funnel;
  searchWarnings: string[];
  classifier?: Classifier;
  classifierCost: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
  if (!kept.length) return { results: [] as LeveledResult[], spam, offTopic };
  try {
    const { judgements, costUsd } = await classifier.judgeResults(
      { goal: options.goal, focus: options.focus, query, results: kept.map(({ url, title, summary }) => ({ url, title, summary })) },
      signal,
    );
    run.classifierCost += costUsd;
    const leveled: LeveledResult[] = [];
    kept.forEach((result, i) => {
      const judgement = judgements[i] ?? { offTopic: 0, level: "blog" as const };
      if (judgement.offTopic > OFF_TOPIC_THRESHOLD) offTopic++;
      else if (judgement.level === "spam") spam++;
      else leveled.push({ ...result, level: judgement.level });
    });
    return { results: sortByLevel(leveled), spam, offTopic };
  } catch (error) {
    if (signal?.aborted) throw error;
    run.searchWarnings.push(`classificador ${classifier.name} falhou: ${errorText(error)}; usando regras`);
    return undefined;
  }
}

const label = (result: LeveledResult) => `${result.title} ${levelLabel(result)}`;

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
  run.searchWarnings.push(...response.warnings);
  const kept = funnel.unique - funnel.spam - (funnel.offTopic ?? 0);
  const discarded = funnel.offTopic === undefined ? `${funnel.spam} spam` : `${funnel.spam} spam, ${funnel.offTopic} fora do tema`;
  options.onProgress?.(`${funnel.found} resultados → ${funnel.unique} únicos → ${kept} após descarte (${discarded})`);
  return { ...response, results: curated.results.slice(0, MAX_RESULTS_PER_SEARCH) };
}

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
}

async function runSubagent(run: ResearchRun, model: Model): Promise<SubagentOutcome> {
  const { options } = run;
  const { depth, signal } = options;
  const sources = new ReadSources();
  const budget = createResearchBudget(depth);
  const limits = getResearchLimits(depth);
  const queries: string[] = [];

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
      sources.add(params.url, page.url);
      const text = focusedExtract(page.text, [options.goal, options.focus, ...queries]);
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
    await prompt(buildResearchPrompt(options.goal, options.focus, depth));
    let answer = textOfLastAssistant(session.messages);
    if (!answer) throw new Error("Subagente não produziu uma síntese.");
    const unread = unreadCitations(answer, sources);
    if (unread.length) {
      options.onProgress?.(`Fontes não lidas citadas (${unread.length}); pedindo correção…`);
      await prompt(correctionMessage(unread));
      answer = textOfLastAssistant(session.messages) || answer;
    }
    const { text, removed } = removeUnreadCitations(answer, sources);
    return { text, sourcesRead: sources.size, removedCitations: removed };
  } finally {
    signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}

async function rawFallback(run: ResearchRun, error: unknown, researchModel: string | undefined): Promise<ResearchResult> {
  const { options } = run;
  options.onProgress?.("Subagente falhou; buscando fallback sem síntese…");
  // Contadores do Fallback cru descrevem só a busca do fallback.
  run.funnel = emptyFunnel(run.classifier);
  run.searchWarnings = [];
  const response = await search(run, options.goal, options.signal);
  const formatted = response.results.length
    ? response.results.map((r, i) => `${i + 1}. ${label(r)}\n   ${r.url}\n   ${shortSnippet(r.summary)}`).join("\n\n")
    : response.rawText || "research: sem resultados.";
  const warnings = response.warnings.map((w) => `[Aviso: ${w}]\n`).join("");
  const truncation = truncateHead(formatted, { maxLines: Number.MAX_SAFE_INTEGER });
  const notice = truncation.truncated ? `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]` : "";
  return {
    content: [{ type: "text", text: `[Fallback sem síntese — o subagente falhou: ${error instanceof Error ? error.message : String(error)}]\n${warnings}\n${truncation.content}${notice}` }],
    details: {
      provider: response.providers.join("+"), query: options.goal, resultCount: response.results.length,
      fallback: true, researchModel, ...funnelDetails(run),
    },
  };
}

const UNVERIFIED_NOTICE =
  "[Síntese não verificada — nenhuma Fonte lida: o subagente não leu nenhuma página com sucesso; a Síntese se apoia apenas em resultados de busca.]";

/** Núcleo de Research: subagente + Fallback cru. */
export async function runResearch(options: RunResearchOptions): Promise<ResearchResult> {
  const model = chooseResearchModel(options.modelRegistry, options.modelRef, options.parentModel);
  const researchModel = model ? `${model.provider}/${model.id}` : undefined;
  const choice = options.classifier ?? "auto";
  const classifier = typeof choice === "object" && "judgeResults" in choice
    ? choice
    : await detectClassifier(options.modelRegistry, choice);
  const run: ResearchRun = { options, funnel: emptyFunnel(classifier), searchWarnings: [], classifier, classifierCost: 0 };
  try {
    if (!model) throw new Error("Modelo de pesquisa indisponível; configure-o em /web-search.");
    const outcome = await runSubagent(run, model);
    const unverified = outcome.sourcesRead === 0;
    const text = unverified ? `${UNVERIFIED_NOTICE}\n\n${outcome.text}` : outcome.text;
    return {
      content: [{ type: "text", text }],
      details: {
        depth: options.depth, synthesized: true, researchModel,
        sourcesRead: outcome.sourcesRead, removedCitations: outcome.removedCitations,
        ...(unverified ? { unverified: true } : {}),
        ...funnelDetails(run),
      },
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return rawFallback(run, error, researchModel);
  }
}
