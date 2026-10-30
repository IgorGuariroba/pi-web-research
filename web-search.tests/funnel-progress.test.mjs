// Linha final do Funil na TUI (ticket #11), exercitada pelo núcleo de Research.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, r } from "./research-harness.mjs";

test("ao fim da pesquisa o progresso mostra o Funil completo: resultados → após descarte → lidos", async () => {
  const h = await setupResearch({
    providers: [
      fakeProvider("tavily", [r("https://a.test/1", "A"), r("https://b.test/2", "B"), r("https://www.pinterest.com/pin/1", "Pin")]),
      fakeProvider("exa", [r("https://a.test/1", "A"), r("https://c.test/3", "C")]),
    ],
    pages: {
      "https://a.test/1": "<html><body><p>Conteúdo A sobre o tema.</p></body></html>",
      "https://c.test/3": "<html><body><p>Conteúdo C sobre o tema.</p></body></html>",
    },
    modelRef: { provider: "fake-llm", id: "fake-model" },
    script: [
      turn.search("tema"),
      turn.fetch("https://a.test/1"),
      turn.fetch("https://c.test/3"),
      turn.text("Síntese.\n\nFontes\n- https://a.test/1\n- https://c.test/3"),
    ],
  });
  try {
    await h.run({ goal: "Tema" });
    // 5 encontrados, 4 únicos, 1 spam → 3 após descarte; 2 páginas lidas.
    assert.equal(h.progress.at(-1), "5 resultados → 3 após descarte → 2 lidos");
  } finally {
    await h.cleanup();
  }
});
