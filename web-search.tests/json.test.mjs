// Categoria: JSON válido em vários formatos (puro, sem markdown/prosa).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults } from "../goose-adapter.ts";

test("json: array minificado, 1 elemento", () => {
  const r = parseResults('[{"title":"A","url":"https://a.com","summary":"s"}]');
  assert.deepEqual(r, [{ title: "A", url: "https://a.com", summary: "s" }]);
});

test("json: array pretty-multiline", () => {
  const r = parseResults(`[
    {"title":"A","url":"https://a.com","summary":"sa"},
    {"title":"B","url":"https://b.com","summary":"sb"}
  ]`);
  assert.equal(r.length, 2);
  assert.equal(r[1].url, "https://b.com");
});

test("json: campos vazios preservados quando url existe", () => {
  const r = parseResults('[{"title":"","url":"https://a.com","summary":""}]');
  assert.deepEqual(r, [{ title: "", url: "https://a.com", summary: "" }]);
});

test("json: unicode/acentos no título e summary", () => {
  const r = parseResults('[{"title":"São João","url":"https://ex.com","summary":"ação — êníx"}]');
  assert.equal(r[0].title, "São João");
  assert.equal(r[0].summary, "ação — êníx");
});

test("json: url com query string e fragmento", () => {
  const r = parseResults('[{"title":"T","url":"https://ex.com/a?b=1&c=2#frag","summary":"s"}]');
  assert.equal(r[0].url, "https://ex.com/a?b=1&c=2#frag");
});

test("json: campos extras além de title/url/summary são ignorados", () => {
  const r = parseResults(
    '[{"title":"T","url":"https://a.com","summary":"s","extra":1,"nested":{"x":2}}]',
  );
  assert.deepEqual(r, [{ title: "T", url: "https://a.com", summary: "s" }]);
});

test("json: espaços/whitespace ao redor são tolerados", () => {
  const r = parseResults('   \n [{"title":"T","url":"https://a.com","summary":"s"}] \n  ');
  assert.equal(r.length, 1);
});

test("json: 5 elementos (volume típico do prompt)", () => {
  const arr = Array.from({ length: 5 }, (_, i) => ({
    title: `T${i}`,
    url: `https://x${i}.com`,
    summary: `s${i}`,
  }));
  const r = parseResults(JSON.stringify(arr));
  assert.equal(r.length, 5);
  assert.equal(r[4].url, "https://x4.com");
});
