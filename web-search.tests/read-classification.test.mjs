// Extração focada com classificador e classificação na leitura (ticket #10),
// observadas pelo que o subagente recebe do fetch_url, pela Síntese e pelos details.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, fakeClassifier, registryClassifier, r, textOf } from "./research-harness.mjs";

const modelRef = { provider: "fake-llm", id: "fake-model" };
const PAGE = "https://capi.test/guia";

/** Texto puro com 30 trechos iguais para as regras; marcadores ALTA-i nos índices 10..16. */
function plainPage() {
  const lines = Array.from({ length: 30 }, (_, i) => {
    const marker = i >= 10 && i < 17 ? `ALTA-${i}` : `BAIXA-${i}`;
    return `${marker} capivara roedor ${"lorem ".repeat(110)}`.trim();
  });
  return { contentType: "text/plain", body: lines.join("\n") };
}

const passageScore = (passage) => (/ALTA-/.test(passage) ? 0.9 : 0.1);

async function readPage(setup, params = { goal: "Quanto pesa a capivara, o roedor" }) {
  const h = await setupResearch({
    modelRef, providers: [fakeProvider("tavily", [r(PAGE, "Guia")])], pages: { [PAGE]: plainPage() },
    script: [turn.search("capivara roedor"), turn.fetch(PAGE), turn.text(`Síntese.\n\nFontes\n- ${PAGE}`)],
    ...setup,
  });
  try {
    const result = await h.run(params);
    return { h, result, read: h.llm.toolResults()[1] };
  } finally {
    await h.cleanup();
  }
}

test("com classificador, os trechos devolvidos seguem a nota de relevância", async () => {
  const classifier = fakeClassifier({}, { costUsd: 0.001, passages: passageScore, passageCostUsd: 0.002 });
  const { read, result } = await readPage({ classifier });
  for (let i = 10; i < 17; i++) assert.match(read, new RegExp(`ALTA-${i}\\b`));
  assert.doesNotMatch(read, /BAIXA-/);
  assert.ok(read.length <= 5_500, `leitura com ${read.length} caracteres`);
  const call = classifier.passageCalls[0];
  assert.equal(call.goal, "Quanto pesa a capivara, o roedor");
  assert.equal(call.query, "capivara roedor");
  assert.ok(call.passages.length > 0 && call.passages.length <= 20, `${call.passages.length} candidatos`);
  assert.equal(result.details.classifierCost, 0.003);
});

test("sem classificador, a Extração focada por regras continua igual", async () => {
  const { read } = await readPage({ classifier: "none" });
  for (let i = 0; i < 7; i++) assert.match(read, new RegExp(`BAIXA-${i}\\b`));
  assert.doesNotMatch(read, /ALTA-/);
});

test("falha do classificador na nota de trechos cai nas regras com aviso", async () => {
  const classifier = fakeClassifier({}, { passages: passageScore, failPassages: "quota" });
  const { read, result } = await readPage({ classifier });
  assert.match(read, /BAIXA-0\b/);
  assert.doesNotMatch(read, /ALTA-/);
  assert.ok(result.details.searchWarnings.some((w) => /classificador fake\/classifier falhou: quota; usando regras/.test(w)));
});

test("classificador do model registry dá nota aos trechos (adaptador Pi)", async () => {
  const clf = registryClassifier("openrouter", "typesafe/jev-1.14", {}, { costUsd: 0.000004, passages: passageScore });
  const { read, result } = await readPage({ classifier: "auto", registryClassifiers: [clf] });
  assert.match(read, /ALTA-13\b/);
  assert.doesNotMatch(read, /BAIXA-/);
  assert.equal(result.details.classifier, "openrouter/typesafe/jev-1.14");
  assert.ok(clf.calls.some((ctx) => Array.isArray(ctx.state.passages)));
});

const criteria = [
  { category: "relato-producao", description: "experiência real de uso em produção" },
  { category: "benchmark", description: "medições com números" },
];
const FORUM = "https://forum.algo.test/t/1";
const page = (text) => `<html><head><title>Relato no fórum</title></head><body><article><p>${text}</p></article></body></html>`;

test("página fora das buscas é classificada na leitura: rótulo em Fontes, Cobertura e custo", async () => {
  const classifier = fakeClassifier({ [FORUM]: { category: "relato-producao", level: "fórum" } }, { costUsd: 0.001 });
  const h = await setupResearch({
    modelRef, classifier, providers: [fakeProvider("tavily", [])],
    pages: { [FORUM]: page("Rodamos Bun em produção por um ano.") },
    script: [turn.search("bun produção"), turn.fetch(FORUM), turn.text(`Síntese.\n\nFontes\n- ${FORUM}`)],
  });
  try {
    const result = await h.run({ goal: "Bun em produção", criteria });
    const text = textOf(result);
    assert.match(text, /Fontes\n- https:\/\/forum\.algo\.test\/t\/1 \[relato-producao · fórum\]/);
    assert.match(text, /Não encontrado\n- benchmark/);
    assert.doesNotMatch(text, /Não encontrado[\s\S]*relato-producao/);
    assert.deepEqual(result.details.readsByCategory, { "relato-producao": 1, benchmark: 0 });
    const readCall = classifier.calls.find((c) => c.results.some((x) => x.url === FORUM));
    assert.ok(readCall, "classificador chamado na leitura");
    assert.deepEqual(readCall.criteria, criteria);
    assert.equal(result.details.classifierCost, 0.001);
  } finally {
    await h.cleanup();
  }
});

test("página fora das buscas sem Critério recebe o Nível do classificador", async () => {
  const classifier = fakeClassifier({ [FORUM]: { level: "docs" } });
  const h = await setupResearch({
    modelRef, classifier, providers: [fakeProvider("tavily", [])],
    pages: { [FORUM]: page("Relato.") },
    script: [turn.fetch(FORUM), turn.text(`Síntese.\n\nFontes\n- ${FORUM}`)],
  });
  try {
    const result = await h.run({ goal: "Bun em produção" });
    assert.match(textOf(result), /Fontes\n- https:\/\/forum\.algo\.test\/t\/1 \[docs\]$/);
    assert.equal(classifier.calls[0].query, "Bun em produção");
  } finally {
    await h.cleanup();
  }
});

// Decisão (review): "Fora do tema é sempre descartado" vale também para a página
// lida fora das buscas — com ou sem Critério ela não é Fonte lida, não cobre
// Categoria, não aparece rotulada em Fontes e entra nos descartes dos details.
for (const withCriteria of [true, false]) {
  test(`página fora das buscas Fora do tema é descartada (${withCriteria ? "com" : "sem"} Critério)`, async () => {
    const classifier = fakeClassifier({ [FORUM]: { category: "relato-producao", level: "blog", offTopic: 0.95 } });
    const cite = `Síntese.\n\nFontes\n- ${FORUM}`;
    const h = await setupResearch({
      modelRef, classifier, providers: [fakeProvider("tavily", [])],
      pages: { [FORUM]: page("Receita de bolo.") },
      script: [turn.fetch(FORUM), turn.text(cite), turn.text(cite)],
    });
    try {
      const result = await h.run({ goal: "Bun em produção", ...(withCriteria ? { criteria } : {}) });
      const text = textOf(result);
      assert.match(h.llm.toolResults()[0], /Fora do tema/);
      assert.doesNotMatch(h.llm.toolResults()[0], /Receita de bolo/);
      assert.doesNotMatch(text, /forum\.algo\.test.*\[/);
      assert.equal(result.details.sourcesRead, 0);
      assert.deepEqual(result.details.removedCitations, [FORUM]);
      if (withCriteria) assert.deepEqual(result.details.readsByCategory, { "relato-producao": 0, benchmark: 0 });
    } finally {
      await h.cleanup();
    }
  });
}
