// Categoria: gooseResponseFromText — montagem pura da SearchResponse + telemetry.
// Valida o contrato público (search-types.ts) sem I/O e sem goose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gooseResponseFromText } from "../goose-adapter.ts";

const PROVIDER = "goose:computercontroller";
const A = '[{"title":"A","url":"https://a.com","summary":"s"}]';

test("response: JSON válido → results com source preenchido", () => {
  const r = gooseResponseFromText(A, PROVIDER, 1234);
  assert.equal(r.provider, PROVIDER);
  assert.equal(r.durationMs, 1234);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].source, PROVIDER);
  assert.equal(r.results[0].url, "https://a.com");
});

test("response: strategy 'json' → em providerMeta.parseStrategy=json, parseFallback=false", () => {
  const r = gooseResponseFromText(A, PROVIDER, 0);
  const meta = r.telemetry.providerMeta;
  assert.equal(meta.parseStrategy, "json");
  assert.equal(meta.parseFallback, false);
  assert.equal(r.warnings.length, 0);
});

test("response: fence markdown → providerMeta.parseFallback=true + warning propagado", () => {
  const r = gooseResponseFromText("```json\n" + A + "\n```", PROVIDER, 0);
  const meta = r.telemetry.providerMeta;
  assert.equal(meta.parseStrategy, "markdown");
  assert.equal(meta.parseFallback, true);
  assert.ok(r.warnings.length >= 1);
  assert.equal(r.warnings, r.telemetry.warnings);
});

test("response: sem resultados mas COM texto → providerMeta.parseStrategy='raw'", () => {
  const r = gooseResponseFromText("Goose respondeu algo sem array JSON.", PROVIDER, 50);
  assert.equal(r.results.length, 0);
  const meta = r.telemetry.providerMeta;
  assert.equal(meta.parseStrategy, "raw");
  assert.equal(meta.parseFallback, true);
  assert.equal(meta.rawAssistantText, "Goose respondeu algo sem array JSON.");
  assert.ok(r.warnings.some((w) => /raw/.test(w)));
});

test("response: texto vazio → providerMeta.parseStrategy='none'", () => {
  const r = gooseResponseFromText("", PROVIDER, 0);
  assert.equal(r.results.length, 0);
  assert.equal(r.telemetry.providerMeta.parseStrategy, "none");
  assert.equal(r.telemetry.providerMeta.parseFallback, true);
});

test("response: tokens opcionais em providerMeta quando passados", () => {
  const r = gooseResponseFromText(A, PROVIDER, 0, { total: 42, input: 10, output: 32 });
  assert.deepEqual(r.telemetry.providerMeta.tokens, { total: 42, input: 10, output: 32 });
});

test("response: tokens ausentes → providerMeta.tokens undefined", () => {
  const r = gooseResponseFromText(A, PROVIDER, 0);
  assert.equal(r.telemetry.providerMeta.tokens, undefined);
});

test("response: telemetry.provider bate com response.provider", () => {
  const r = gooseResponseFromText(A, PROVIDER, 99);
  assert.equal(r.telemetry.provider, r.provider);
  assert.equal(r.telemetry.durationMs, r.durationMs);
});

test("response: múltiplos resultados preservam ordem e source", () => {
  const arr = '[{"title":"A","url":"https://a.com","summary":"s"},{"title":"B","url":"https://b.com","summary":"s"}]';
  const r = gooseResponseFromText(arr, PROVIDER, 0);
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].title, "A");
  assert.equal(r.results[1].title, "B");
  assert.ok(r.results.every((x) => x.source === PROVIDER));
});

// ---- providerMeta (contrato de-Gooseado) ----

test("providerMeta: contém rawAssistantText, parseStrategy, parseFallback, tokens", () => {
  const r = gooseResponseFromText(A, PROVIDER, 0, { total: 99 });
  const meta = r.telemetry.providerMeta;
  assert.ok(meta);
  assert.equal(meta.rawAssistantText, A);
  assert.equal(meta.parseStrategy, "json");
  assert.equal(meta.parseFallback, false);
  assert.deepEqual(meta.tokens, { total: 99 });
});

test("providerMeta: strategy 'raw' quando texto sem array", () => {
  const r = gooseResponseFromText("Goose says: nothing structured here.", PROVIDER, 0);
  assert.equal(r.telemetry.providerMeta.parseStrategy, "raw");
  assert.equal(r.telemetry.providerMeta.parseFallback, true);
});
