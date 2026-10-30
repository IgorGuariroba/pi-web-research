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
