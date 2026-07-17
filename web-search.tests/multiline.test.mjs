// Categoria: quebras de linha, CRLF, conteúdo multinha.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults } from "../goose-adapter.ts";

test("multiline: cada resultado numa linha (pretty)", () => {
  const r = parseResults('[\n  {"title":"A","url":"https://a.com","summary":"sa"},\n  {"title":"B","url":"https://b.com","summary":"sb"}\n]');
  assert.equal(r.length, 2);
});

test("multiline: summary com \\n escapado dentro da string", () => {
  const r = parseResults('[{"title":"A","url":"https://a.com","summary":"linha1\\nlinha2"}]');
  assert.equal(r[0].summary, "linha1\nlinha2");
});

test("multiline: title longo preservado integralmente", () => {
  const long = "T".repeat(300);
  const r = parseResults('[{"title":"' + long + '","url":"https://a.com","summary":"s"}]');
  assert.equal(r[0].title.length, 300);
});

test("multiline: quebras CRLF (Windows) toleradas", () => {
  const r = parseResults('[\r\n  {"title":"A","url":"https://a.com","summary":"sa"},\r\n  {"title":"B","url":"https://b.com","summary":"sb"}\r\n]');
  assert.equal(r.length, 2);
});

test("multiline: trailing newlines/whitespace ao redor", () => {
  const r = parseResults("\n\n\n" + '[{"title":"A","url":"https://a.com","summary":"s"}]' + "\n\n\n");
  assert.equal(r.length, 1);
});

test("multiline: fence grande multiline com 3 resultados", () => {
  const r = parseResults("```json\n[\n  {\"title\":\"A\",\"url\":\"https://a.com\",\"summary\":\"sa\"},\n  {\"title\":\"B\",\"url\":\"https://b.com\",\"summary\":\"sb\"},\n  {\"title\":\"C\",\"url\":\"https://c.com\",\"summary\":\"sc\"}\n]\n```");
  assert.equal(r.length, 3);
});
