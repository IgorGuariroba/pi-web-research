// Cobertura e Lacuna declarada (ticket #9): regra de Cobertura no prompt, rótulos
// [categoria · nível] em "Fontes" gerados pelo código e seção "Não encontrado".
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, fakeClassifier, r, textOf } from "./research-harness.mjs";

const modelRef = { provider: "fake-llm", id: "fake-model" };

const criteria = [
  { category: "relato-producao", description: "experiência real de uso em produção" },
  { category: "benchmark", description: "medições com números" },
  { category: "issue", description: "bugs abertos no rastreador" },
  { category: "marketing", description: "página promocional sem dados", discard: true },
];

const page = (text) => `<html><body><article><p>${text}</p></article></body></html>`;

async function withResearch(setup, fn) {
  const h = await setupResearch({ modelRef, script: [turn.search("bun em produção"), turn.text("fim")], ...setup });
  try { return await fn(h); } finally { await h.cleanup(); }
}

test("prompt do deep exige ler uma fonte de cada Categoria não descartada antes de repetir", () =>
  withResearch({ providers: [fakeProvider("tavily", [])], classifier: fakeClassifier() }, async (h) => {
    await h.run({ goal: "Bun em produção", depth: "deep", criteria });
    const prompt = h.llm.userPrompt();
    assert.match(prompt, /Cobertura: leia ao menos uma fonte de cada Categoria não descartada \(relato-producao, benchmark, issue\) antes de ler uma segunda fonte de alguma delas\./);
    assert.doesNotMatch(prompt, /Cobertura:[^\n]*marketing/);
  }));

test("prompt do quick limita a Cobertura às 2 Categorias de maior prioridade", () =>
  withResearch({ providers: [fakeProvider("tavily", [])], classifier: fakeClassifier() }, async (h) => {
    await h.run({ goal: "Bun em produção", depth: "quick", criteria });
    assert.match(h.llm.userPrompt(), /Cobertura: leia ao menos uma fonte de cada Categoria não descartada \(relato-producao, benchmark\) antes de ler uma segunda fonte de alguma delas\./);
  }));

test("sem Critério, o prompt não tem regra de Cobertura", () =>
  withResearch({ providers: [fakeProvider("tavily", [])], classifier: fakeClassifier() }, async (h) => {
    await h.run({ goal: "Bun em produção", depth: "deep" });
    assert.doesNotMatch(h.llm.userPrompt(), /Cobertura/);
  }));

const CASE = "https://relato.test/case";
const BENCH = "https://bench.test/numeros";
const searchJudge = fakeClassifier({
  [CASE]: { category: "relato-producao", level: "fórum" },
  [BENCH]: { category: "benchmark", level: "docs" },
});

test("com Critério, \"Fontes\" sai com rótulos [categoria · nível] gerados pelo código", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r(CASE, "Case"), r(BENCH, "Bench")])],
    pages: { [CASE]: page("Bun roda em produção."), [BENCH]: page("Bun faz 100k req/s.") },
    classifier: searchJudge,
    script: [
      turn.search("bun produção"), turn.fetch(CASE), turn.fetch(BENCH),
      turn.text(`Bun aguenta produção.\n\nFontes\n- [Case](${CASE})\n- ${BENCH}`),
    ],
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    const text = textOf(result);
    assert.match(text, /^Fontes\n- \[Case\]\(https:\/\/relato\.test\/case\) \[relato-producao · fórum\]\n- https:\/\/bench\.test\/numeros \[benchmark · docs\]$/m);
  }));

test("Categoria sem Fonte lida vai para \"Não encontrado\"; coberta e de descarte não; details trazem leituras por Categoria", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r(CASE, "Case"), r(BENCH, "Bench")])],
    pages: { [CASE]: page("Bun roda em produção.") },
    classifier: searchJudge,
    script: [
      turn.search("bun produção"), turn.fetch(CASE),
      turn.text(`Bun aguenta produção.\n\nFontes\n- ${CASE}`),
    ],
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", depth: "deep", criteria });
    const text = textOf(result);
    assert.match(text, /\n\nNão encontrado\n- benchmark: medições com números\n- issue: bugs abertos no rastreador$/);
    const gap = text.slice(text.indexOf("Não encontrado"));
    assert.doesNotMatch(gap, /relato-producao/);
    assert.doesNotMatch(gap, /marketing/);
    assert.deepEqual(result.details.readsByCategory, { "relato-producao": 1, benchmark: 0, issue: 0 });
  }));

test("Lacuna declarada vem do que foi lido, não do que o subagente diz ter coberto", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r(CASE, "Case"), r(BENCH, "Bench")])],
    pages: { [CASE]: page("Bun roda em produção."), [BENCH]: page("Bun faz 100k req/s.") },
    classifier: searchJudge,
    script: [
      turn.search("bun produção"), turn.fetch(CASE), turn.fetch(BENCH), turn.fetch("https://fora.test/x"),
      turn.text(`Tudo coberto.\n\nFontes\n- ${CASE}`),
    ],
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", depth: "quick", criteria });
    const text = textOf(result);
    // benchmark foi lida (mesmo sem ser citada): não é Lacuna; issue não foi lida.
    assert.match(text, /\n\nNão encontrado\n- issue: bugs abertos no rastreador$/);
    assert.deepEqual(result.details.readsByCategory, { "relato-producao": 1, benchmark: 1, issue: 0 });
  }));

test("todas as Categorias cobertas: sem \"Não encontrado\"", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r(CASE), r(BENCH), r("https://issue.test/1")])],
    pages: { [CASE]: page("a"), [BENCH]: page("b"), "https://issue.test/1": page("c") },
    classifier: fakeClassifier({
      [CASE]: { category: "relato-producao" }, [BENCH]: { category: "benchmark" }, "https://issue.test/1": { category: "issue" },
    }),
    script: [
      turn.search("bun"), turn.fetch(CASE), turn.fetch(BENCH), turn.fetch("https://issue.test/1"),
      turn.text(`Síntese.\n\nFontes\n- ${CASE}`),
    ],
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", depth: "deep", criteria });
    assert.doesNotMatch(textOf(result), /Não encontrado/);
  }));

test("sem Critério: \"Fontes\" só com rótulo de Nível e sem \"Não encontrado\"", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://docs.bun.test/guia", "Guia")])],
    pages: { "https://docs.bun.test/guia": page("Bun em produção.") },
    script: [turn.search("produção"), turn.fetch("https://docs.bun.test/guia"), turn.text("Síntese.\n\nFontes\n- https://docs.bun.test/guia")],
  }, async (h) => {
    const result = await h.run({ goal: "Usar em produção", depth: "deep" });
    const text = textOf(result);
    assert.equal(text, "Síntese.\n\nFontes\n- https://docs.bun.test/guia [docs]");
    assert.equal(result.details.readsByCategory, undefined);
  }));

test("Critério ignorado sem classificador: sem \"Não encontrado\" e Fontes só com Nível", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://docs.bun.test/guia", "Guia")])],
    pages: { "https://docs.bun.test/guia": page("Bun em produção.") },
    classifier: "none",
    script: [turn.search("produção"), turn.fetch("https://docs.bun.test/guia"), turn.text("Síntese.\n\nFontes\n- https://docs.bun.test/guia")],
  }, async (h) => {
    const result = await h.run({ goal: "Usar em produção", criteria });
    const text = textOf(result);
    assert.match(text, /Fontes\n- https:\/\/docs\.bun\.test\/guia \[docs\]$/);
    assert.doesNotMatch(text, /Não encontrado/);
  }));

test("página lida fora das buscas classificada como outros entra em \"Fontes\" como [outros · nível] e não cobre Categoria", () =>
  withResearch({
    providers: [fakeProvider("tavily", [])],
    pages: { "https://forum.algo.test/t/1": page("Relato.") },
    classifier: fakeClassifier(),
    script: [turn.fetch("https://forum.algo.test/t/1"), turn.text("Síntese.\n\nFontes\n- https://forum.algo.test/t/1")],
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", criteria });
    const text = textOf(result);
    assert.match(text, /Fontes\n- https:\/\/forum\.algo\.test\/t\/1 \[outros · blog\]\n\nNão encontrado\n- relato-producao/);
    assert.deepEqual(result.details.readsByCategory, { "relato-producao": 0, benchmark: 0, issue: 0 });
  }));

// Review Codex (P2): a Lacuna declarada é só a do código. Qualquer seção
// "Não encontrado" (ou variação óbvia) escrita pelo subagente sai, com ou sem
// Critério; o resto da Síntese fica intacto.
test("seção \"Não encontrado\" inventada pelo subagente sai quando a Categoria foi lida", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r(CASE, "Case"), r(BENCH, "Bench"), r("https://issue.test/1")])],
    pages: { [CASE]: page("a"), [BENCH]: page("b"), "https://issue.test/1": page("c") },
    classifier: fakeClassifier({
      [CASE]: { category: "relato-producao" }, [BENCH]: { category: "benchmark" }, "https://issue.test/1": { category: "issue" },
    }),
    script: [
      turn.search("bun"), turn.fetch(CASE), turn.fetch(BENCH), turn.fetch("https://issue.test/1"),
      turn.text(`Síntese.\n\n## Não encontrado\n- benchmark: nada achado\n\nConclusão final.\n\nFontes\n- ${CASE}`),
    ],
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", depth: "deep", criteria });
    assert.equal(textOf(result), `Síntese.\n\nConclusão final.\n\nFontes\n- ${CASE} [relato-producao · blog]`);
  }));

test("lacuna do subagente é trocada pela do código, sem duplicar", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r(CASE, "Case"), r(BENCH, "Bench")])],
    pages: { [CASE]: page("a"), [BENCH]: page("b") },
    classifier: searchJudge,
    script: [
      turn.search("bun"), turn.fetch(CASE), turn.fetch(BENCH),
      turn.text(`Síntese.\n\nFontes\n- ${CASE}\n\n**Não encontrados:**\n- benchmark\n- marketing`),
    ],
  }, async (h) => {
    const result = await h.run({ goal: "Bun em produção", depth: "deep", criteria });
    const text = textOf(result);
    assert.equal(text.match(/encontrad/gi).length, 1);
    assert.match(text, /\[relato-producao · fórum\]\n\nNão encontrado\n- issue: bugs abertos no rastreador$/);
  }));

test("sem Critério, \"Não encontrado\"/Lacunas escritas pelo subagente saem", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://docs.bun.test/guia", "Guia")])],
    pages: { "https://docs.bun.test/guia": page("Bun em produção.") },
    script: [
      turn.search("produção"), turn.fetch("https://docs.bun.test/guia"),
      turn.text("Síntese.\n\nLacunas: nada sobre benchmark.\n- sem números\n\nFontes\n- https://docs.bun.test/guia\n\nNão encontrado\n- benchmark"),
    ],
  }, async (h) => {
    const result = await h.run({ goal: "Usar em produção" });
    assert.equal(textOf(result), "Síntese.\n\nFontes\n- https://docs.bun.test/guia [docs]");
  }));
