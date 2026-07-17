// Categoria: TavilyProvider — retry+backoff, política de falha, contrato SearchResponse.
// Mock do fetch global; restaura no afterEach.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// O import precisa vir ANTES do mock do fetch (fetch é global).
const { TavilyProvider } = await import("../tavily-provider.ts");

const PROVIDER = "tavily";
const KEY = "tvly-test";

// ---- helpers de mock ----
const TAVILY_RESULT = { title: "A", url: "https://a.com", content: "snippet", score: 0.9 };
const TAVILY_RESPONSE = { results: [TAVILY_RESULT], response_time: "0.5" };

function ok(body = TAVILY_RESPONSE) {
  return new Response(JSON.stringify(body), { status: 200 });
}

function err(status, body) {
  return new Response(JSON.stringify(body || { error: `HTTP ${status}` }), { status });
}

function piiBlock(msg = "Query blocked, PII detected") {
  return new Response(JSON.stringify({ error: msg }), { status: 200 });
}

// ---- lifecycle ----
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// TODO: esses testes mockam fetch global. O node:test executa em paralelo por
// padrão — se outro teste usar fetch real ao mesmo tempo, colide. Em produção,
// usar undici MockAgent ou rodar com --test-concurrency=1. Para a extensão
// global (~/.pi/agent), concurrency=1 é aceitável (poucos testes).

// ---- TESTES ----

test("tavily: sucesso — mapeia content→summary, preenche source", async () => {
  globalThis.fetch = async () => ok();
  const p = new TavilyProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(r.provider, "tavily");
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].summary, "snippet");
  assert.equal(r.results[0].score, 0.9);
  assert.equal(r.results[0].source, "tavily");
  assert.equal(r.warnings.length, 0);
  assert.ok(r.durationMs >= 0);
});

test("tavily: 429 com Retry-After (segundos) → retry funciona (2 tentativas)", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return err(429, { error: "rate limited" });
    return ok();
  };
  const p = new TavilyProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(calls, 2);
  assert.equal(r.results.length, 1);
});

test("tavily: 429 sem Retry-After → backoff default, retry funciona", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 2) return err(429);
    return ok();
  };
  const p = new TavilyProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(calls, 2);
});

test("tavily: 3x 429 → throw após esgotar tentativas", async () => {
  globalThis.fetch = async () => err(429);
  const p = new TavilyProvider(KEY);
  await assert.rejects(
    () => p.search("q", {}),
    /tavily: HTTP 429 após 3 tentativas/,
  );
});

test("tavily: 401 → throw imediato (sem retry)", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return err(401); };
  const p = new TavilyProvider(KEY);
  await assert.rejects(() => p.search("q", {}), /tavily: HTTP 401/);
  assert.equal(calls, 1);
});

test("tavily: PII block → throw (erro determinístico)", async () => {
  globalThis.fetch = async () => piiBlock();
  const p = new TavilyProvider(KEY);
  await assert.rejects(() => p.search("q", {}), /PII/);
});

test("tavily: providerOptions não-vazio → throw", async () => {
  const p = new TavilyProvider(KEY);
  await assert.rejects(
    () => p.search("q", { providerOptions: { unknownField: 1 } }),
    /providerOptions inesperado/,
  );
});

test("tavily: providerOptions null/undefined → OK", async () => {
  globalThis.fetch = async () => ok();
  const p = new TavilyProvider(KEY);
  // null
  let r = await p.search("q", { providerOptions: null });
  assert.equal(r.results.length, 1);
  // undefined (campo ausente)
  r = await p.search("q", {});
  assert.equal(r.results.length, 1);
});

test("tavily: AbortSignal abortado → throw (determinístico)", async () => {
  // Mock verifica signal.aborted — node:fetch real faria o mesmo.
  globalThis.fetch = async (_url, init) => {
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return ok();
  };
  const ac = new AbortController();
  ac.abort();
  const p = new TavilyProvider(KEY);
  await assert.rejects(
    () => p.search("q", {}, ac.signal),
    /abortado ou timeout/,
  );
});

test("tavily: erros de rede → retry → sucesso", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return ok();
  };
  const p = new TavilyProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(calls, 2);
  assert.equal(r.results.length, 1);
});

test("tavily: erros de rede esgotados → throw", async () => {
  globalThis.fetch = async () => { throw new Error("ENOTFOUND"); };
  const p = new TavilyProvider(KEY);
  await assert.rejects(() => p.search("q", {}), /ENOTFOUND/);
});
