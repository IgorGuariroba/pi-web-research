// Categoria: JSON malformado / inválido. O parser nunca lança — devolve [].
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults } from "../goose-adapter.ts";

test("malformed: array truncado (sem fechar ]) → vazio", () => {
  const r = parseResults('[{"title":"A","url":"https://a.com","summary":"s"}');
  assert.equal(r.length, 0);
});

test("malformed: falta vírgula entre elementos → vazio (parse falha)", () => {
  const r = parseResults(
    '[{"title":"A","url":"https://a.com","summary":"sa"}{"title":"B","url":"https://b.com","summary":"sb"}]',
  );
  assert.equal(r.length, 0);
});

test("malformed: aspas simples (não é JSON) → vazio", () => {
  const r = parseResults("[{'title':'A','url':'https://a.com','summary':'s'}]");
  assert.equal(r.length, 0);
});

test("malformed: objeto em vez de array → vazio", () => {
  const r = parseResults('{"title":"A","url":"https://a.com","summary":"s"}');
  assert.equal(r.length, 0);
});

test("malformed: array de strings (não de objetos) → vazio", () => {
  const r = parseResults('["https://a.com","https://b.com"]');
  assert.equal(r.length, 0);
});

test("malformed: array válido mas todo elemento sem url → vazio", () => {
  const r = parseResults('[{"title":"A","summary":"s"},{"title":"B","summary":"s"}]');
  assert.equal(r.length, 0);
});

test("malformed: texto aleatório sem colchetes → vazio", () => {
  const r = parseResults("Sorry, I couldn't find anything relevant right now.");
  assert.equal(r.length, 0);
});

test("malformed: colchete isolado '[' sem ']' → vazio", () => {
  const r = parseResults("oops [ something happened");
  assert.equal(r.length, 0);
});
