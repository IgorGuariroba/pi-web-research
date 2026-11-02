// Fontes verificadas (#5): a seção "Fontes" da Síntese só aceita Fontes lidas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, r, textOf } from "./research-harness.mjs";

const MODEL = { provider: "fake-llm", id: "fake-model" };
const LIDA = "https://docs.exemplo.test/guia";
const NAO_LIDA = "https://blog.exemplo.test/opiniao";
const pages = { [LIDA]: "<html><body><p>A resposta é 42.</p></body></html>" };
const provider = () => fakeProvider("tavily", [r(LIDA, "Guia"), r(NAO_LIDA, "Opinião")]);

const lastUserText = (body) => {
  const user = [...body.messages].reverse().find((m) => m.role === "user");
  return typeof user.content === "string" ? user.content : user.content.map((p) => p.text ?? "").join("");
};

test("fontes: Síntese citando só Fontes lidas passa intacta", async () => {
  const sintese = `A resposta é 42.\n\nFontes\n- ${LIDA}`;
  const h = await setupResearch({
    providers: [provider()], pages, modelRef: MODEL,
    script: [turn.search("resposta"), turn.fetch(LIDA), turn.text(sintese)],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    assert.equal(textOf(result), `${sintese} [docs]`);
    assert.equal(h.llm.requests.length, 3, "não deve pedir correção");
    assert.deepEqual(result.details.removedCitations, []);
    assert.equal(result.details.sourcesRead, 1);
    assert.equal(result.details.unverified, undefined);
  } finally {
    await h.cleanup();
  }
});

test("fontes: citação não lida dispara um pedido de correção e a Síntese corrigida é devolvida", async () => {
  const corrigida = `A resposta é 42.\n\nFontes\n- ${LIDA}`;
  const h = await setupResearch({
    providers: [provider()], pages, modelRef: MODEL,
    script: (body, i) => [
      turn.search("resposta"),
      turn.fetch(LIDA),
      turn.text(`A resposta é 42.\n\nFontes\n- ${LIDA}\n- ${NAO_LIDA}`),
      lastUserText(body).includes(NAO_LIDA) ? turn.text(corrigida) : turn.text("sem pedido de correção"),
    ][i],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    assert.equal(h.llm.requests.length, 4, "uma única correção");
    assert.equal(textOf(result), `${corrigida} [docs]`);
    assert.deepEqual(result.details.removedCitations, []);
    assert.equal(result.details.sourcesRead, 1);
  } finally {
    await h.cleanup();
  }
});

test("fontes: se o subagente insistir, a URL não lida é removida de \"Fontes\"", async () => {
  const insistente = `A resposta é 42.\n\nFontes\n- ${LIDA}\n- [Opinião](${NAO_LIDA})`;
  const h = await setupResearch({
    providers: [provider()], pages, modelRef: MODEL,
    script: [turn.search("resposta"), turn.fetch(LIDA), turn.text(insistente), turn.text(insistente)],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    assert.equal(h.llm.requests.length, 4, "uma única correção");
    assert.equal(textOf(result), `A resposta é 42.\n\nFontes\n- ${LIDA} [docs]`);
    assert.deepEqual(result.details.removedCitations, [NAO_LIDA]);
    assert.equal(result.details.sourcesRead, 1);
  } finally {
    await h.cleanup();
  }
});

test("fontes: sem nenhuma Fonte lida, a Síntese vem com aviso de Síntese não verificada", async () => {
  const h = await setupResearch({
    providers: [provider()], pages, modelRef: MODEL,
    script: [turn.search("resposta"), turn.text("A resposta parece ser 42.")],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    const text = textOf(result);
    assert.match(text, /^\[Síntese não verificada[^\]]*nenhuma Fonte lida[^\]]*\]/);
    assert.match(text, /A resposta parece ser 42\.$/);
    assert.equal(result.details.sourcesRead, 0);
    assert.equal(result.details.unverified, true);
  } finally {
    await h.cleanup();
  }
});

test("fontes: sem Fonte lida e citações insistentes, \"Fontes\" some e o aviso permanece", async () => {
  const insistente = `A resposta parece ser 42.\n\n## Fontes\n- ${NAO_LIDA}`;
  const h = await setupResearch({
    providers: [provider()], pages, modelRef: MODEL,
    script: [turn.search("resposta"), turn.text(insistente), turn.text(insistente)],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    const text = textOf(result);
    assert.match(text, /^\[Síntese não verificada/);
    assert.doesNotMatch(text, /Fontes|opiniao/);
    assert.deepEqual(result.details.removedCitations, [NAO_LIDA]);
    assert.equal(result.details.unverified, true);
  } finally {
    await h.cleanup();
  }
});

test("fontes: citação que difere da Fonte lida só em www./barra final/fragmento conta como lida", async () => {
  const sintese = `A resposta é 42.\n\nFontes\n- http://www.docs.exemplo.test/guia/#topo`;
  const h = await setupResearch({
    providers: [provider()], pages, modelRef: MODEL,
    script: [turn.fetch(LIDA), turn.text(sintese)],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    assert.equal(textOf(result), `${sintese} [docs]`);
    assert.equal(h.llm.requests.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("fontes: leitura que falhou (404) não é Fonte lida", async () => {
  const quebrada = "https://docs.exemplo.test/sumiu";
  const citando = `A resposta é 42.\n\nFontes\n- ${LIDA}\n- ${quebrada}`;
  const h = await setupResearch({
    providers: [provider()], pages, modelRef: MODEL,
    script: [turn.fetch(LIDA), turn.fetch(quebrada), turn.text(citando), turn.text(citando)],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    assert.equal(result.details.sourcesRead, 1);
    assert.deepEqual(result.details.removedCitations, [quebrada]);
    assert.equal(textOf(result), `A resposta é 42.\n\nFontes\n- ${LIDA} [docs]`);
  } finally {
    await h.cleanup();
  }
});

// Review Codex (P2): URLs com parênteses balanceados (ex. Wikipedia) são citações
// inteiras, nuas ou em link Markdown; delimitadores em volta não entram na URL.
const WIKI = "https://en.wikipedia.org/wiki/Node.js_(runtime)";
for (const [name, line] of [
  ["nua", `- ${WIKI}`],
  ["nua com pontuação final", `- ${WIKI}.`],
  ["entre parênteses", `- Node (${WIKI})`],
  ["em link Markdown", `- [Node.js](${WIKI})`],
  ["entre <>", `- <${WIKI}>`],
]) {
  test(`fontes: URL com parênteses ${name} é reconhecida como Fonte lida`, async () => {
    const h = await setupResearch({
      modelRef: MODEL, providers: [fakeProvider("tavily", [])],
      pages: { [WIKI]: "<html><body><p>Node.js é um runtime.</p></body></html>" },
      script: [turn.fetch(WIKI), turn.text(`Síntese.\n\nFontes\n${line}`), turn.text("não deveria haver correção")],
    });
    try {
      const result = await h.run({ goal: "Node.js runtime" });
      assert.deepEqual(result.details.removedCitations, []);
      assert.equal(h.llm.requests.length, 2);
      assert.equal(textOf(result), `Síntese.\n\nFontes\n${line} [blog]`);
    } finally {
      await h.cleanup();
    }
  });
}

// Caso real: modelo fraco (mistral-nemo) respondeu sem chamar nenhuma tool,
// inventando modelos e preços; a Síntese não verificada chegava ao Agente pai.
test("sem pesquisa: subagente que responde sem buscar nem ler recebe um pedido para pesquisar", async () => {
  const sintese = `A resposta é 42.\n\nFontes\n- ${LIDA}`;
  const h = await setupResearch({
    providers: [provider()], pages, modelRef: MODEL,
    script: (body, i) => [
      turn.text("Inventei: a resposta é 7."),
      /web_search/.test(lastUserText(body)) ? turn.search("resposta") : turn.text("sem pedido para pesquisar"),
      turn.fetch(LIDA),
      turn.text(sintese),
    ][i],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    assert.equal(textOf(result), `${sintese} [docs]`);
    assert.equal(result.details.sourcesRead, 1);
    assert.equal(result.details.fallback, undefined);
  } finally {
    await h.cleanup();
  }
});

test("sem pesquisa: subagente que insiste em não pesquisar cai no Fallback cru, sem a resposta inventada", async () => {
  const tavily = provider();
  const h = await setupResearch({
    providers: [tavily], pages, modelRef: MODEL,
    script: [turn.text("Inventei: a resposta é 7."), turn.text("Inventei de novo: 7.")],
  });
  try {
    const result = await h.run({ goal: "Descobrir a resposta" });
    const text = textOf(result);
    assert.match(text, /^\[Fallback sem síntese — o subagente falhou: .*não chamou web_search nem fetch_url/);
    assert.doesNotMatch(text, /Inventei/);
    assert.match(text, /docs\.exemplo\.test\/guia/);
    assert.deepEqual(tavily.calls, ["Descobrir a resposta"]);
    assert.equal(result.details.fallback, true);
    assert.equal(h.llm.requests.length, 2, "um único pedido para pesquisar");
  } finally {
    await h.cleanup();
  }
});

// Página montada só por JavaScript: o HTML não traz nada além do título. Antes
// contava como Fonte lida, e a Síntese se apoiava em snippets atribuídos a ela.
const VAZIA = "https://app.exemplo.test/precos";
const SPA = "<html><head><title>Preços | App</title><script>boot()</script></head><body><div id=\"root\"></div><script src=\"/app.js\"></script></body></html>";

test("fontes: página sem conteúdo além do título não é Fonte lida e o subagente é avisado", async () => {
  const citando = `O preço é 7.\n\nFontes\n- ${VAZIA}`;
  const h = await setupResearch({
    providers: [fakeProvider("tavily", [r(VAZIA, "Preços")])], pages: { [VAZIA]: SPA }, modelRef: MODEL,
    script: [turn.search("preços"), turn.fetch(VAZIA), turn.text(citando), turn.text(citando)],
  });
  try {
    const result = await h.run({ goal: "Descobrir o preço" });
    assert.match(h.llm.toolResults()[1], /^URL final: https:\/\/app\.exemplo\.test\/precos\n\nPágina descartada: sem conteúdo extraível/);
    assert.equal(result.details.sourcesRead, 0);
    assert.equal(result.details.unverified, true);
    assert.deepEqual(result.details.removedCitations, [VAZIA]);
    assert.deepEqual(result.details.discardedReads, [{ url: VAZIA, reason: "sem conteúdo" }]);
  } finally {
    await h.cleanup();
  }
});

test("fontes: página curta com conteúdo além do título continua sendo Fonte lida", async () => {
  const h = await setupResearch({
    providers: [fakeProvider("tavily", [r(VAZIA, "Preços")])],
    pages: { [VAZIA]: "<html><head><title>Preços | App</title></head><body><p>Plano único: R$ 7.</p></body></html>" }, modelRef: MODEL,
    script: [turn.search("preços"), turn.fetch(VAZIA), turn.text(`O preço é R$ 7.\n\nFontes\n- ${VAZIA}`)],
  });
  try {
    const result = await h.run({ goal: "Descobrir o preço" });
    assert.equal(result.details.sourcesRead, 1);
    assert.match(h.llm.toolResults()[1], /Plano único: R\$ 7\./);
  } finally {
    await h.cleanup();
  }
});
