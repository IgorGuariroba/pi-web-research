import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResearchPrompt, createResearchBudget } from "../research.ts";

test("prompt: quick inclui goal, focus e orçamento curto", () => {
  const prompt = buildResearchPrompt("Descobrir X", "Somente Y", "quick");
  assert.match(prompt, /Descobrir X/);
  assert.match(prompt, /Somente Y/);
  assert.match(prompt, /no máximo 2 buscas/i);
});

test("prompt: deep permite investigação iterativa e exige fontes", () => {
  const prompt = buildResearchPrompt("Descobrir X", undefined, "deep");
  assert.match(prompt, /no máximo 8 buscas/i);
  assert.match(prompt, /URLs/i);
});

test("budget: quick permite duas buscas e bloqueia a terceira", () => {
  const budget = createResearchBudget("quick");
  assert.equal(budget.consumeSearch(), true);
  assert.equal(budget.consumeSearch(), true);
  assert.equal(budget.consumeSearch(), false);
});

test("budget: deep limita buscas e fetches", () => {
  const budget = createResearchBudget("deep");
  for (let i = 0; i < 8; i++) assert.equal(budget.consumeSearch(), true);
  assert.equal(budget.consumeSearch(), false);
  for (let i = 0; i < 8; i++) assert.equal(budget.consumeFetch(), true);
  assert.equal(budget.consumeFetch(), false);
});
