// Busca agregada (ticket #3), exercitada pelo núcleo de Research.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, failingProvider, emptyProvider, fakeClassifier, r, textOf } from "./research-harness.mjs";
import { gooseResponseFromText } from "../goose-adapter.ts";

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
