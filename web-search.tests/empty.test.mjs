// Categoria: entradas vazias / nulas / "nenhum resultado".
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults } from "../goose-adapter.ts";

test("empty: string vazia → vazio", () => {
  assert.equal(parseResults("").length, 0);
});

test("empty: só whitespace → vazio", () => {
  assert.equal(parseResults("   \n\t  \r\n  ").length, 0);
});

test("empty: array vazio '[]' → vazio", () => {
  assert.equal(parseResults("[]").length, 0);
});

test("empty: array com objeto vazio (sem url) → filtrado → vazio", () => {
  assert.equal(parseResults("[{}]").length, 0);
});

test("empty: prosa 'No results found.' → vazio", () => {
  assert.equal(parseResults("No results found.").length, 0);
});

test("empty: null como string → vazio (não lança)", () => {
  // JSON.parse("null") = null, não é array → []
  assert.equal(parseResults("null").length, 0);
});
