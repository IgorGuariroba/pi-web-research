// Categoria: parseResultsDetailed — qual estratégia de parse funcionou + warnings.
// Importante para telemetria: saber se usou JSON direto ou caiu em fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults, parseResultsDetailed } from "../goose-adapter.ts";

const A = '[{"title":"A","url":"https://a.com","summary":"s"}]';

test("strategy: JSON puro → strategy 'json', sem warnings", () => {
  const d = parseResultsDetailed(A);
  assert.equal(d.strategy, "json");
  assert.equal(d.warnings.length, 0);
  assert.equal(d.results.length, 1);
});

test("strategy: JSON pretty-multiline → 'json' (não é fallback)", () => {
  const d = parseResultsDetailed('[\n  {"title":"A","url":"https://a.com","summary":"s"}\n]');
  assert.equal(d.strategy, "json");
  assert.equal(d.warnings.length, 0);
});

test("strategy: code fence ```json → 'markdown' + warning de fallback", () => {
  const d = parseResultsDetailed("Results:\n```json\n" + A + "\n```");
  assert.equal(d.strategy, "markdown");
  assert.equal(d.results.length, 1);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /fallback/i);
});

test("strategy: fence sem linguagem → 'markdown'", () => {
  const d = parseResultsDetailed("```\n" + A + "\n```");
  assert.equal(d.strategy, "markdown");
});

test("strategy: array solto em prosa (sem fence) → 'bracket' + warning", () => {
  const d = parseResultsDetailed("Results: " + A + " done.");
  assert.equal(d.strategy, "bracket");
  assert.equal(d.results.length, 1);
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /fallback/i);
});

test("strategy: texto sem array → 'none', sem warnings (provider decide raw)", () => {
  const d = parseResultsDetailed("Sorry, couldn't find anything.");
  assert.equal(d.strategy, "none");
  assert.equal(d.results.length, 0);
  assert.equal(d.warnings.length, 0);
});

test("strategy: string vazia → 'none'", () => {
  assert.equal(parseResultsDetailed("").strategy, "none");
});

test("strategy: primeira fence inválida → cai em 'bracket' (fallback encadeado)", () => {
  // 1ª fence tem JSON inválido; parser tenta fence (falha), depois bracket acha o array.
  const d = parseResultsDetailed("```json\n{invalid\n```\nThen: " + A);
  assert.equal(d.strategy, "bracket");
  assert.equal(d.results.length, 1);
});

test("strategy: results sempre consistente com parseResults (API simples)", () => {
  const text = "```json\n" + A + "\n```";
  const detailed = parseResultsDetailed(text);
  const simple = parseResults(text);
  assert.deepEqual(detailed.results, simple);
});
