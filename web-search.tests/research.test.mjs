import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResearchPrompt } from "../research.ts";

// Orçamentos de Depth são verificados pelo núcleo (research-core.test.mjs).

test("prompt: quick inclui goal, focus e orçamento curto", () => {
  const prompt = buildResearchPrompt("Descobrir X", "Somente Y", "quick");
  assert.match(prompt, /Descobrir X/);
  assert.match(prompt, /Somente Y/);
  assert.match(prompt, /no máximo 3 buscas e 4 leituras/i);
});

test("prompt: deep permite investigação iterativa e exige fontes", () => {
  const prompt = buildResearchPrompt("Descobrir X", undefined, "deep");
  assert.match(prompt, /no máximo 12 buscas e 15 leituras/i);
  assert.match(prompt, /URLs/i);
});

// Casos reais: modelo respondeu de memória sem buscar; preços de snippets foram
// atribuídos a modelos errados; páginas de lista ("mais usados") viraram "mais baratos".
test("prompt: manda começar pela busca e não responder de memória", () => {
  assert.match(buildResearchPrompt("Descobrir X", undefined, "quick"), /Comece chamando web_search; não responda de memória\./);
});

test("prompt: valores e nomes só das páginas lidas, nunca de snippets", () => {
  const prompt = buildResearchPrompt("Descobrir X", undefined, "quick");
  assert.match(prompt, /Números, preços, versões e nomes só podem vir do conteúdo de páginas lidas com fetch_url; snippets de busca servem apenas para escolher o que ler\./);
  assert.match(prompt, /Se um dado não estiver nas páginas lidas, diga que não foi encontrado em vez de estimar\./);
});

test("prompt: para listas e comparações prefere dados estruturados oficiais e declara o escopo da fonte", () => {
  assert.match(buildResearchPrompt("Descobrir X", undefined, "deep"),
    /Para listas, preços e comparações, prefira dados estruturados oficiais \(API pública, JSON, tabela de preços\) e diga o escopo da fonte \(ex\.: só os mais usados\)\./);
});
