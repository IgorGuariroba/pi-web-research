/**
 * Roteiro de teste do núcleo de Research (reutilizável por todos os tickets).
 *
 * Dublês das fronteiras externas do núcleo:
 *   - startFakeLLM(script)      servidor OpenAI-compatible que roteiriza o subagente
 *   - createModelEnv(...)       ModelRegistry isolado apontando para o servidor falso
 *   - fakeProvider/failingProvider/emptyProvider   Providers de busca falsos
 *   - startPageServer(routes)   servidor HTTP local de páginas, exposto via porta `fetch`
 *   - setupResearch(...)        monta tudo e devolve `run(params)` chamando o núcleo real
 *
 * API documentada em ~/.cache/pi-web-research-notes/test-harness.md.
 */

import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runResearch } from "../research-runner.ts";
import { questionKeys, categoryLabels } from "../classifier.ts";

// --------------------------------------------------------------------------- //
// Servidor falso OpenAI-compatible
// --------------------------------------------------------------------------- //

/** Atalhos para montar turnos do roteiro. */
export const turn = {
  /** Resposta final em texto. */
  text: (text) => ({ text }),
  /** Uma ou mais chamadas de tool no mesmo turno: call("web_search", { query }) */
  tools: (...calls) => ({ tools: calls }),
  call: (name, args) => ({ name, args }),
  search: (query) => ({ tools: [{ name: "web_search", args: { query } }] }),
  fetch: (url) => ({ tools: [{ name: "fetch_url", args: { url } }] }),
  /** Erro HTTP do "LLM" (ex.: 400 → subagente falha sem retry). */
  error: (status = 400, message = "fake error") => ({ error: status, message }),
};

/**
 * script: array de turnos (consumidos em ordem, um por requisição ao /chat/completions)
 *         ou função (body, index, requests) => turno.
 * Turno: { text } | { tools: [{ name, args }] } | { error, message }.
 * Roteiro esgotado → responde erro 500 "roteiro esgotado".
 */
export async function startFakeLLM(script) {
  const requests = [];
  const server = createServer((req, res) => {
    if (!req.url?.includes("/chat/completions")) { res.writeHead(404).end(); return; }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const index = requests.length;
      requests.push(body);
      const step = typeof script === "function" ? script(body, index, requests) : script[index];
      if (!step) { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "roteiro esgotado" } })); return; }
      if (step.error) {
        res.writeHead(step.error, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: step.message ?? "fake error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        id: `fake-${index}`, object: "chat.completion.chunk", created: 0, model: body.model ?? "fake",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      if (step.tools) {
        res.write(chunk({
          role: "assistant",
          tool_calls: step.tools.map((call, i) => ({
            index: i, id: `call_${index}_${i}`, type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: step.text ?? "" }));
        res.write(chunk({}, "stop"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    /** Corpos JSON de cada requisição recebida. */
    requests,
    /** Conteúdos (texto) das mensagens role=tool enviadas ao LLM, na ordem. */
    toolResults() {
      const last = requests.at(-1);
      return (last?.messages ?? []).filter((m) => m.role === "tool").map((m) =>
        typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join(""));
    },
    /** Texto do primeiro prompt de usuário (prompt do subagente). */
    userPrompt() {
      const user = requests[0]?.messages?.find((m) => m.role === "user");
      if (!user) return "";
      return typeof user.content === "string" ? user.content : user.content.map((p) => p.text ?? "").join("");
    },
    /** Modelos usados em cada requisição. */
    models: () => requests.map((r) => r.model),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// --------------------------------------------------------------------------- //
// ModelRegistry isolado (provider dinâmico, como extensões registram)
// --------------------------------------------------------------------------- //

/**
 * models: ids dos modelos expostos pelo provider "fake-llm" (todos com chave).
 * Devolve { modelRegistry, model(id), cwd, agentDir, cleanup }.
 */
export async function createModelEnv({ baseUrl, models = ["fake-model"], provider = "fake-llm", classifiers = [] }) {
  const cwd = mkdtempSync(join(tmpdir(), "research-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "research-agent-"));
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  const defs = models.map((id) => ({
    provider, id, name: id, api: "openai-completions", baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32000,
  }));
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  runtime.registerProvider(provider, { name: "Fake LLM", baseUrl, apiKey: "sk-fake", api: "openai-completions", authHeader: true, models: defs });
  // Classificadores falsos: um provider por nome (sobrescreve o do catálogo neste runtime isolado).
  const byProvider = new Map();
  for (const c of classifiers) byProvider.set(c.provider, [...(byProvider.get(c.provider) ?? []), c]);
  for (const [name, list] of byProvider) {
    const api = `fake-clf-${name}`;
    runtime.registerProvider(name, {
      apiKey: "k", baseUrl: "http://127.0.0.1:1",
      models: list.map((c) => ({ type: "classifier", id: c.id, name: c.id, api, input: ["text"],
        cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000 })),
      classifiers: { [api]: { classify: async (m, ctx) => list.find((c) => c.id === m.id).classify(m, ctx) } },
    });
  }
  await runtime.refresh({ allowNetwork: false });
  const modelRegistry = new ModelRegistry(runtime);
  return {
    modelRegistry, cwd, agentDir,
    model: (id) => modelRegistry.find(provider, id),
    cleanup() {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

// --------------------------------------------------------------------------- //
// Providers falsos
// --------------------------------------------------------------------------- //

/** Resultado de busca curto: r("https://a.test/x", "Título", "resumo"). */
export const r = (url, title = url, summary = `Resumo de ${url}`) => ({ title, url, summary });

/**
 * results: array de SearchResult ou função (query, callIndex) => SearchResult[].
 * `provider.calls` registra as queries recebidas.
 */
export function fakeProvider(name, results = []) {
  const calls = [];
  return {
    name, calls,
    async search(query) {
      calls.push(query);
      const list = typeof results === "function" ? results(query, calls.length - 1) : results;
      return { provider: name, results: list, durationMs: 1, warnings: [], telemetry: { provider: name, durationMs: 1, warnings: [], providerMeta: {} } };
    },
  };
}

export function failingProvider(name, message = `${name} indisponível`) {
  const calls = [];
  return { name, calls, async search(query) { calls.push(query); throw new Error(message); } };
}

export const emptyProvider = (name) => fakeProvider(name, []);

// --------------------------------------------------------------------------- //
// Classificadores falsos
// --------------------------------------------------------------------------- //

/**
 * Classificador falso injetado direto no núcleo (interface Classifier, classifier.ts).
 * judge: (result, input) => { offTopic?: number, level?: "oficial"|"docs"|"blog"|"fórum"|"spam", category?: string }
 *        ou objeto { "<url>": { offTopic, level } }. Campos omitidos: offTopic 0, level "blog".
 * Opções: name (padrão "fake/classifier"), costUsd por chamada (padrão 0.001), fail (mensagem → rejeita).
 * `.calls` registra os inputs ({ goal, focus, query, results }) de cada chamada.
 */
export function fakeClassifier(judge = {}, { name = "fake/classifier", costUsd = 0.001, fail } = {}) {
  const calls = [];
  const judgeOne = typeof judge === "function" ? judge : (result) => judge[result.url] ?? {};
  return {
    name, calls,
    async judgeResults(input) {
      calls.push(input);
      if (fail) throw new Error(fail);
      const judgements = input.results.map((result) => ({ offTopic: 0, level: "blog", ...judgeOne(result, input) }));
      return { judgements, costUsd };
    },
  };
}

/**
 * Modelo classificador falso para o ModelRegistry (fronteira real do Pi).
 * judge: igual a fakeClassifier. Responde às perguntas montadas pelo adaptador
 * (chaves de questionKeys(i) em classifier.ts). `.calls` = ClassifierContext recebidos.
 * Uso: setupResearch({ registryClassifiers: [registryClassifier("openrouter", "typesafe/jev-1.14", judge)], classifier: "auto" })
 */
export function registryClassifier(provider, id, judge = {}, { costUsd = 0.000004, stopReason = "stop" } = {}) {
  const calls = [];
  const judgeOne = typeof judge === "function" ? judge : (result) => judge[result.url] ?? {};
  return {
    provider, id, calls,
    async classify(model, ctx) {
      calls.push(ctx);
      const answers = {};
      // Categoria (quando o adaptador manda Critério): resposta = rótulo do choice da Categoria julgada.
      const labelOf = new Map([...(ctx.state.criteria ? categoryLabels(ctx.state.criteria) : [])].map(([l, c]) => [c, l]));
      ctx.state.results.forEach((result, i) => {
        const { offTopic = 0, level = "blog", category = "outros" } = judgeOne(result);
        const keys = questionKeys(i);
        if (ctx.questions[keys.category]) {
          const choice = labelOf.get(category) ?? "outros";
          answers[keys.category] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
        }
        answers[keys.offTopic] = { type: "bool", probability: offTopic };
        const label = level === "fórum" ? "forum" : level;
        answers[keys.level] = { type: "choice", choice: label, probabilities: { [label]: 1 }, confidence: 1 };
      });
      return {
        api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(),
        ...(stopReason === "stop" ? {} : { errorMessage: "falha falsa" }),
        answers,
        usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100,
          cost: { input: costUsd, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd } },
      };
    },
  };
}

// --------------------------------------------------------------------------- //
// Servidor HTTP local de páginas (porta de fetch)
// --------------------------------------------------------------------------- //

/**
 * routes: { "<url absoluta>": resposta }. Resposta: string (HTML) |
 *   { status?, headers?, body?, contentType? }. URL não roteada → 404.
 * Devolve { fetch, requests, close }. `fetch(url, init)` tem a assinatura do
 * fetch global e redireciona qualquer host para o servidor local preservando a
 * URL original (headers Location são devolvidos como roteados, sem reescrita).
 */
export async function startPageServer(routes = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const original = req.headers["x-original-url"];
    requests.push(original);
    const route = routes[original];
    if (route === undefined) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
    const spec = typeof route === "string" ? { body: route } : route;
    const contentType = spec.contentType ?? "text/html; charset=utf-8";
    res.writeHead(spec.status ?? 200, { "content-type": contentType, ...(spec.headers ?? {}) });
    res.end(spec.body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const fetchPort = async (input, init = {}) => {
    const original = typeof input === "string" ? input : input.href ?? input.url;
    const headers = new Headers(init.headers ?? {});
    headers.set("x-original-url", original);
    return fetch(`http://127.0.0.1:${port}/`, { ...init, headers, redirect: "manual" });
  };
  return { fetch: fetchPort, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

// --------------------------------------------------------------------------- //
// Montagem completa
// --------------------------------------------------------------------------- //

/**
 * setupResearch({ script, providers, pages, models, modelRef, parentModelId, classifier, registryClassifiers })
 * classifier: Classifier (ex. fakeClassifier) | "auto" | "none" (padrão: "none", para não
 *   detectar classificadores reais do ambiente) | { provider, id }.
 * registryClassifiers: modelos classificadores falsos registrados no ModelRegistry
 *   (ver registryClassifier) — exercitam a detecção automática e o adaptador do Pi.
 * → { run(params, extra?), llm, pages, env, progress, cleanup }.
 * run chama o núcleo real (runResearch) com as dependências falsas.
 */
export async function setupResearch({
  script, providers = [], pages = {}, models, modelRef, parentModelId, classifier = "none", registryClassifiers,
} = {}) {
  const llm = await startFakeLLM(script);
  const env = await createModelEnv({ baseUrl: llm.baseUrl, models, classifiers: registryClassifiers });
  const pageServer = await startPageServer(pages);
  const progress = [];
  return {
    llm, env, pages: pageServer, progress, providers,
    run: (params, extra = {}) => runResearch({
      depth: "quick", ...params,
      providers, fetch: pageServer.fetch,
      modelRegistry: env.modelRegistry,
      modelRef,
      classifier,
      parentModel: parentModelId ? env.model(parentModelId) : undefined,
      cwd: env.cwd, agentDir: env.agentDir,
      onProgress: (m) => progress.push(m),
      ...extra,
    }),
    async cleanup() {
      await llm.close();
      await pageServer.close();
      env.cleanup();
    },
  };
}

/** Texto concatenado do resultado da tool. */
export const textOf = (result) => result.content.map((c) => c.text).join("\n");
