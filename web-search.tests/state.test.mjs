// Categoria: state.json — storage próprio da extensão (chaves API, provider ativo).
// Trata o arquivo inteiro como secreto: permissões 0600, diretório-pai 0700.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadState, saveState, initSecureStateFile, resolveKey } from "../state.ts";

// Cada teste usa um diretório temporário isolado.
let tmpDir;
beforeEach(() => {
  tmpDir = join(tmpdir(), `ws-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---- Tipos e inicialização ----

test("state: shape — { activeProvider?, keys?: { tavily?, exa? } }", () => {
  const path = join(tmpDir, "state.json");
  initSecureStateFile(path);
  const state = loadState(path);
  assert.deepEqual(state, { activeProvider: undefined, keys: {} });
});

test("state: initSecureStateFile cria arquivo com permissão 0600", () => {
  const path = join(tmpDir, "state.json");
  initSecureStateFile(path);
  assert.ok(existsSync(path), "arquivo deve existir");
  const mode = statSync(path).mode;
  // mask octal: & 0o777
  const perms = mode & 0o777;
  assert.equal(perms, 0o600, `esperado 0600, got ${perms.toString(8)}`);
});

test("state: initSecureStateFile cria diretório-pai com permissão 0700", () => {
  const subdir = join(tmpDir, "subdir", "nested");
  const path = join(subdir, "state.json");
  initSecureStateFile(path);
  const dirMode = statSync(subdir).mode & 0o777;
  assert.equal(dirMode, 0o700, `esperado 0700, got ${dirMode.toString(8)}`);
});

test("state: initSecureStateFile é idempotente — não sobrescreve existente", () => {
  const path = join(tmpDir, "state.json");
  initSecureStateFile(path);
  // Escreve dados customizados
  saveState(path, { activeProvider: "exa", keys: { exa: "existing-key" } });
  // Chama init de novo
  initSecureStateFile(path);
  const state = loadState(path);
  assert.equal(state.activeProvider, "exa");
  assert.equal(state.keys.exa, "existing-key");
});

// ---- Leitura/escrita ----

test("state: saveState + loadState — grava e lê de volta", () => {
  const path = join(tmpDir, "state.json");
  saveState(path, {
    activeProvider: "tavily",
    researchModel: { provider: "zai", id: "glm-4.7" },
    keys: { tavily: "tvly-abc" },
  });
  const state = loadState(path);
  assert.equal(state.activeProvider, "tavily");
  assert.deepEqual(state.researchModel, { provider: "zai", id: "glm-4.7" });
  assert.equal(state.keys.tavily, "tvly-abc");
});

test("state: saveState mantém permissão 0600", () => {
  const path = join(tmpDir, "state.json");
  initSecureStateFile(path);
  saveState(path, { activeProvider: "exa", keys: { exa: "exa-123" } });
  const perms = statSync(path).mode & 0o777;
  assert.equal(perms, 0o600, `esperado 0600, got ${perms.toString(8)}`);
});

test("state: saveState escreve JSON válido e pretty-printed", () => {
  const path = join(tmpDir, "state.json");
  saveState(path, { activeProvider: "tavily", keys: {} });
  const raw = readFileSync(path, "utf-8");
  // Deve ser JSON parseável
  const parsed = JSON.parse(raw);
  assert.equal(parsed.activeProvider, "tavily");
  // Deve conter newline (pretty-printed)
  assert.ok(raw.endsWith("\n"), "JSON deve terminar com newline");
});

test("state: loadState com arquivo inexistente → state vazio", () => {
  const path = join(tmpDir, "inexistente", "state.json");
  const state = loadState(path);
  assert.deepEqual(state, { activeProvider: undefined, keys: {} });
});

test("state: loadState com arquivo malformado → state vazio (não crasha)", () => {
  const path = join(tmpDir, "bad.json");
  writeFileSync(path, "{ não é json válido !!!", "utf-8");
  const state = loadState(path);
  assert.deepEqual(state, { activeProvider: undefined, keys: {} });
});

test("state: researchModel inválido é ignorado", () => {
  const path = join(tmpDir, "state.json");
  writeFileSync(path, JSON.stringify({ researchModel: { provider: "zai" } }));
  assert.equal(loadState(path).researchModel, undefined);
});

test("state: saveState campos opcionais ausentes → não escreve undefined", () => {
  const path = join(tmpDir, "state.json");
  saveState(path, {});
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.activeProvider, undefined);
  // keys pode ser omitido ou vazio
  if (parsed.keys) {
    assert.deepEqual(parsed.keys, {});
  }
});

test("state: saveState com campos extras — preserva (escreve o que recebe)", () => {
  const path = join(tmpDir, "state.json");
  saveState(path, { activeProvider: "exa", keys: { tavily: "a", exa: "b" } });
  const state = loadState(path);
  assert.equal(state.keys.tavily, "a");
  assert.equal(state.keys.exa, "b");
});

// ---- resolveKey ----

test("state: resolveKey — state.json.keys.tavily tem prioridade sobre env", () => {
  const path = join(tmpDir, "state.json");
  saveState(path, { keys: { tavily: "from-state" } });
  const origEnv = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = "from-env";
  try {
    const key = resolveKey(path, "tavily");
    assert.equal(key, "from-state", "state.json deve ter prioridade");
  } finally {
    if (origEnv !== undefined) process.env.TAVILY_API_KEY = origEnv;
    else delete process.env.TAVILY_API_KEY;
  }
});

test("state: resolveKey — fallback para env quando state.json não tem a chave", () => {
  const path = join(tmpDir, "state.json");
  saveState(path, { keys: {} });
  const origEnv = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = "from-env";
  try {
    const key = resolveKey(path, "exa");
    assert.equal(key, "from-env");
  } finally {
    if (origEnv !== undefined) process.env.EXA_API_KEY = origEnv;
    else delete process.env.EXA_API_KEY;
  }
});

test("state: resolveKey — undefined quando não há chave em nenhum lugar", () => {
  const path = join(tmpDir, "state.json");
  saveState(path, { keys: {} });
  const origTavily = process.env.TAVILY_API_KEY;
  const origExa = process.env.EXA_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.EXA_API_KEY;
  try {
    const key = resolveKey(path, "tavily");
    assert.equal(key, undefined);
  } finally {
    if (origTavily !== undefined) process.env.TAVILY_API_KEY = origTavily;
    else delete process.env.TAVILY_API_KEY;
    if (origExa !== undefined) process.env.EXA_API_KEY = origExa;
    else delete process.env.EXA_API_KEY;
  }
});
