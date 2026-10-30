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
import type { SearchResponse, WebSearchProvider } from "./search-types.ts";
import { fetchPage, UnsupportedPdfError, type HttpFetch } from "./fetch-url.ts";
import { focusedExtract } from "./focused-extract.ts";
import { buildResearchPrompt, createResearchBudget, getResearchLimits, type ResearchDepth } from "./research.ts";

type Model = NonNullable<ReturnType<ModelRegistry["find"]>>;

export interface RunResearchOptions {
  goal: string;
  focus?: string;
  depth: ResearchDepth;
  /** Providers de busca disponíveis, em ordem de preferência. */
  providers: readonly WebSearchProvider[];
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

async function search(providers: readonly WebSearchProvider[], query: string, signal?: AbortSignal): Promise<SearchResponse> {
  const provider = providers[0];
  if (!provider) throw new Error("Nenhum Provider de busca disponível.");
  return provider.search(query, { timeoutMs: 60_000 }, signal);
}

async function runSubagent(options: RunResearchOptions, model: Model): Promise<string> {
  const { depth, signal } = options;
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
      const result = await search(options.providers, params.query, toolSignal);
      const text = result.results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.summary}`).join("\n\n") || "Sem resultados.";
      return { content: [{ type: "text", text }] };
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
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.prompt(buildResearchPrompt(options.goal, options.focus, depth), { expandPromptTemplates: false, source: "extension" }),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            void session.abort();
            reject(new Error("Pesquisa excedeu o timeout."));
          }, limits.timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Pesquisa cancelada.");
    const answer = textOfLastAssistant(session.messages);
    if (!answer) throw new Error("Subagente não produziu uma síntese.");
    return answer;
  } finally {
    signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}

async function rawFallback(options: RunResearchOptions, error: unknown, researchModel: string | undefined): Promise<ResearchResult> {
  options.onProgress?.("Subagente falhou; buscando fallback sem síntese…");
  const response = await search(options.providers, options.goal, options.signal);
  const meta = response.telemetry.providerMeta as Record<string, unknown> | undefined;
  const formatted = response.results.length
    ? response.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.summary}`).join("\n\n")
    : (meta?.rawAssistantText as string) || "research: sem resultados.";
  const truncation = truncateHead(formatted, { maxLines: Number.MAX_SAFE_INTEGER });
  const notice = truncation.truncated ? `\n\n[${formatSize(DEFAULT_MAX_BYTES)} limit reached]` : "";
  return {
    content: [{ type: "text", text: `[Fallback sem síntese — o subagente falhou: ${error instanceof Error ? error.message : String(error)}]\n\n${truncation.content}${notice}` }],
    details: { provider: response.provider, query: options.goal, resultCount: response.results.length, fallback: true, researchModel },
  };
}

/** Núcleo de Research: subagente + Fallback cru. */
export async function runResearch(options: RunResearchOptions): Promise<ResearchResult> {
  const model = chooseResearchModel(options.modelRegistry, options.modelRef, options.parentModel);
  const researchModel = model ? `${model.provider}/${model.id}` : undefined;
  try {
    if (!model) throw new Error("Modelo de pesquisa indisponível; configure-o em /web-search.");
    const synthesis = await runSubagent(options, model);
    return { content: [{ type: "text", text: synthesis }], details: { depth: options.depth, synthesized: true, researchModel } };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return rawFallback(options, error, researchModel);
  }
}
