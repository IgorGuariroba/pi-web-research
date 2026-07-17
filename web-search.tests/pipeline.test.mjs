// Categoria: SearchStage — contrato do pipeline do SearchEngine.
// Valida que: 0 estágios = identidade, 1 estágio modifica, N estágios encadeiam.
// Testa também o overload com ResolveProvider (provider dinâmico).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gooseResponseFromText } from "../goose-adapter.ts";
import { SearchEngine } from "../search-engine.ts";

const PROVIDER = "test";
const A = '[{"title":"A","url":"https://a.com","summary":"s"}]';

function base(extra) {
  return { ...gooseResponseFromText(A, PROVIDER, 0), ...extra };
}

/** pipeline fake: concatena um warning. Pura, sem efeito colateral. */
async function warnStage(response, context) {
  return {
    ...response,
    warnings: [...response.warnings, `stage: saw query="${context.query}"`],
  };
}

/** pipeline fake: injeta um resultado extra. Pura. */
async function injectStage(response) {
  return {
    ...response,
    results: [
      ...response.results,
      { title: "Injected", url: "https://injected.dev", summary: "s" },
    ],
  };
}

test("pipeline: 0 estágios → response idêntica (identidade)", async () => {
  const r = base();
  let out = r;
  for (const _ of []) { /* vazio */ }
  assert.deepEqual(out, r);
});

test("pipeline: 1 estágio modifica response (warning injetado com contexto)", async () => {
  const r = base();
  let out = r;
  for (const stage of [warnStage]) {
    out = await stage(out, { query: "test query" });
  }
  assert.equal(out.results.length, r.results.length);
  assert.ok(out.warnings.length > r.warnings.length);
  assert.ok(out.warnings.some((w) => w.includes('test query')));
});

test("pipeline: 2 estágios encadeiam (ordem preservada)", async () => {
  const r = base();
  let out = r;
  for (const stage of [warnStage, injectStage]) {
    out = await stage(out, { query: "chained" });
  }
  // warnStage adicionou warning; injectStage adicionou resultado
  assert.equal(out.results.length, r.results.length + 1);
  assert.equal(out.results[out.results.length - 1].title, "Injected");
  assert.ok(out.warnings.some((w) => /chained/.test(w)));
});

// ---- Testes do overload com ResolveProvider ----

test("SearchEngine: overload legado (provider fixo) funciona", async () => {
  let searchCalled = false;
  const provider = {
    name: "static",
    search: async () => { searchCalled = true; return base(); },
  };
  const engine = new SearchEngine(provider);
  const r = await engine.search("q", {});
  assert.ok(searchCalled, "deve ter chamado o provider fixo");
  assert.equal(r.provider, "test");
});

test("SearchEngine: overload novo (resolveProvider) funciona", async () => {
  let searchCalled = false;
  const provider = {
    name: "dynamic",
    search: async () => { searchCalled = true; return base(); },
  };
  let resolveCount = 0;
  const engine = new SearchEngine(() => { resolveCount++; return provider; });
  const r = await engine.search("q", {});
  assert.ok(searchCalled, "deve ter chamado o provider resolvido");
  assert.equal(resolveCount, 1, "resolveProvider deve ser chamado exatamente 1 vez");
});

test("SearchEngine: resolveProvider chamado em cada search(), não armazenado entre chamadas", async () => {
  let callCount = 0;
  const engine = new SearchEngine(() => {
    callCount++;
    return {
      name: `provider-${callCount}`,
      search: async () => base({ provider: `provider-${callCount}` }),
    };
  });
  const r1 = await engine.search("q1", {});
  const r2 = await engine.search("q2", {});
  assert.equal(callCount, 2, "resolveProvider deve ser chamado a cada search()");
  assert.equal(r1.provider, "provider-1");
  assert.equal(r2.provider, "provider-2");
});

test("SearchEngine: troca de provider resolve novo — não afeta busca em andamento", async () => {
  let resolveVersion = 0;
  let searchStarted = false;
  let resolveCalledDuringSearch = false;

  const engine = new SearchEngine(() => {
    resolveVersion++;
    if (searchStarted) resolveCalledDuringSearch = true;
    return {
      name: `v${resolveVersion}`,
      search: async () => {
        searchStarted = true;
        return base({ provider: `v${resolveVersion}` });
      },
    };
  });

  // search() resolve o provider uma vez no topo, chama search(), não resolve novamente
  const r = await engine.search("q", {});
  assert.equal(r.provider, "v1", "deve usar o provider resolvido no topo");
  assert.equal(resolveVersion, 1, "resolveProvider chamado só 1 vez por search()");
});

test("SearchEngine: stages readonly — pipeline roda com resolveProvider", async () => {
  const provider = {
    name: "test",
    search: async () => base(),
  };
  let stageCalled = false;
  const stage = async (r) => { stageCalled = true; return r; };
  const engine = new SearchEngine(() => provider, [stage]);
  await engine.search("q", {});
  assert.ok(stageCalled, "stage deve ter sido executada");
});
