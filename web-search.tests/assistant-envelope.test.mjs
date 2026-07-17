// Categoria: extractAssistantText — extrai texto da última mensagem assistant
// do envelope JSON do `goose run --output-format json` ({ messages, metadata }).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAssistantText } from "../goose-adapter.ts";

const ARR = '[{"title":"A","url":"https://a.com","summary":"s"}]';

function env(messages, metadata) {
  return JSON.stringify({ messages, metadata: metadata ?? {} });
}

test("envelope: última assistant contem o texto útil", () => {
  const t = extractAssistantText(env([
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "text", text: ARR }] },
  ]));
  assert.equal(t, ARR);
});

test("envelope: várias assistants → pega a última", () => {
  const t = extractAssistantText(env([
    { role: "assistant", content: [{ type: "text", text: "thinking..." }] },
    { role: "user", content: [{ type: "text", text: "resp" }] },
    { role: "assistant", content: [{ type: "text", text: ARR }] },
  ]));
  assert.equal(t, ARR);
});

test("envelope: sem nenhuma assistant → string vazia", () => {
  const t = extractAssistantText(env([
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]));
  assert.equal(t, "");
});

test("envelope: assistant com múltiplos blocos text → join por newline", () => {
  const t = extractAssistantText(env([
    { role: "assistant", content: [
      { type: "text", text: "part1 " },
      { type: "tool_request", id: "x" },
      { type: "text", text: "part2" },
    ] },
  ]));
  assert.equal(t, "part1 \npart2");
});

test("envelope: última assistant só com tool_request (sem text) → vazio", () => {
  const t = extractAssistantText(env([
    { role: "assistant", content: [{ type: "text", text: ARR }] },
    { role: "assistant", content: [{ type: "tool_request", id: "y" }] },
  ]));
  assert.equal(t, "");
});

test("envelope: stdout não-JSON (erro fatal do goose) → devolve texto cru", () => {
  const raw = "Error: GOOSE_PROVIDER not set\nRun goose configure";
  assert.equal(extractAssistantText(raw), raw.trim());
});

test("envelope: metadata presente é ignorada (só messages importa)", () => {
  const t = extractAssistantText(env(
    [{ role: "assistant", content: [{ type: "text", text: ARR }] }],
    { total_tokens: 1234, status: "completed" },
  ));
  assert.equal(t, ARR);
});

test("envelope: messages vazio → vazio", () => {
  assert.equal(extractAssistantText(env([])), "");
});

test("envelope: sem messages → vazio", () => {
  assert.equal(extractAssistantText(JSON.stringify({ metadata: {} })), "");
});

test("envelope: assistant com content não-array → vazio", () => {
  assert.equal(extractAssistantText(env([
    { role: "assistant", content: "not-an-array" },
  ])), "");
});
