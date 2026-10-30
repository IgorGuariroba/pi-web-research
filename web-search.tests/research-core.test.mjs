// Núcleo de Research: comportamento externo (Síntese + details) com dublês
// nas fronteiras (LLM roteirizado, Providers, páginas via porta de fetch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, r, textOf } from "./research-harness.mjs";

test("núcleo: roteiro buscar → ler → sintetizar devolve a Síntese do subagente", async () => {
  const tavily = fakeProvider("tavily", [r("https://docs.exemplo.test/guia", "Guia", "Guia oficial")]);
  const h = await setupResearch({
    providers: [tavily],
    pages: { "https://docs.exemplo.test/guia": "<html><body><h1>Guia</h1><p>A resposta é 42.</p></body></html>" },
    modelRef: { provider: "fake-llm", id: "fake-model" },
    script: [
      turn.search("qual a resposta"),
      turn.fetch("https://docs.exemplo.test/guia"),
      turn.text("A resposta é 42.\n\nFontes\n- https://docs.exemplo.test/guia"),
    ],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta", depth: "quick" });
    assert.match(textOf(result), /A resposta é 42\./);
    assert.equal(result.details.synthesized, true);
    assert.equal(result.details.depth, "quick");
    assert.deepEqual(tavily.calls, ["qual a resposta"]);
    const [searchResult, pageResult] = h.llm.toolResults();
    assert.match(searchResult, /https:\/\/docs\.exemplo\.test\/guia/);
    assert.match(pageResult, /A resposta é 42/);
  } finally {
    await h.cleanup();
  }
});

test("núcleo: subagente falhando cai no Fallback cru com os resultados do Provider", async () => {
  const tavily = fakeProvider("tavily", [r("https://a.test/1", "Um", "primeiro"), r("https://b.test/2", "Dois", "segundo")]);
  const h = await setupResearch({
    providers: [tavily],
    modelRef: { provider: "fake-llm", id: "fake-model" },
    script: [turn.error(400, "modelo quebrado")],
  });
  try {
    const result = await h.run({ goal: "Descobrir X" });
    const text = textOf(result);
    assert.match(text, /^\[Fallback sem síntese — o subagente falhou: /);
    assert.match(text, /1\. Um\n   https:\/\/a\.test\/1\n   primeiro/);
    assert.match(text, /2\. Dois\n   https:\/\/b\.test\/2/);
    assert.deepEqual(tavily.calls, ["Descobrir X"]);
    assert.equal(result.details.fallback, true);
    assert.equal(result.details.provider, "tavily");
    assert.equal(result.details.resultCount, 2);
    assert.equal(result.details.synthesized, undefined);
  } finally {
    await h.cleanup();
  }
});

test("modelo: o Modelo de pesquisa salvo é usado e aparece nos details", async () => {
  const h = await setupResearch({
    providers: [fakeProvider("tavily")],
    models: ["claude-haiku-4", "salvo-model"],
    modelRef: { provider: "fake-llm", id: "salvo-model" },
    script: [turn.text("ok")],
  });
  try {
    const result = await h.run({ goal: "X" });
    assert.deepEqual(h.llm.models(), ["salvo-model"]);
    assert.equal(result.details.researchModel, "fake-llm/salvo-model");
  } finally {
    await h.cleanup();
  }
});

for (const [models, expected] of [
  [["big-pro", "gpt-4o-mini", "gemini-2.5-flash", "claude-haiku-4"], "claude-haiku-4"],
  [["big-pro", "gpt-4o-mini", "gemini-2.5-flash"], "gemini-2.5-flash"],
  [["gemini-2.5-pro", "gpt-4o-mini"], "gpt-4o-mini"],
]) {
  test(`modelo: sem modelo salvo usa o barato preferido (${expected})`, async () => {
    const h = await setupResearch({
      providers: [fakeProvider("tavily")], models, parentModelId: models[0],
      script: [turn.text("ok")],
    });
    try {
      const result = await h.run({ goal: "X" });
      assert.deepEqual(h.llm.models(), [expected]);
      assert.equal(result.details.researchModel, `fake-llm/${expected}`);
    } finally {
      await h.cleanup();
    }
  });
}

test("modelo: sem modelo salvo nem barato disponível usa o modelo do Agente pai", async () => {
  const h = await setupResearch({
    providers: [fakeProvider("tavily")], models: ["aaa-pro", "pai-opus"], parentModelId: "pai-opus",
    script: [turn.text("ok")],
  });
  try {
    const result = await h.run({ goal: "X" });
    assert.deepEqual(h.llm.models(), ["pai-opus"]);
    assert.equal(result.details.researchModel, "fake-llm/pai-opus");
  } finally {
    await h.cleanup();
  }
});

test("modelo: modelo salvo que sumiu cai na preferência barata", async () => {
  const h = await setupResearch({
    providers: [fakeProvider("tavily")], models: ["big-pro", "claude-haiku-4"],
    modelRef: { provider: "fake-llm", id: "removido" },
    script: [turn.text("ok")],
  });
  try {
    await h.run({ goal: "X" });
    assert.deepEqual(h.llm.models(), ["claude-haiku-4"]);
  } finally {
    await h.cleanup();
  }
});

for (const [depth, searches, fetches] of [["quick", 3, 4], ["deep", 12, 15]]) {
  test(`orçamento: ${depth} permite ${searches} buscas e ${fetches} leituras e recusa as excedentes`, async () => {
    const tavily = fakeProvider("tavily", (q) => [r(`https://s.test/${encodeURIComponent(q)}`)]);
    const pages = {};
    for (let i = 0; i <= fetches; i++) pages[`https://p.test/${i}`] = `<p>página ${i}</p>`;
    const script = [
      ...Array.from({ length: searches + 1 }, (_, i) => turn.search(`q${i}`)),
      ...Array.from({ length: fetches + 1 }, (_, i) => turn.fetch(`https://p.test/${i}`)),
      turn.text("fim"),
    ];
    const h = await setupResearch({ providers: [tavily], pages, modelRef: { provider: "fake-llm", id: "fake-model" }, script });
    try {
      const result = await h.run({ goal: "X", depth });
      assert.equal(result.details.synthesized, true);
      assert.equal(tavily.calls.length, searches);
      assert.equal(h.pages.requests.length, fetches);
      const toolResults = h.llm.toolResults();
      assert.match(toolResults[searches], /Orçamento de buscas esgotado/);
      assert.match(toolResults.at(-1), /Orçamento de páginas esgotado/);
      assert.match(h.llm.userPrompt(), new RegExp(`no máximo ${searches} buscas e ${fetches} leituras`));
    } finally {
      await h.cleanup();
    }
  });
}
