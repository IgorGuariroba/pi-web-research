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
