// Categoria: buildSearchPrompt — contrato do prompt determinístico enviado ao
// goose. Mudanças aqui alteram o formato da saída; os testes travam o contrato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSearchPrompt } from "../goose-adapter.ts";

test("prompt: query inserida literalmente", () => {
  const p = buildSearchPrompt("Open Knowledge Format");
  assert.ok(p.includes("Search the web for: Open Knowledge Format"));
});

test("prompt: exige JSON array (sem prosa/fence)", () => {
  const p = buildSearchPrompt("x");
  assert.ok(p.includes("JSON array"));
  assert.ok(/no prose/i.test(p));
  assert.ok(/no code fences/i.test(p));
});

test("prompt: declara o schema {title,url,summary}", () => {
  const p = buildSearchPrompt("x");
  assert.ok(p.includes('"title"'));
  assert.ok(p.includes('"url"'));
  assert.ok(p.includes('"summary"'));
});

test("prompt: sem trailing newline (determinismo)", () => {
  const p = buildSearchPrompt("x");
  assert.equal(p.endsWith("\n"), false);
});

test("prompt: query com chars especiais é inserida sem escape extra", () => {
  const p = buildSearchPrompt('foo "bar" <baz>');
  assert.ok(p.includes('Search the web for: foo "bar" <baz>'));
});
