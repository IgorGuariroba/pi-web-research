// Categoria: JSON dentro de markdown / code fences (o caso mais comum de LLM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults } from "../goose-adapter.ts";

const A = '[{"title":"A","url":"https://a.com","summary":"s"}]';

test("markdown: fence ```json", () => {
  const r = parseResults("Results:\n```json\n" + A + "\n```\nDone.");
  assert.equal(r.length, 1);
  assert.equal(r[0].title, "A");
});

test("markdown: fence sem linguagem (```)", () => {
  const r = parseResults("```\n" + A + "\n```");
  assert.equal(r.length, 1);
});

test("markdown: fence com linguagem 'errada' (javascript) ainda é tentada", () => {
  const r = parseResults("```javascript\n" + A + "\n```");
  assert.equal(r.length, 1);
});

test("markdown: prosa antes e depois da fence", () => {
  const r = parseResults("Sure! Here:\n```json\n" + A + "\n```\nHope it helps!");
  assert.equal(r.length, 1);
});

test("markdown: fence indentada dentro de lista", () => {
  const r = parseResults("- Results:\n\n  ```json\n  " + A + "\n  ```\n");
  assert.equal(r.length, 1);
});

test("markdown: array solto em prosa (sem nenhuma fence)", () => {
  const r = parseResults("Results: " + A + " done.");
  assert.equal(r.length, 1);
});

test("markdown: texto com links [text](url) mas SEM array JSON → vazio", () => {
  const r = parseResults("Veja [OKF](https://okf.md/) e [docs](https://x.com).");
  assert.equal(r.length, 0);
});

test("markdown: primeira fence inválida + array solto depois → pega array (fallback)", () => {
  // A 1ª fence tem JSON inválido; o parser cai no fallback de bracket e acha o array solto.
  const r = parseResults("```json\n{not valid\n```\nThen: " + A);
  assert.equal(r.length, 1);
});
