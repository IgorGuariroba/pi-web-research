/**
 * Web Research Extension — tool pública `research` com subagente isolado.
 *
 * O agente pai vê apenas `research`; o subagente SDK in-process recebe as tools
 * internas `web_search` e `fetch_url`. Providers: Tavily, Exa (HTTP) e Goose (CLI).
 * A tool é casca fina: monta as dependências e delega ao núcleo de Research
 * (research-runner.ts), que executa o subagente e o Fallback cru.
 *
 * Arquitetura:
 *   research(goal, focus, depth) → núcleo de Research → subagente → web_search(query)
 *     → Busca agregada (aggregate-search.ts: agregada | econômica) → WebSearchProvider[]
 *     ├─ TavilyProvider    (HTTP, retry/backoff via HttpSearchProvider base)
 *     ├─ ExaProvider       (HTTP, retry/backoff via HttpSearchProvider base)
 *     └─ GooseBuiltinProvider (CLI via goose-adapter.ts)
 *
 * Módulos:
 *   - search-types.ts       contrato público (neutro quanto a provider).
 *   - research-runner.ts    núcleo de Research (subagente + Fallback cru, deps injetadas).
 *   - classifier.ts         Classificador (Fora do tema + Nível) sobre o model registry do Pi.
 *   - state.ts              storage seguro (state.json, 0600).
 *   - resolve-provider.ts   lógica de resolução do provider ativo.
 *   - tavily-provider.ts    Tavily HTTP provider.
 *   - exa-provider.ts       Exa HTTP provider.
 *   - goose-provider.ts     Goose CLI provider.
 *   - goose-adapter.ts      parser do formato Goose (puro, testável).
 *   - http-search-provider.ts retry/backoff compartilhado.
 *
 * Env overrides: PI_GOOSE_PATH, PI_WEB_SEARCH_TIMEOUT_MS, PI_WEB_SEARCH_MAX_TURNS,
 *   TAVILY_API_KEY, EXA_API_KEY.
 * Testes: cd ~/.pi/agent/extensions/web-search.tests && node --test --experimental-strip-types *.test.mjs
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runResearch } from "./research-runner.ts";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WebSearchProvider } from "./search-types.ts";
import { initSecureStateFile, loadState, saveState, resolveKey as resolveKeyFromState, type WebSearchState } from "./state.ts";
import { resolveSearchProviders } from "./resolve-provider.ts";
import type { SearchMode } from "./aggregate-search.ts";

const describeClassifierChoice = (choice: WebSearchState["classifier"]) =>
  choice === undefined || choice === "auto" ? "automático" : choice === "none" ? "nenhum (só regras)" : `${choice.provider}/${choice.id}`;

const describeBlockedDomains = (domains: readonly string[] | undefined) =>
  domains?.length ? domains.join(", ") : "nenhum";

/** "https://www.Spam.com/x, foo.test" → ["spam.com", "foo.test"] (sem esquema, www., caminho; sem repetidos). */
const parseBlockedDomains = (typed: string) => [...new Set(
  typed.split(/[\s,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/^www\./, ""))
    .filter(Boolean),
)];

// Re-export para compatibilidade com testes e consumers externos.
export { GooseBuiltinProvider } from "./goose-provider.ts";
export { resolveActiveProvider } from "./resolve-provider.ts";

// --------------------------------------------------------------------------- //
// Extension
// --------------------------------------------------------------------------- //

export default function webSearchExtension(pi: ExtensionAPI) {
  // Inicializa storage seguro.
  const statePath = join(homedir(), ".pi", "agent", "extensions", "web-search", "state.json");
  initSecureStateFile(statePath);

  const state = loadState(statePath);
  let activeProviderOverride: string | undefined = state.activeProvider;

  // Providers da Busca agregada, resolvidos a cada chamada de research:
  // todos com chave (o ativo primeiro); Goose só sem nenhuma chave.
  const resolveProviders = (): WebSearchProvider[] => {
    const tavilyKey = resolveKeyFromState(statePath, "tavily");
    const exaKey = resolveKeyFromState(statePath, "exa");
    return resolveSearchProviders(activeProviderOverride, tavilyKey, exaKey, pi.exec);
  };

  // --------------------------------------------------------------------------- //
  // Comando TUI: /web-search
  //
  // Mostra seletor de provider (Tavily e Exa; Goose fora do menu) usando
  // SelectList. Permite colar chave via ctx.ui.custom com Input. Valida a
  // chave com search() de teste. 401 → avisa e não salva. Grava em
  // state.json e efetiva ao vivo. Em headless (hasUI false) → notifica.
  // --------------------------------------------------------------------------- //

  pi.registerCommand("web-search", {
    description: "Configurar provider de web search (Tavily / Exa)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui?.notify?.("Comando /web-search disponível apenas no modo TUI.", "info");
        return;
      }

      const { DynamicBorder } = await import("@earendil-works/pi-coding-agent");
      const { Container, Input, SelectItem, SelectList, Spacer, Text } = await import("@earendil-works/pi-tui");

      // Lê estado atual
      const tavilyKey = resolveKeyFromState(statePath, "tavily");
      const exaKey = resolveKeyFromState(statePath, "exa");

      // Passo 1: Seleção do provider via SelectList
      const currentProvider = activeProviderOverride ?? loadState(statePath).activeProvider;
      const items: SelectItem[] = [
        {
          value: "tavily",
          label: "Tavily",
          description: [
            currentProvider === "tavily" ? "✓ ativo" : null,
            tavilyKey ? "chave configurada" : "sem chave",
          ].filter(Boolean).join(" · "),
        },
        {
          value: "exa",
          label: "Exa",
          description: [
            currentProvider === "exa" ? "✓ ativo" : null,
            exaKey ? "chave configurada" : "sem chave",
          ].filter(Boolean).join(" · "),
        },
        {
          value: "mode",
          label: "Modo de busca",
          description: `atual: ${loadState(statePath).searchMode ?? "agregada"}`,
        },
        {
          value: "classifier",
          label: "Classificador",
          description: `atual: ${describeClassifierChoice(loadState(statePath).classifier)}`,
        },
        {
          value: "blocked",
          label: "Domínios bloqueados",
          description: `atual: ${describeBlockedDomains(loadState(statePath).blockedDomains)}`,
        },
      ];

      const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold("Web Search — Provider")), 1, 0));
        container.addChild(new Spacer(1));

        const selectList = new SelectList(items, items.length, {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        selectList.onSelect = (item: SelectItem) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("dim", "↑↓ navegar • enter selecionar • esc cancelar"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => { selectList.handleInput(data); tui.requestRender(); },
        };
      });

      if (!selected) return; // cancelou

      if (selected === "mode") {
        const options = [
          "agregada — todos os Providers com chave em paralelo (padrão)",
          "econômica — um Provider por vez; o próximo só em erro ou vazio",
        ];
        const choice = await ctx.ui.select("Modo de busca", options);
        if (!choice) return;
        const mode: SearchMode = choice.startsWith("econômica") ? "econômica" : "agregada";
        const latest = loadState(statePath);
        latest.searchMode = mode;
        saveState(statePath, latest);
        ctx.ui.notify(`Modo de busca: ${mode} ✓`, "info");
        return;
      }

      if (selected === "classifier") {
        const available = await ctx.modelRegistry.getAvailableOfType("classifier");
        const AUTO = "automático — detecta pela lista de preferência (Jev, depois Clef)";
        const NONE = "nenhum (só regras)";
        const options = [AUTO, NONE, ...available.map((m) => `${m.provider}/${m.id}`)];
        const choice = await ctx.ui.select("Classificador", options);
        if (!choice) return;
        const picked = available.find((m) => `${m.provider}/${m.id}` === choice);
        const latest = loadState(statePath);
        latest.classifier = choice === AUTO ? "auto" : choice === NONE ? "none" : { provider: picked!.provider, id: picked!.id };
        saveState(statePath, latest);
        ctx.ui.notify(`Classificador: ${describeClassifierChoice(latest.classifier)} ✓`, "info");
        return;
      }

      if (selected === "blocked") {
        const current = loadState(statePath).blockedDomains ?? [];
        const typed = await ctx.ui.input(
          `Domínios bloqueados (além da lista fixa de spam), separados por vírgula; a lista digitada substitui a atual, vazio limpa. Atual: ${describeBlockedDomains(current)}`,
          current.length ? current.join(", ") : "ex.: fazenda-de-conteudo.com, spam.example",
        );
        if (typed === undefined) return;
        const latest = loadState(statePath);
        latest.blockedDomains = parseBlockedDomains(typed);
        saveState(statePath, latest);
        ctx.ui.notify(`Domínios bloqueados: ${describeBlockedDomains(latest.blockedDomains)} ✓`, "info");
        return;
      }

      const providerName = selected;
      let apiKey = providerName === "tavily" ? tavilyKey : exaKey;

      // Passo 2: Se não tem chave, pede via Input
      if (!apiKey) {
        const envName = providerName === "tavily" ? "TAVILY_API_KEY" : "EXA_API_KEY";
        apiKey = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold(`Cole a chave ${envName}:`)), 1, 1));
          container.addChild(new Spacer(1));

          const input = new Input();
          input.onSubmit = (value: string) => done(value || null);
          input.onEscape = () => done(null);
          container.addChild(input);
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", "enter confirmar • esc cancelar"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => { input.handleInput(data); tui.requestRender(); },
          };
        });

        if (!apiKey?.trim()) {
          ctx.ui.notify("Operação cancelada — chave vazia.", "info");
          return;
        }
        apiKey = apiKey.trim();
      }

      // Passo 3: Valida a chave com um search() de teste
      ctx.ui.notify(`Validando chave ${providerName}...`, "info");
      let testProvider;
      if (providerName === "tavily") {
        const { TavilyProvider } = await import("./tavily-provider.ts");
        testProvider = new TavilyProvider(apiKey);
      } else {
        const { ExaProvider } = await import("./exa-provider.ts");
        testProvider = new ExaProvider(apiKey);
      }

      try {
        await testProvider.search("test validation query", { timeoutMs: 15_000 });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes("401") || msg.includes("Invalid API key") || msg.includes("Unauthorized")) {
          ctx.ui.notify(`Chave inválida (${providerName}): ${msg}`, "error");
          return; // Não salva
        }
        // Outros erros (rede, timeout) — avisa mas permite salvar
        ctx.ui.notify(`Aviso: validação falhou (pode ser temporário): ${msg}`, "warn");
      }

      // Passo 4: Salva em state.json
      const updatedState = loadState(statePath);
      updatedState.activeProvider = providerName;
      if (!updatedState.keys) updatedState.keys = {};
      updatedState.keys[providerName as "tavily" | "exa"] = apiKey;
      saveState(statePath, updatedState);

      // Efetiva ao vivo reescrevendo o override em memória
      activeProviderOverride = providerName;

      ctx.ui.notify(`Provider ativo: ${providerName} ✓`, "success");

      const models = ctx.modelRegistry.getAvailable();
      if (models.length === 0) {
        ctx.ui.notify("Nenhum modelo disponível para o subagente.", "warn");
        return;
      }
      const modelItems: SelectItem[] = models.map((model) => ({
        value: `${model.provider}\u0000${model.id}`,
        label: model.name ?? model.id,
        description: `${model.provider}/${model.id}`,
      }));
      const selectedModel = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const list = new SelectList(modelItems, Math.min(modelItems.length, 12), {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        list.onSelect = (item: SelectItem) => done(item.value);
        list.onCancel = () => done(null);
        return { render: (w: number) => list.render(w), invalidate: () => list.invalidate(), handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); } };
      });
      if (selectedModel) {
        const [provider, id] = selectedModel.split("\u0000");
        const latest = loadState(statePath);
        latest.researchModel = { provider, id };
        saveState(statePath, latest);
        ctx.ui.notify(`Modelo de pesquisa: ${provider}/${id} ✓`, "success");
      }
    },
  });

  pi.registerTool({
    name: "research",
    label: "Research",
    description: "Delegue pesquisa web a um subagente isolado. Use quick para fatos pontuais e deep para investigação multi-fonte.",
    promptSnippet: "Pesquisa web isolada; retorna somente síntese e fontes",
    promptGuidelines: [
      "Use research para fatos atuais, documentação externa ou conhecimento fora do repositório.",
      "Passe em focus exatamente o que importa para evitar trazer ruído ao contexto.",
      "Use depth=quick por padrão; use deep apenas quando múltiplas buscas/fontes forem necessárias.",
      "Passe criteria quando o tipo de fonte importa (ex.: relatos de produção, benchmarks, docs oficiais, ou para descartar marketing): 2 a 8 Categorias em ordem de prioridade, ao menos uma sem discard. Omita em pesquisas simples.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "O que deve ser descoberto; não uma query literal." }),
      focus: Type.Optional(Type.String({ description: "O que interessa ao agente pai ou formato desejado." })),
      depth: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("deep")], { default: "quick" })),
      criteria: Type.Optional(Type.Array(Type.Object({
        category: Type.String({ description: "Nome curto da Categoria de fonte, ex. relato-producao." }),
        description: Type.String({ description: "Que tipo de fonte pertence a esta Categoria." }),
        discard: Type.Optional(Type.Boolean({ description: "true = resultados desta Categoria são descartados." })),
      }), {
        minItems: 2, maxItems: 8,
        description: "Critério opcional: 2 a 8 Categorias ordenadas por prioridade (a primeira é a mais importante); ao menos uma sem discard.",
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const state = loadState(statePath);
      return runResearch({
        goal: params.goal, focus: params.focus, depth: params.depth ?? "quick", criteria: params.criteria,
        providers: resolveProviders(), searchMode: state.searchMode ?? "agregada",
        blockedDomains: state.blockedDomains, classifier: state.classifier ?? "auto",
        modelRegistry: ctx.modelRegistry, modelRef: state.researchModel, parentModel: ctx.model,
        cwd: ctx.cwd, signal,
        onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: {} }),
      });
    },
  });
}
