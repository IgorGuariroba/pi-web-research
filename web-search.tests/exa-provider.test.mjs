// Categoria: ExaProvider — retry+backoff, política de falha, mapeamento SearchResult.
// Mock do fetch global; restaura no afterEach.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { ExaProvider } from "../exa-provider.ts";

const PROVIDER = "exa";
const KEY = "exa-test";

// ---- helpers de mock ----

// Resposta da API Exa (formato real verificado contra docs)
const EXA_RESULT = {
  title: "Exa AI Search",
  url: "https://exa.ai",
  id: "abc123",
  publishedDate: "2025-01-15T00:00:00.000Z",
  score: 0.95,
  highlightScores: [0.92],
  highlights: ["Exa is a search API built for AI applications"],
};

const EXA_RESPONSE = { results: [EXA_RESULT] };

function ok(body = EXA_RESPONSE) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function err(status, body) {
  return new Response(JSON.stringify(body || { error: `HTTP ${status}` }), { status });
}

// ---- lifecycle ----
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// ---- TESTES ----

test("exa: sucesso — mapeia highlights[0]→summary, publishedDate→publishedAt, highlightScores[0]→score", async () => {
  globalThis.fetch = async () => ok();
  const p = new ExaProvider(KEY);
  const r = await p.search("test query", {});
  assert.equal(r.provider, "exa");
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].summary, "Exa is a search API built for AI applications");
  assert.equal(r.results[0].score, 0.92);
  assert.equal(r.results[0].source, "exa");
  assert.equal(r.results[0].title, "Exa AI Search");
  assert.equal(r.results[0].url, "https://exa.ai");
  // publishedAt deve ser Date
  const pubAt = r.results[0].publishedAt;
  assert.ok(pubAt instanceof Date, "publishedAt deve ser Date");
  assert.equal(pubAt.toISOString(), "2025-01-15T00:00:00.000Z");
  assert.equal(r.warnings.length, 0);
  assert.ok(r.durationMs >= 0);
});

test("exa: sucesso — múltiplos resultados preservam ordem", async () => {
  const body = {
    results: [
      { title: "A", url: "https://a.com", highlights: ["sumA"], highlightScores: [0.8] },
      { title: "B", url: "https://b.com", highlights: ["sumB"], highlightScores: [0.9] },
    ],
  };
  globalThis.fetch = async () => ok(body);
  const p = new ExaProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].title, "A");
  assert.equal(r.results[1].title, "B");
});

test("exa: resultado sem highlights → summary vazio", async () => {
  const body = { results: [{ title: "X", url: "https://x.com" }] };
  globalThis.fetch = async () => ok(body);
  const p = new ExaProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].summary, "");
  assert.equal(r.results[0].score, undefined);
});

test("exa: 401 → throw imediato (sem retry)", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return err(401, { error: "Invalid API key" }); };
  const p = new ExaProvider(KEY);
  await assert.rejects(() => p.search("q", {}), /exa: Invalid API key/);
  assert.equal(calls, 1);
});

test("exa: 403 → throw imediato (sem retry)", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return err(403); };
  const p = new ExaProvider(KEY);
  await assert.rejects(() => p.search("q", {}), /exa: HTTP 403/);
  assert.equal(calls, 1);
});

test("exa: 429 com Retry-After (segundos) → retry funciona (2 tentativas)", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return err(429, { error: "rate limited" }, { headers: { "Retry-After": "1" } });
    return ok();
  };
  // Precisamos passar header no mock
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "Retry-After": "0" },
      });
    }
    return ok();
  };
  calls = 0;
  const p = new ExaProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(calls, 2);
  assert.equal(r.results.length, 1);
});

test("exa: 429 sem Retry-After → backoff default, retry funciona", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 2) return err(429);
    return ok();
  };
  const p = new ExaProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(calls, 2);
});

test("exa: 3x 429 → throw após esgotar tentativas", async () => {
  globalThis.fetch = async () => err(429);
  const p = new ExaProvider(KEY);
  await assert.rejects(
    () => p.search("q", {}),
    /exa: HTTP 429 após 3 tentativas/,
  );
});

test("exa: 5xx → retry com backoff", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return err(502);
    return ok();
  };
  const p = new ExaProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(calls, 2);
});

test("exa: erros de rede → retry → sucesso", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return ok();
  };
  const p = new ExaProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(calls, 2);
  assert.equal(r.results.length, 1);
});

test("exa: erros de rede esgotados → throw", async () => {
  globalThis.fetch = async () => { throw new Error("ENOTFOUND"); };
  const p = new ExaProvider(KEY);
  await assert.rejects(() => p.search("q", {}), /ENOTFOUND/);
});

test("exa: AbortSignal abortado → throw (determinístico)", async () => {
  globalThis.fetch = async (_url, init) => {
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return ok();
  };
  const ac = new AbortController();
  ac.abort();
  const p = new ExaProvider(KEY);
  await assert.rejects(
    () => p.search("q", {}, ac.signal),
    /abortado ou timeout/,
  );
});

test("exa: providerOptions vazio → OK", async () => {
  globalThis.fetch = async () => ok();
  const p = new ExaProvider(KEY);
  const r = await p.search("q", {});
  assert.equal(r.results.length, 1);
});

test("exa: request usa header x-api-key (não Bearer)", async () => {
  let capturedHeaders;
  globalThis.fetch = async (_url, init) => {
    capturedHeaders = init?.headers;
    return ok();
  };
  const p = new ExaProvider(KEY);
  await p.search("q", {});
  assert.equal(capturedHeaders?.["x-api-key"], KEY);
  assert.ok(!capturedHeaders?.["Authorization"], "não deve usar Authorization/Bearer");
});

test("exa: request body contém type:'auto', numResults:10, contents.highlights", async () => {
  let capturedBody;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init?.body);
    return ok();
  };
  const p = new ExaProvider(KEY);
  await p.search("my query", {});
  assert.equal(capturedBody.query, "my query");
  assert.equal(capturedBody.type, "auto");
  assert.equal(capturedBody.numResults, 10);
  assert.equal(capturedBody.contents.highlights.query, "my query");
  assert.equal(capturedBody.contents.highlights.maxCharacters, 1000);
  assert.equal(capturedBody.text, undefined, "não deve usar text");
});
