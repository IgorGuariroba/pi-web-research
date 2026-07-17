import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ModelRegistry,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import type { SearchEngine } from "./search-engine.ts";
import { fetchPage } from "./fetch-url.ts";
import { buildResearchPrompt, createResearchBudget, getResearchLimits, type ResearchDepth } from "./research.ts";

export interface RunResearchOptions {
  goal: string;
  focus?: string;
  depth: ResearchDepth;
  engine: SearchEngine;
  modelRegistry: ModelRegistry;
  modelRef?: { provider: string; id: string };
  cwd: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function textOfLastAssistant(messages: readonly any[]): string {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  return message?.content?.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n").trim() ?? "";
}

export async function runResearch(options: RunResearchOptions): Promise<string> {
  const { depth, engine, signal } = options;
  const budget = createResearchBudget(depth);
  const limits = getResearchLimits(depth);
  const model = options.modelRef
    ? options.modelRegistry.find(options.modelRef.provider, options.modelRef.id)
    : options.modelRegistry.getAvailable()[0];
  if (!model) throw new Error("Modelo de pesquisa indisponível; configure-o em /web-search.");

  const webSearchTool: ToolDefinition<any> = {
    name: "web_search", label: "Web Search",
    description: "Busca a web. Use queries específicas; prefira fontes primárias.",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, params, toolSignal) {
      if (!budget.consumeSearch()) return { content: [{ type: "text", text: "Orçamento de buscas esgotado. Produza a síntese final agora." }] };
      options.onProgress?.(`Buscando: ${params.query}`);
      const result = await engine.search(params.query, { timeoutMs: 60_000 }, toolSignal);
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
      const page = await fetchPage(params.url, toolSignal);
      return { content: [{ type: "text", text: `URL final: ${page.url}\n\n${page.text}` }] };
    },
  };

  const agentDir = `${homedir()}/.pi/agent`;
  const settingsManager = SettingsManager.create(options.cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: options.cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: "Você é um pesquisador web. Use apenas as tools disponíveis e entregue somente a síntese final solicitada, em português do Brasil.",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: options.cwd, agentDir, model, thinkingLevel: "low",
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
