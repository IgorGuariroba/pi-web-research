import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { loadState, saveState, resolveKey } from "../state.ts";
import { resolveSearchProviders } from "../resolve-provider.ts";

// Fronteiras acordadas: comando registrado + UI/HTTP; storage público em HOME temporário.
function setup(t, { provider = "tavily", state = {}, actions = [], keys = [], statuses = [200], env } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ws-credentials-"));
  for (const name of ["HOME", "TAVILY_API_KEY", "EXA_API_KEY"]) {
    const original = process.env[name];
    delete process.env[name];
    t.after(() => original === undefined ? delete process.env[name] : process.env[name] = original);
  }
  process.env.HOME = home;
  if (env) process.env[provider === "tavily" ? "TAVILY_API_KEY" : "EXA_API_KEY"] = env;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, ".pi/agent/extensions/web-search/state.json");
  saveState(path, state);
  const notices = [], screens = [], menus = [], requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requests.push(init);
    const status = statuses.shift();
    assert.ok(status, "requisição HTTP não prevista");
    return new Response(JSON.stringify(status >= 400
      ? { error: "API key is invalid or revoked" }
      : { results: [] }), { status });
  };
  t.after(() => globalThis.fetch = originalFetch);
  let handler;
  extension({ registerCommand: (name, command) => { if (name === "web-search") handler = command.handler; }, registerTool() {}, exec: async () => ({ stdout: "{}", code: 0 }) });
  const providerSelections = [provider, null];
  const ctx = {
    hasUI: true,
    modelRegistry: { getAvailable: () => [] },
    ui: {
      notify: (message) => notices.push(message),
      select: async (title, options) => {
        menus.push({ title, options });
        const action = actions.shift();
        if (!action) return undefined;
        const picked = options.find((option) => option.startsWith(action));
        assert.ok(picked, `ação ${action} ausente: ${options.join(", ")}`);
        return picked;
      },
      custom: async (factory) => {
        let result;
        const component = factory({ requestRender() {} }, { fg: (_color, s) => s, bold: (s) => s }, {}, (value) => { result = value; });
        screens.push(component.render(100).join("\n"));
        if (screens.at(-1).includes("Web Search — Provider")) {
          const selection = providerSelections.shift();
          if (!selection) component.handleInput("\u001b");
          else {
            if (selection === "exa") component.handleInput("\u001b[B");
            component.handleInput("\r");
          }
        } else {
          assert.ok(keys.length, "entrada de chave não prevista");
          const key = keys.shift();
          if (key === null) component.handleInput("\u001b");
          else { component.handleInput(key); component.handleInput("\r"); }
        }
        return result;
      },
    },
  };
  return { path, notices, screens, menus, requests, run: () => handler("", ctx) };
}

for (const provider of ["tavily", "exa"]) {
  test(`${provider}: após HTTP 401 pode voltar ao menu sem alterar credenciais`, async (t) => {
    const initial = { activeProvider: provider, keys: { [provider]: "old-key" } };
    const h = setup(t, { provider, state: initial, actions: ["Usar chave atual", "Voltar ao menu"], statuses: [401] });
    await h.run();
    assert.equal(h.screens.filter((screen) => screen.includes("Web Search — Provider")).length, 2);
    assert.deepEqual(loadState(h.path), initial);
  });
  test(`${provider}: credencial apenas de ambiente tem origem visível e não é removida`, async (t) => {
    const envName = provider === "tavily" ? "TAVILY_API_KEY" : "EXA_API_KEY";
    const h = setup(t, { provider, env: "env-key", actions: ["Remover chave"] });
    await h.run();
    assert.ok(h.screens[0].includes(envName));
    assert.equal(resolveKey(h.path, provider), "env-key");
    assert.equal(process.env[envName], "env-key");
    assert.ok(h.notices.some((message) => message.includes(envName) && message.includes("continua")));
    assert.equal(h.requests.length, 0);
  });
  for (const [name, key, statuses] of [["cancelada", null, []], ["vazia", "   ", []], ["inválida", "bad-key", [401]]]) {
    test(`${provider}: troca ${name} preserva configuração anterior`, async (t) => {
      const initial = { activeProvider: provider, keys: { [provider]: "old-key" }, researchModel: { provider: "test", id: "model" } };
      const h = setup(t, { provider, state: initial, actions: ["Trocar chave"], keys: [key], statuses });
      await h.run();
      assert.deepEqual(loadState(h.path), initial);
    });
  }
  test(`${provider}: validação inconclusiva não substitui a chave anterior`, async (t) => {
    const initial = { activeProvider: provider, keys: { [provider]: "old-key" }, searchMode: "econômica" };
    const h = setup(t, { provider, state: initial, actions: ["Trocar chave"], keys: ["unverified-key"], statuses: [400] });
    await h.run();
    assert.deepEqual(loadState(h.path), initial);
    assert.ok(!h.notices.some((message) => message.includes("Provider ativo")));
  });
  test(`${provider}: remoção informa fallback de ambiente sem prometer desconexão`, async (t) => {
    const envName = provider === "tavily" ? "TAVILY_API_KEY" : "EXA_API_KEY";
    const h = setup(t, { provider, env: "env-key", state: { activeProvider: provider, keys: { [provider]: "saved-key" } }, actions: ["Remover chave"] });
    await h.run();
    assert.equal(loadState(h.path).keys[provider], undefined);
    assert.equal(resolveKey(h.path, provider), "env-key");
    assert.match(h.screens[0], /state\.json/);
    assert.ok(h.notices.some((message) => message.includes(envName) && message.includes("continua")));
    assert.ok(!h.notices.some((message) => message.includes("desconectado")));
  });
  for (const status of [401, 403]) {
    test(`${provider}: HTTP ${status} com corpo de erro permite trocar chave`, async (t) => {
      const h = setup(t, { provider, state: { keys: { [provider]: "revoked-key" } }, actions: ["Usar chave atual", "Trocar chave"], keys: ["valid-key"], statuses: [status, 200] });
      await h.run();
      assert.equal(resolveKey(h.path, provider), "valid-key");
      assert.equal(loadState(h.path).activeProvider, provider);
      assert.ok(h.notices.some((message) => message.includes("Chave inválida")));
    });
  }
  test(`${provider}: remover chave desconecta e mantém o outro provider`, async (t) => {
    const other = provider === "tavily" ? "exa" : "tavily";
    const h = setup(t, { provider, state: { activeProvider: provider, keys: { [provider]: "old-key", [other]: "other-key" }, blockedDomains: ["spam.test"] }, actions: ["Remover chave"] });
    await h.run();
    assert.equal(resolveKey(h.path, provider), undefined);
    const state = loadState(h.path);
    assert.equal(state.activeProvider, undefined);
    assert.equal(resolveKey(h.path, other), "other-key");
    assert.deepEqual(state.blockedDomains, ["spam.test"]);
    assert.deepEqual(resolveSearchProviders(state.activeProvider, resolveKey(h.path, "tavily"), resolveKey(h.path, "exa"), async () => ({})).map((p) => p.name), [other]);
    assert.equal(h.requests.length, 0);
  });

  test(`${provider}: usuário troca chave salva após validar a nova`, async (t) => {
    const h = setup(t, { provider, state: { activeProvider: provider, keys: { [provider]: "old-key" }, searchMode: "econômica" }, actions: ["Trocar chave"], keys: ["new-key"] });
    await h.run();
    assert.equal(resolveKey(h.path, provider), "new-key");
    const headers = new Headers(h.requests[0].headers);
    assert.equal(headers.get(provider === "tavily" ? "authorization" : "x-api-key"), provider === "tavily" ? "Bearer new-key" : "new-key");
    assert.equal(loadState(h.path).searchMode, "econômica");
    assert.equal(h.menus[0].options.some((option) => option.startsWith("Remover chave")), true);
  });
}
