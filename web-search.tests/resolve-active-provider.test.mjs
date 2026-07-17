// Categoria: resolveActiveProvider — lógica de resolução do provider no boot.
// Regras:
//   1) activeProvider === "exa" e há chave exa → ExaProvider
//   2) activeProvider === "goose" → GooseBuiltinProvider
//   3) há chave tavily → TavilyProvider (default)
//   4) há chave exa → ExaProvider
//   5) → GooseBuiltinProvider
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveProvider } from "../resolve-provider.ts";

// Mock do pi.exec
const mockExec = async () => ({ stdout: "{}", stderr: "", code: 0 });
const pi = { exec: mockExec };

test("resolveActive: exa preferido com chave exa", () => {
  const p = resolveActiveProvider("exa", undefined, "exa-key", pi);
  assert.equal(p.name, "exa");
});

test("resolveActive: exa preferido sem chave → cai para proximo", () => {
  // activeProvider=exa mas sem chave exa → não 1)
  // sem tavily → não 3)
  // sem exa → não 4)
  // → goose 5)
  const p = resolveActiveProvider("exa", undefined, undefined, pi);
  assert.equal(p.name, "goose:computercontroller");
});

test("resolveActive: goose explícito → GooseBuiltinProvider", () => {
  const p = resolveActiveProvider("goose", "tvly-key", "exa-key", pi);
  assert.equal(p.name, "goose:computercontroller");
});

test("resolveActive: default — tavily com chave", () => {
  const p = resolveActiveProvider(undefined, "tvly-key", "exa-key", pi);
  assert.equal(p.name, "tavily");
});

test("resolveActive: sem tavily, com exa → ExaProvider", () => {
  const p = resolveActiveProvider(undefined, undefined, "exa-key", pi);
  assert.equal(p.name, "exa");
});

test("resolveActive: sem nenhuma chave → GooseBuiltinProvider", () => {
  const p = resolveActiveProvider(undefined, undefined, undefined, pi);
  assert.equal(p.name, "goose:computercontroller");
});

test("resolveActive: activeProvider=tavily com chave tavily → TavilyProvider", () => {
  const p = resolveActiveProvider("tavily", "tvly-key", undefined, pi);
  // "tavily" não é "exa" nem "goose", cai para default: tavily se há chave
  assert.equal(p.name, "tavily");
});

test("resolveActive: activeProvider=tavily sem chave tavily, com exa → ExaProvider", () => {
  const p = resolveActiveProvider("tavily", undefined, "exa-key", pi);
  // "tavily" não é exa/goose, cai para default: sem tavily, com exa
  assert.equal(p.name, "exa");
});
