// Regressões de isolamento observadas executando as interfaces em HOME descartável.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function sandbox(t) {
  const home = mkdtempSync(join(tmpdir(), "ws-isolation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const agent = join(home, ".pi", "agent");
  const dir = join(agent, "extensions", "web-search");
  mkdirSync(dir, { recursive: true });
  const state = join(dir, "state.json");
  const original = '{ "activeProvider": "tavily", "keys": { "exa": "fake-saved-exa" } }\n';
  writeFileSync(state, original);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ env: { TAVILY_API_KEY: "fake-saved-tavily" } }));
  return { home, state, original };
}

function run(file, home) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--import", "data:text/javascript,globalThis.fetch = async () => { throw new Error('network forbidden in isolation regression'); };", file], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, HOME: home, TAVILY_API_KEY: "", EXA_API_KEY: "" },
    encoding: "utf8", timeout: 30_000,
  });
}

test("fluxos de estado preservam byte a byte o estado do HOME", (t) => {
  const { home, state, original } = sandbox(t);
  const result = run("web-search.tests/tui.test.mjs", home);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(state, "utf8"), original);
});

for (const [file, key] of [
  ["raw-exa-search.test.mjs", "EXA_API_KEY"],
  ["raw-provider-search.test.mjs", "TAVILY_API_KEY"],
]) {
  test(`${file}: credenciais salvas não habilitam rede sem env explícito`, (t) => {
    const { home, state, original } = sandbox(t);
    const result = run(`web-search.tests/${file}`, home);
    assert.equal(result.status, 1, "deve recusar execução antes de consultar o provider");
    assert.match(result.stderr, new RegExp(`${key} não configurada`));
    assert.equal(result.stdout, "");
    assert.equal(readFileSync(state, "utf8"), original);
  });
}
