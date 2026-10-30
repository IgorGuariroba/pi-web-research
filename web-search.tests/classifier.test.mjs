// Classificador (ticket #7): Fora do tema e Nível de fonte, com fallback por regras,
// exercitados pelo núcleo de Research.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, fakeClassifier, registryClassifier, r } from "./research-harness.mjs";

const modelRef = { provider: "fake-llm", id: "fake-model" };

async function withResearch(setup, fn) {
  const h = await setupResearch({ modelRef, script: [turn.search("react hooks"), turn.text("fim")], ...setup });
  try { return await fn(h); } finally { await h.cleanup(); }
}

test("resultado Fora do tema é descartado e contado nos details", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://react.dev/learn", "Learn"),
      r("https://receitas.test/bolo", "Bolo"),
    ])],
    classifier: fakeClassifier({ "https://receitas.test/bolo": { offTopic: 0.95 } }),
  }, async (h) => {
    const result = await h.run({ goal: "Como usar React hooks" });
    const [seen] = h.llm.toolResults();
    assert.match(seen, /Learn/);
    assert.doesNotMatch(seen, /receitas|Bolo/);
    assert.equal(result.details.funnel.offTopic, 1);
  }));

test("Nível vem do classificador (substitui as regras) e spam do classificador sai", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://react.dev/learn", "Learn"),
      r("https://www.reddit.com/r/reactjs/1", "Thread"),
      r("https://fazenda.test/x", "Fazenda"),
    ])],
    classifier: fakeClassifier({
      "https://react.dev/learn": { level: "blog" },
      "https://www.reddit.com/r/reactjs/1": { level: "docs" },
      "https://fazenda.test/x": { level: "spam" },
    }),
  }, async (h) => {
    const result = await h.run({ goal: "Como usar React hooks" });
    const [seen] = h.llm.toolResults();
    assert.match(seen, /1\. Thread \[docs · tavily\]/);
    assert.match(seen, /2\. Learn \[blog · tavily\]/);
    assert.doesNotMatch(seen, /Fazenda/);
    assert.equal(result.details.funnel.spam, 1);
  }));

test("uma chamada ao classificador por busca, com todos os resultados da busca", async () => {
  const classifier = fakeClassifier();
  await withResearch({
    providers: [fakeProvider("tavily", (q) => [r(`https://a.test/${q}/1`), r(`https://a.test/${q}/2`), r(`https://a.test/${q}/3`)])],
    script: [turn.search("um"), turn.search("dois"), turn.text("fim")],
    classifier,
  }, async (h) => {
    await h.run({ goal: "React", focus: "hooks" });
    assert.equal(classifier.calls.length, 2);
    assert.deepEqual(classifier.calls.map((c) => c.query), ["um", "dois"]);
    assert.equal(classifier.calls[0].results.length, 3);
    assert.equal(classifier.calls[0].goal, "React");
    assert.equal(classifier.calls[0].focus, "hooks");
  });
});

test("details trazem o classificador usado, o custo somado e os descartes por Fora do tema", () =>
  withResearch({
    providers: [fakeProvider("tavily", (q) => [r(`https://a.test/${q}`), r(`https://off.test/${q}`)])],
    script: [turn.search("um"), turn.search("dois"), turn.text("fim")],
    classifier: fakeClassifier((result) => ({ offTopic: result.url.startsWith("https://off.test") ? 0.9 : 0.1 }),
      { name: "openrouter/typesafe/jev-1.14", costUsd: 0.002 }),
  }, async (h) => {
    const result = await h.run({ goal: "React" });
    assert.equal(result.details.classifier, "openrouter/typesafe/jev-1.14");
    assert.ok(Math.abs(result.details.classifierCost - 0.004) < 1e-12);
    assert.equal(result.details.funnel.offTopic, 2);
    assert.ok(h.progress.includes("4 resultados → 4 únicos → 2 após descarte (0 spam, 2 fora do tema)"));
  }));

test("abaixo do limiar o resultado é mantido", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://talvez.test/x", "Talvez")])],
    classifier: fakeClassifier({ "https://talvez.test/x": { offTopic: 0.5 } }),
  }, async (h) => {
    const result = await h.run({ goal: "React" });
    assert.match(h.llm.toolResults()[0], /Talvez/);
    assert.equal(result.details.funnel.offTopic, 0);
  }));

test("sem classificador: Nível das regras, details com classificador nenhum e sem Fora do tema", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://www.reddit.com/r/reactjs/1", "Thread"), r("https://react.dev/learn", "Learn")])],
    classifier: "none",
  }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    const [seen] = h.llm.toolResults();
    assert.match(seen, /1\. Learn \[oficial · tavily\]/);
    assert.match(seen, /2\. Thread \[fórum · tavily\]/);
    assert.equal(result.details.classifier, "nenhum");
    assert.equal(result.details.classifierCost, 0);
    assert.equal(result.details.funnel.offTopic, undefined);
  }));

test("falha do classificador: a busca cai nas regras, com aviso", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://react.dev/learn", "Learn")])],
    classifier: fakeClassifier({}, { fail: "cota esgotada" }),
  }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    assert.match(h.llm.toolResults()[0], /1\. Learn \[oficial · tavily\]/);
    assert.ok(result.details.searchWarnings.some((w) => /classificador .*cota esgotada/.test(w)));
  }));

test("Fallback cru também é curado pelo classificador", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://a.test/x", "A"), r("https://off.test/x", "Off")])],
    script: [turn.error(400, "quebrou")],
    classifier: fakeClassifier({ "https://off.test/x": { offTopic: 0.99 }, "https://a.test/x": { level: "docs" } }),
  }, async (h) => {
    const result = await h.run({ goal: "React" });
    assert.equal(result.details.fallback, true);
    assert.equal(result.details.resultCount, 1);
    assert.equal(result.details.funnel.offTopic, 1);
    assert.equal(result.details.classifier, "fake/classifier");
  }));

// ---- Detecção pelo model registry do Pi (adaptador real) ----

const twoResults = () => fakeProvider("tavily", [r("https://react.dev/learn", "Learn"), r("https://off.test/x", "Off")]);
const judge = { "https://off.test/x": { offTopic: 0.9 }, "https://react.dev/learn": { level: "fórum" } };

test("classificador detectado automaticamente pela lista de preferência (Jev antes de Clef)", async () => {
  const clef = registryClassifier("openrouter", "cloudflare/clef-flash", judge);
  const jev = registryClassifier("openrouter", "typesafe/jev-1.14", judge);
  await withResearch({ providers: [twoResults()], classifier: "auto", registryClassifiers: [clef, jev] }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    const [seen] = h.llm.toolResults();
    assert.equal(result.details.classifier, "openrouter/typesafe/jev-1.14");
    assert.equal(jev.calls.length, 1);
    assert.equal(clef.calls.length, 0);
    assert.match(seen, /1\. Learn \[fórum · tavily\]/);
    assert.doesNotMatch(seen, /Off/);
    assert.equal(result.details.funnel.offTopic, 1);
    assert.ok(result.details.classifierCost > 0);
  });
});

test("sem Jev disponível, a detecção cai no Clef", async () => {
  const clef = registryClassifier("openrouter", "cloudflare/clef-flash", judge);
  await withResearch({ providers: [twoResults()], classifier: "auto", registryClassifiers: [clef] }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    assert.equal(result.details.classifier, "openrouter/cloudflare/clef-flash");
    assert.equal(clef.calls.length, 1);
  });
});

test("classificador fora da lista de preferência não é detectado automaticamente", async () => {
  const other = registryClassifier("outro", "c1", judge);
  await withResearch({ providers: [twoResults()], classifier: "auto", registryClassifiers: [other] }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    assert.equal(result.details.classifier, "nenhum");
    assert.equal(other.calls.length, 0);
  });
});

test("escolha explícita usa o classificador salvo; \"none\" desliga mesmo havendo disponível", async () => {
  const other = registryClassifier("outro", "c1", judge);
  const jev = registryClassifier("openrouter", "typesafe/jev-1.14", judge);
  await withResearch({ providers: [twoResults()], classifier: { provider: "outro", id: "c1" }, registryClassifiers: [other, jev] }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    assert.equal(result.details.classifier, "outro/c1");
    assert.equal(other.calls.length, 1);
    assert.equal(jev.calls.length, 0);
  });
  await withResearch({ providers: [twoResults()], classifier: "none", registryClassifiers: [jev] }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    assert.equal(result.details.classifier, "nenhum");
    assert.equal(jev.calls.length, 0);
    assert.match(h.llm.toolResults()[0], /Off/);
  });
});

test("classificador do registry com erro: busca cai nas regras, com aviso", async () => {
  const jev = registryClassifier("openrouter", "typesafe/jev-1.14", judge, { stopReason: "error" });
  await withResearch({ providers: [twoResults()], classifier: "auto", registryClassifiers: [jev] }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    assert.match(h.llm.toolResults()[0], /1\. Learn \[oficial · tavily\]/);
    assert.ok(result.details.searchWarnings.some((w) => /classificador openrouter\/typesafe\/jev-1\.14 falhou/.test(w)));
  });
});

test("adaptador do Pi faz uma única classify por busca com goal, query e resultados no state", async () => {
  const jev = registryClassifier("openrouter", "typesafe/jev-1.14", judge);
  await withResearch({ providers: [twoResults()], classifier: "auto", registryClassifiers: [jev] }, async (h) => {
    await h.run({ goal: "React hooks", focus: "useEffect" });
    const [ctx] = jev.calls;
    assert.equal(ctx.state.goal, "React hooks");
    assert.equal(ctx.state.focus, "useEffect");
    assert.equal(ctx.state.query, "react hooks");
    assert.deepEqual(ctx.state.results.map((x) => x.url), ["https://react.dev/learn", "https://off.test/x"]);
  });
});

test("adaptador do Pi: cada pergunta mede o TEMA e cita o título/URL do próprio resultado", async () => {
  const jev = registryClassifier("openrouter", "typesafe/jev-1.14", judge);
  await withResearch({ providers: [twoResults()], classifier: "auto", registryClassifiers: [jev] }, async (h) => {
    await h.run({ goal: "React hooks" });
    const [ctx] = jev.calls;
    assert.equal(jev.calls.length, 1, "uma chamada ao classificador por busca (decisão da spec)");
    const items = [["Learn", "https://react.dev/learn"], ["Off", "https://off.test/x"]];
    items.forEach(([title, url], i) => {
      for (const key of [`r${i}_offtopic`, `r${i}_level`]) {
        const { instructions } = ctx.questions[key];
        assert.ok(instructions.includes(url) && instructions.includes(title), `${key} cita o próprio item: ${instructions}`);
      }
      // Fora do tema = assunto diferente; utilidade não entra na pergunta.
      assert.doesNotMatch(ctx.questions[`r${i}_offtopic`].instructions, /ajuda a responder|útil/);
    });
  });
});

test("details listam os descartados por Fora do tema (url + probabilidade, até 20), fora do texto", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://react.dev/learn", "Learn"),
      ...Array.from({ length: 25 }, (_, i) => r(`https://off.test/${i}`, `Off ${i}`)),
    ])],
    classifier: fakeClassifier((result) => ({ offTopic: result.url.startsWith("https://off.test") ? 0.9 : 0.1 })),
  }, async (h) => {
    const result = await h.run({ goal: "React" });
    assert.equal(result.details.funnel.offTopic, 25);
    assert.equal(result.details.offTopicDiscarded.length, 20);
    assert.deepEqual(result.details.offTopicDiscarded[0], { url: "https://off.test/0", offTopic: 0.9 });
    assert.doesNotMatch(result.content.map((c) => c.text).join("\n"), /off\.test/);
  }));

test("sem descartes por Fora do tema, details não trazem a lista", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://react.dev/learn", "Learn")])],
    classifier: fakeClassifier(),
  }, async (h) => {
    const result = await h.run({ goal: "React" });
    assert.equal(result.details.offTopicDiscarded, undefined);
  }));
