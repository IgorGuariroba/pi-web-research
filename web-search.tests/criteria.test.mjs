// Critério do Agente pai (ticket #8): classificação por Categoria, descarte,
// ordenação Critério → Nível → Concordância, prompt e aviso sem classificador.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, fakeClassifier, registryClassifier, r, textOf } from "./research-harness.mjs";

const modelRef = { provider: "fake-llm", id: "fake-model" };

const criteria = [
  { category: "relato-producao", description: "experiência real de uso em produção" },
  { category: "benchmark", description: "medições com números" },
  { category: "marketing", description: "página promocional sem dados", discard: true },
];

async function withResearch(setup, fn) {
  const h = await setupResearch({ modelRef, script: [turn.search("bun em produção"), turn.text("fim")], ...setup });
  try { return await fn(h); } finally { await h.cleanup(); }
}

test("Critério inválido é rejeitado com mensagem clara", () =>
  withResearch({ providers: [fakeProvider("tavily", [])] }, async (h) => {
    const one = [{ category: "a", description: "x" }];
    const nine = Array.from({ length: 9 }, (_, i) => ({ category: `c${i}`, description: "x" }));
    const onlyDiscard = [{ category: "a", description: "x", discard: true }, { category: "b", description: "y", discard: true }];
    await assert.rejects(h.run({ goal: "Bun", criteria: one }), /criteria.*entre 2 e 8/i);
    await assert.rejects(h.run({ goal: "Bun", criteria: nine }), /criteria.*entre 2 e 8/i);
    await assert.rejects(h.run({ goal: "Bun", criteria: onlyDiscard }), /criteria.*ao menos uma Categoria sem descarte/i);
    assert.equal(h.llm.requests.length, 0);
  }));

test("resultados recebem Categoria do Critério ou outros; descarte não chega ao subagente", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://a.test/case", "Case"),
      r("https://b.test/promo", "Promo"),
      r("https://c.test/misc", "Misc"),
    ])],
    classifier: fakeClassifier({
      "https://a.test/case": { category: "relato-producao" },
      "https://b.test/promo": { category: "marketing" },
      "https://c.test/misc": { category: "outros" },
    }),
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    const [seen] = h.llm.toolResults();
    assert.match(seen, /1\. Case \[relato-producao · blog · tavily\]/);
    assert.match(seen, /2\. Misc \[outros · blog · tavily\]/);
    assert.doesNotMatch(seen, /Promo/);
    assert.equal(result.details.funnel.criteriaDiscarded, 1);
  }));

test("classificador recebe o Critério na mesma chamada da busca", async () => {
  const classifier = fakeClassifier();
  await withResearch({ providers: [fakeProvider("tavily", [r("https://a.test/x")])], classifier }, async (h) => {
    await h.run({ goal: "Bun em produção", criteria });
    assert.equal(classifier.calls.length, 1);
    assert.deepEqual(classifier.calls[0].criteria.map((c) => c.category), ["relato-producao", "benchmark", "marketing"]);
  });
});

test("ordenação Critério → Nível → Concordância", () =>
  withResearch({
    providers: [
      fakeProvider("tavily", [
        r("https://outros-oficial.test/x", "OutrosOficial"),
        r("https://bench-blog.test/x", "BenchBlog"),
        r("https://bench-docs.test/x", "BenchDocs"),
        r("https://relato-forum.test/x", "RelatoForum"),
        r("https://relato-forum2.test/x", "RelatoForumDuplo"),
      ]),
      fakeProvider("exa", [r("https://relato-forum2.test/x", "RelatoForumDuplo")]),
    ],
    classifier: fakeClassifier({
      "https://outros-oficial.test/x": { category: "outros", level: "oficial" },
      "https://bench-blog.test/x": { category: "benchmark", level: "blog" },
      "https://bench-docs.test/x": { category: "benchmark", level: "docs" },
      "https://relato-forum.test/x": { category: "relato-producao", level: "fórum" },
      "https://relato-forum2.test/x": { category: "relato-producao", level: "fórum" },
    }),
  }, async (h) => {
    await h.run({ goal: "Bun em produção", criteria });
    const titles = [...h.llm.toolResults()[0].matchAll(/^\d+\. (\S+) \[/gm)].map((m) => m[1]);
    assert.deepEqual(titles, ["RelatoForumDuplo", "RelatoForum", "BenchDocs", "BenchBlog", "OutrosOficial"]);
  }));

test("prompt do subagente lista as Categorias com prioridade e manda buscar ativamente cada uma", () =>
  withResearch({ providers: [fakeProvider("tavily", [])], classifier: fakeClassifier() }, async (h) => {
    await h.run({ goal: "Bun em produção", criteria });
    const prompt = h.llm.userPrompt();
    assert.match(prompt, /1\. relato-producao: experiência real de uso em produção/);
    assert.match(prompt, /2\. benchmark: medições com números/);
    assert.match(prompt, /marketing: página promocional sem dados \(descartar\)/);
    assert.match(prompt, /busque ativamente cada Categoria/i);
  }));

test("sem classificador: Critério ignorado com aviso no topo da Síntese e nos details", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://a.test/x", "A")])],
    pages: { "https://a.test/x": "<html><body><p>Bun em produção funciona.</p></body></html>" },
    script: [turn.search("bun"), turn.fetch("https://a.test/x"), turn.text("Síntese\n\nFontes\n- https://a.test/x")],
    classifier: "none",
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    const text = textOf(result);
    assert.match(text, /^\[Critério ignorado — nenhum classificador disponível/);
    assert.match(result.details.criteriaIgnored, /nenhum classificador/);
    assert.doesNotMatch(h.llm.userPrompt(), /relato-producao/);
    assert.match(h.llm.toolResults()[0], /1\. A \[blog · tavily\]/);
  }));

test("sem classificador, o aviso de Critério ignorado também vai no Fallback cru", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://a.test/x", "A")])],
    script: [turn.error(400, "quebrou")],
    classifier: "none",
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    assert.equal(result.details.fallback, true);
    assert.match(textOf(result), /^\[Critério ignorado/);
    assert.ok(result.details.criteriaIgnored);
  }));

/** Classificador que falha só na primeira chamada (queda no meio da pesquisa). */
function flakyClassifier() {
  const ok = fakeClassifier({ "https://a.test/dois": { category: "benchmark", level: "docs" } });
  let calls = 0;
  return { ...ok, async judgeResults(input) { if (calls++ === 0) throw new Error("timeout"); return ok.judgeResults(input); } };
}

test("falha do classificador no meio da pesquisa: Critério degradado na Síntese e nos details", () =>
  withResearch({
    providers: [fakeProvider("tavily", (q) => [r(`https://a.test/${q}`, q)])],
    script: [turn.search("um"), turn.search("dois"), turn.text("Síntese")],
    classifier: flakyClassifier(),
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    const text = textOf(result);
    assert.match(text, /^\[Critério degradado — classificador fake\/classifier falhou em 1 julgamento/);
    assert.match(result.details.criteriaDegraded, /falhou em 1 julgamento/);
    assert.equal(result.details.criteriaIgnored, undefined);
    assert.ok(result.details.searchWarnings.some((w) => /falhou: timeout/.test(w)));
  }));

test("falha do classificador com Critério também sinaliza Critério degradado no Fallback cru", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://a.test/x", "A")])],
    script: [turn.error(400, "quebrou")],
    classifier: fakeClassifier({}, { fail: "cota" }),
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    assert.equal(result.details.fallback, true);
    assert.match(textOf(result), /^\[Critério degradado/);
    assert.ok(result.details.criteriaDegraded);
  }));

test("classificador sem falhas: sem aviso de Critério degradado", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://a.test/x", "A")])],
    classifier: fakeClassifier(),
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    assert.equal(result.details.criteriaDegraded, undefined);
    assert.doesNotMatch(textOf(result), /Critério degradado/);
  }));

test("sem criteria: comportamento do Classificador mantido (rótulo sem Categoria, sem contagem de Critério)", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://a.test/x", "A")])],
    classifier: fakeClassifier({ "https://a.test/x": { category: "benchmark", level: "docs" } }),
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção" });
    assert.match(h.llm.toolResults()[0], /1\. A \[docs · tavily\]/);
    assert.equal(result.details.funnel.criteriaDiscarded, undefined);
    assert.equal(result.details.criteriaIgnored, undefined);
    assert.equal(h.progress.find((m) => m.includes("após descarte")), "1 resultados → 1 únicos → 1 após descarte (0 spam, 0 fora do tema)");
  }));

test("adaptador do Pi pergunta a Categoria na mesma classify e aplica descarte e rótulo", async () => {
  const jev = registryClassifier("openrouter", "typesafe/jev-1.14", {
    "https://a.test/case": { category: "relato-producao" },
    "https://b.test/promo": { category: "marketing" },
    "https://c.test/bench": { category: "benchmark", level: "docs" },
  });
  await withResearch({
    providers: [fakeProvider("tavily", [r("https://c.test/bench", "Bench"), r("https://b.test/promo", "Promo"), r("https://a.test/case", "Case")])],
    classifier: "auto", registryClassifiers: [jev],
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    assert.equal(jev.calls.length, 1);
    const [seen] = h.llm.toolResults();
    assert.match(seen, /1\. Case \[relato-producao · blog · tavily\]/);
    assert.match(seen, /2\. Bench \[benchmark · docs · tavily\]/);
    assert.doesNotMatch(seen, /Promo/);
    assert.equal(result.details.funnel.criteriaDiscarded, 1);
    assert.deepEqual(jev.calls[0].state.criteria.map((c) => c.category), ["relato-producao", "benchmark", "marketing"]);
  });
});

// Review Codex (P2): rótulos de Categoria no adaptador são únicos — o rótulo
// gerado para uma Categoria sem slug (ex. `日常`) não pode apagar outra (`c1`).
test("adaptador do Pi: Categorias com rótulos que colidiriam continuam distintas", async () => {
  const tricky = [
    { category: "c1", description: "primeira" },
    { category: "日常", description: "cotidiano" },
    { category: "c2", description: "terceira" },
    { category: "日本", description: "japão" },
  ];
  const urls = ["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://d.test/4"];
  const jev = registryClassifier("openrouter", "typesafe/jev-1.14", Object.fromEntries(urls.map((u, i) => [u, { category: tricky[i].category }])));
  await withResearch({
    providers: [fakeProvider("tavily", urls.map((u, i) => r(u, `T${i}`)))],
    classifier: "auto", registryClassifiers: [jev],
  }, async (h) => {
    await h.run({ goal: "Bun em produção", criteria: tricky });
    const [seen] = h.llm.toolResults();
    tricky.forEach((c, i) => assert.match(seen, new RegExp(`T${i} \\[${c.category} · blog · tavily\\]`)));
    const choices = Object.values(jev.calls[0].questions).find((q) => q.type === "choice" && "outros" in q.criteria).criteria;
    assert.equal(Object.keys(choices).length, tricky.length + 1);
  });
});
