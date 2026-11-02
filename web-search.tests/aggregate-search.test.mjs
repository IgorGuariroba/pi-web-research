// Busca agregada (ticket #3), exercitada pelo núcleo de Research.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, failingProvider, emptyProvider, fakeClassifier, r, textOf } from "./research-harness.mjs";
import { gooseResponseFromText } from "../goose-adapter.ts";
import { search } from "../curation.ts";
import { emptyFunnel } from "../research-run.ts";
import { AllProvidersFailedError } from "../aggregate-search.ts";

const modelRef = { provider: "fake-llm", id: "fake-model" };

async function withResearch(setup, fn) {
  const h = await setupResearch({ modelRef, ...setup });
  try { return await fn(h); } finally { await h.cleanup(); }
}

test("agregada: dois Providers sobrepostos viram lista única com Concordância", () =>
  withResearch({
    providers: [
      fakeProvider("tavily", [r("https://a.test/doc", "Doc A", "curto"), r("https://b.test/x", "Só Tavily", "b")]),
      fakeProvider("exa", [r("https://a.test/doc", "Doc A", "resumo bem mais longo do exa"), r("https://c.test/y", "Só Exa", "c")]),
    ],
    script: [turn.search("q"), turn.text("fim")],
  }, async (h) => {
    const result = await h.run({ goal: "G" });
    const [seen] = h.llm.toolResults();
    assert.equal(seen.match(/https:\/\/a\.test\/doc/g).length, 1);
    assert.match(seen, /Doc A \[blog · tavily\+exa\]\nhttps:\/\/a\.test\/doc\nresumo bem mais longo do exa/);
    assert.match(seen, /Só Tavily \[blog · tavily\]/);
    assert.match(seen, /Só Exa \[blog · exa\]/);
    assert.deepEqual(result.details.funnel, { found: 4, unique: 3, duplicates: 1, spam: 0 });
    assert.equal(h.progress.includes("4 resultados → 3 únicos → 3 após descarte (0 spam)"), true);
  }));

test("agregada: variações de URL (www, fragmento, utm, ref, fbclid, barra, http/https) são unificadas", () =>
  withResearch({
    providers: [
      fakeProvider("tavily", [
        r("https://www.Site.test/page/?utm_source=x&id=7#sec"),
        r("http://site.test/page?id=7&ref=hn"),
      ]),
      fakeProvider("exa", [r("https://site.test/page?fbclid=abc&id=7&utm_medium=y"), r("https://site.test/page?id=8")]),
    ],
    script: [turn.search("q"), turn.text("fim")],
  }, async (h) => {
    const result = await h.run({ goal: "G" });
    const [seen] = h.llm.toolResults();
    assert.equal((seen.match(/^\d+\. /gm) ?? []).length, 2);
    assert.match(seen, /\[blog · tavily\+exa\]/);
    assert.deepEqual(result.details.funnel, { found: 4, unique: 2, duplicates: 2, spam: 0 });
  }));

test("agregada: um Provider falhando entrega o outro com aviso", () =>
  withResearch({
    providers: [failingProvider("tavily", "tavily caiu"), fakeProvider("exa", [r("https://e.test/1", "E1")])],
    script: [turn.search("q"), turn.text("fim")],
  }, async (h) => {
    const result = await h.run({ goal: "G" });
    const [seen] = h.llm.toolResults();
    assert.match(seen, /E1 \[blog · exa\]/);
    assert.match(seen, /Aviso: tavily falhou: tavily caiu/);
    assert.equal(result.details.synthesized, true);
    assert.deepEqual(result.details.searchWarnings, ["tavily falhou: tavily caiu"]);
  }));

test("agregada: todos os Providers falhando vira erro para o subagente", () =>
  withResearch({
    providers: [failingProvider("tavily", "t off"), failingProvider("exa", "e off")],
    script: [turn.search("q"), turn.text("fim")],
  }, async (h) => {
    const result = await h.run({ goal: "G" });
    const [seen] = h.llm.toolResults();
    assert.match(seen, /Todos os Providers falharam/);
    assert.match(seen, /t off/);
    assert.match(seen, /e off/);
    assert.equal(result.details.synthesized, true);
  }));

// Caso real: chaves Exa/Tavily inválidas (401) em todas as buscas; o Agente pai
// recebia só "Síntese não verificada", sem saber que a busca estava fora do ar.
test("agregada: falha de todos os Providers chega ao Agente pai no topo da Síntese e nos details", () =>
  withResearch({
    providers: [failingProvider("tavily", "tavily: HTTP 401"), failingProvider("exa", "exa: Invalid API key")],
    script: [turn.search("q1"), turn.search("q2"), turn.text("fim")],
  }, async (h) => {
    const result = await h.run({ goal: "G" });
    const text = textOf(result);
    assert.match(text, /^\[Busca indisponível — todos os Providers falharam em 2 de 2 buscas: tavily falhou: tavily: HTTP 401; exa falhou: exa: Invalid API key\. Verifique as chaves em \/web-search\.\]/);
    assert.match(text, /fim$/);
    assert.deepEqual(result.details.searchWarnings, [
      "tavily falhou: tavily: HTTP 401", "exa falhou: exa: Invalid API key",
      "tavily falhou: tavily: HTTP 401", "exa falhou: exa: Invalid API key",
    ]);
    assert.deepEqual(result.details.failedSearches, 2);
  }));

test("agregada: falha total em só parte das buscas também é avisada, com a contagem", () =>
  withResearch({
    providers: [{ name: "tavily", calls: [], async search(q) { this.calls.push(q); if (this.calls.length === 1) throw new Error("timeout"); return { provider: "tavily", results: [r("https://a.test/1", "A")], durationMs: 1, warnings: [] }; } }],
    script: [turn.search("q1"), turn.search("q2"), turn.text("fim")],
  }, async (h) => {
    const result = await h.run({ goal: "G" });
    assert.match(textOf(result), /^\[Busca indisponível — todos os Providers falharam em 1 de 2 buscas: tavily falhou: timeout\./);
    assert.equal(result.details.failedSearches, 1);
  }));

test("agregada: sem falha total não há aviso de Busca indisponível", () =>
  withResearch({
    providers: [fakeProvider("exa", [r("https://a.test/1", "A")]), failingProvider("tavily", "t off")],
    script: [turn.search("q"), turn.text("fim")],
  }, async (h) => {
    const result = await h.run({ goal: "G" });
    assert.doesNotMatch(textOf(result), /Busca indisponível/);
    assert.equal(result.details.failedSearches, undefined);
  }));

test("agregada: aviso de Busca indisponível não inclui falhas parciais nem falhas do classificador", () =>
  withResearch({
    providers: [
      {
        name: "exa",
        calls: [],
        async search(q) {
          this.calls.push(q);
          if (this.calls.length === 1) return { provider: "exa", results: [r("https://a.test/1", "A")], durationMs: 1, warnings: [] };
          throw new Error("exa timeout");
        },
      },
      failingProvider("tavily", "tavily timeout"),
    ],
    classifier: {
      name: "falho",
      async judgeResults() { throw new Error("cota esgotada"); },
    },
    script: [turn.search("q1"), turn.search("q2"), turn.text("fim")],
  }, async (h) => {
    const result = await h.run({ goal: "G" });
    const text = textOf(result);
    assert.match(text, /^\[Busca indisponível — todos os Providers falharam em 1 de 2 buscas: exa falhou: exa timeout; tavily falhou: tavily timeout\. Verifique as chaves em \/web-search\.\]/);
    assert.doesNotMatch(text, /cota esgotada/);
    assert.equal(result.details.failedSearches, 1);
    assert.ok(result.details.searchWarnings.some((w) => /cota esgotada/.test(w)));
    assert.ok(result.details.searchWarnings.some((w) => /tavily timeout/.test(w)));
  }));

test("curation: busca cancelada por signal não conta em searches; sucesso e outage contam", async () => {
  const ac = new AbortController();
  ac.abort();
  const run = {
    options: { providers: [fakeProvider("tavily", [])], goal: "G" },
    funnel: emptyFunnel(),
    searches: 0,
    failedSearches: 0,
    searchWarnings: [],
    outageReasons: [],
  };

  await assert.rejects(() => search(run, "cancelada", ac.signal));
  assert.equal(run.searches, 0);
  assert.equal(run.failedSearches, 0);

  const runSuccess = {
    options: { providers: [fakeProvider("tavily", [r("https://a.test/1", "A")])], goal: "G" },
    funnel: emptyFunnel(),
    searches: 0,
    failedSearches: 0,
    searchWarnings: [],
    outageReasons: [],
  };
  await search(runSuccess, "ok");
  assert.equal(runSuccess.searches, 1);
  assert.equal(runSuccess.failedSearches, 0);

  const runFail = {
    options: { providers: [failingProvider("tavily", "queda total")], goal: "G" },
    funnel: emptyFunnel(),
    searches: 0,
    failedSearches: 0,
    searchWarnings: [],
    outageReasons: [],
  };
  await assert.rejects(() => search(runFail, "falha"), (err) => err instanceof AllProvidersFailedError);
  assert.equal(runFail.searches, 1);
  assert.equal(runFail.failedSearches, 1);
  assert.deepEqual(runFail.outageReasons, ["tavily falhou: queda total"]);
});

test("agregada: Goose só entra sem nenhum Provider com chave", async () => {
  const goose = fakeProvider("goose:computercontroller", [r("https://g.test/1", "G1")]);
  const tavily = fakeProvider("tavily", [r("https://t.test/1", "T1")]);
  await withResearch({ providers: [tavily, goose], script: [turn.search("q"), turn.text("fim")] }, async (h) => {
    await h.run({ goal: "G" });
    assert.deepEqual(goose.calls, []);
    assert.deepEqual(tavily.calls, ["q"]);
  });
  const soloGoose = fakeProvider("goose:computercontroller", [r("https://g.test/1", "G1")]);
  await withResearch({ providers: [soloGoose], script: [turn.search("q"), turn.text("fim")] }, async (h) => {
    await h.run({ goal: "G" });
    assert.deepEqual(soloGoose.calls, ["q"]);
    assert.match(h.llm.toolResults()[0], /G1/);
  });
});

test("agregada: consome uma única busca do orçamento", () => {
  const tavily = fakeProvider("tavily", (q) => [r(`https://t.test/${q}`)]);
  const exa = fakeProvider("exa", (q) => [r(`https://e.test/${q}`)]);
  return withResearch({
    providers: [tavily, exa],
    script: [turn.search("q0"), turn.search("q1"), turn.search("q2"), turn.search("q3"), turn.text("fim")],
  }, async (h) => {
    await h.run({ goal: "G", depth: "quick" });
    assert.equal(tavily.calls.length, 3);
    assert.equal(exa.calls.length, 3);
    assert.match(h.llm.toolResults()[3], /Orçamento de buscas esgotado/);
  });
});

test("econômica: um Provider por vez, passando ao próximo só em erro ou vazio", async () => {
  const tavily = fakeProvider("tavily", [r("https://t.test/1", "T1")]);
  const exa = fakeProvider("exa", [r("https://e.test/1", "E1")]);
  await withResearch({ providers: [tavily, exa], script: [turn.search("q"), turn.text("fim")] }, async (h) => {
    await h.run({ goal: "G" }, { searchMode: "econômica" });
    assert.deepEqual(tavily.calls, ["q"]);
    assert.deepEqual(exa.calls, []);
    assert.match(h.llm.toolResults()[0], /T1 \[blog · tavily\]/);
  });

  const broken = failingProvider("tavily", "caiu");
  const empty = emptyProvider("exa");
  const third = fakeProvider("outro", [r("https://o.test/1", "O1")]);
  await withResearch({ providers: [broken, empty, third], script: [turn.search("q"), turn.text("fim")] }, async (h) => {
    const result = await h.run({ goal: "G" }, { searchMode: "econômica" });
    assert.deepEqual(broken.calls, ["q"]);
    assert.deepEqual(empty.calls, ["q"]);
    assert.deepEqual(third.calls, ["q"]);
    assert.match(h.llm.toolResults()[0], /O1 \[blog · outro\]/);
    assert.equal(result.details.searchMode, "econômica");
  });
});

test("Fallback cru usa a Busca agregada sem duplicatas", () =>
  withResearch({
    providers: [
      fakeProvider("tavily", [r("https://a.test/doc", "Doc A", "curto"), r("https://b.test/x", "B")]),
      fakeProvider("exa", [r("https://www.a.test/doc/", "Doc A", "resumo mais longo"), r("https://c.test/y", "C")]),
    ],
    script: [turn.error(400, "quebrou")],
  }, async (h) => {
    const result = await h.run({ goal: "Descobrir X" });
    const text = textOf(result);
    assert.match(text, /^\[Fallback sem síntese/);
    assert.equal((text.match(/a\.test\/doc/g) ?? []).length, 1);
    assert.match(text, /Doc A \[blog · tavily\+exa\]\n   https:\/\/a\.test\/doc\n   resumo mais longo/);
    assert.equal(result.details.fallback, true);
    assert.equal(result.details.resultCount, 3);
    assert.equal(result.details.provider, "tavily+exa");
    assert.deepEqual(result.details.funnel, { found: 4, unique: 3, duplicates: 1, spam: 0 });
    assert.equal(h.progress.includes("4 resultados → 3 únicos → 3 após descarte (0 spam)"), true);
  }));

// Review Codex (P1): o texto cru do Goose só serve quando ele não produziu
// resultados estruturados; nunca para desfazer a curadoria (spam, Fora do tema,
// Critério) — nem no web_search do subagente nem no Fallback cru.
const gooseWith = (text) => ({
  name: "goose:computercontroller", calls: [],
  async search(query) { this.calls.push(query); return gooseResponseFromText(text, "goose:computercontroller", 1); },
});
const gooseJson = (url) => gooseWith(JSON.stringify([{ url, title: "Descartável", summary: "CONTEUDO_QUE_DEVERIA_SAIR" }]));
const discardCases = [
  { name: "spam", url: "https://www.pinterest.com/pin/1", setup: {} },
  { name: "Fora do tema", url: "https://off.test/x", setup: { classifier: fakeClassifier(() => ({ offTopic: 0.99 })) } },
  {
    name: "Critério", url: "https://promo.test/x",
    setup: { classifier: fakeClassifier(() => ({ category: "marketing" })) },
    params: { criteria: [{ category: "docs", description: "documentação" }, { category: "marketing", description: "promo", discard: true }] },
  },
];
for (const c of discardCases) {
  test(`goose: descarte por ${c.name} não volta pelo texto cru no web_search`, () =>
    withResearch({ providers: [gooseJson(c.url)], script: [turn.search("q"), turn.text("fim")], ...c.setup }, async (h) => {
      await h.run({ goal: "G", ...c.params });
      const [seen] = h.llm.toolResults();
      assert.doesNotMatch(seen, /CONTEUDO_QUE_DEVERIA_SAIR/);
      assert.match(seen, /Sem resultados\./);
    }));
  test(`goose: descarte por ${c.name} não volta pelo texto cru no Fallback cru`, () =>
    withResearch({ providers: [gooseJson(c.url)], script: [turn.error(400, "quebrou")], ...c.setup }, async (h) => {
      const result = await h.run({ goal: "G", ...c.params });
      assert.equal(result.details.fallback, true);
      assert.doesNotMatch(textOf(result), /CONTEUDO_QUE_DEVERIA_SAIR/);
      assert.match(textOf(result), /research: sem resultados\./);
    }));
}

test("goose sem resultados estruturados: o texto cru continua chegando ao subagente", () =>
  withResearch({ providers: [gooseWith("Resposta livre do goose sem URLs.")], script: [turn.search("q"), turn.text("fim")] }, async (h) => {
    await h.run({ goal: "G" });
    assert.match(h.llm.toolResults()[0], /Resposta livre do goose sem URLs\./);
  }));
