import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { loadState, saveState } from "../state.ts";
import { modelValue, parseModelValue } from "../model-picker.ts";

// Fronteira acordada: comando registrado, UI do Pi e model registry.
function setup(t, { state = {}, screens = [], choices = [], available = [], models = [], classify, registryError } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ws-model-settings-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });
  const path = join(home, ".pi/agent/extensions/web-search/state.json");
  saveState(path, state);
  const notices = [], rendered = [], menus = [], editor = [];
  let handler;
  extension({ registerCommand: (_name, command) => handler = command.handler, registerTool() {}, exec() { throw Error("provider de busca não deve ser chamado"); } });
  const ctx = {
    hasUI: true,
    modelRegistry: {
      getAvailable: () => models,
      getAvailableOfType: async () => { if (registryError) throw Error(registryError); return available; },
      getModelsOfType: () => available,
      classify: classify ?? (async () => { throw Error("classificação não prevista"); }),
    },
    ui: {
      notify: (message) => notices.push(message),
      setEditorText: (message) => editor.push(message),
      select: async (title, options) => {
        menus.push({ title, options });
        const choice = choices.shift();
        if (choice === undefined) return undefined;
        const found = options.find((option) => option.startsWith(choice));
        assert.ok(found, `opção ${choice} ausente: ${options}`);
        return found;
      },
      custom: async (factory) => {
        let result;
        const component = factory({ requestRender() {} }, { fg: (_color, s) => s, bold: (s) => s }, {}, (value) => result = value);
        rendered.push(component.render(160).join("\n"));
        assert.ok(screens.length, "tela não prevista");
        let index = screens.shift();
        // Tela com filtro: `{ type: "texto", index }` digita o texto antes de navegar.
        if (index !== null && typeof index === "object") {
          for (const char of index.type) component.handleInput(char);
          rendered.push(component.render(160).join("\n"));
          index = index.index;
        }
        if (index === null) component.handleInput("\u001b");
        else {
          for (let i = 0; i < index; i++) component.handleInput("\u001b[B");
          component.handleInput("\r");
        }
        return result;
      },
    },
  };
  return { path, notices, rendered, menus, editor, run: () => handler("", ctx) };
}

const models = [{ provider: "test", id: "old", name: "Anterior" }, { provider: "test", id: "new", name: "Novo" }];
const jev = { provider: "openrouter", id: "typesafe/jev-1.14" };

test("Modelo de pesquisa pode ser trocado sem validar provider ou chave", async (t) => {
  const h = setup(t, { state: { keys: { tavily: "preservada" }, classifier: "none", researchModel: models[0] }, models, screens: [5, 1] });
  await h.run();
  assert.match(h.rendered[0], /Modelo de pesquisa.*test\/old/s);
  assert.deepEqual(loadState(h.path).researchModel, { provider: "test", id: "new" });
  assert.equal(loadState(h.path).keys.tavily, "preservada");
  assert.equal(loadState(h.path).classifier, "none");
});

const many = [
  { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna" },
  { provider: "openrouter", id: "mistralai/mistral-nemo", name: "Mistral: Mistral Nemo" },
  { provider: "openrouter", id: "qwen/qwen3.7-flash", name: "Qwen: Qwen3.7 Flash" },
  { provider: "openrouter", id: "openai/gpt-oss-20b", name: "OpenAI: gpt-oss-20b" },
];

test("Modelo de pesquisa: digitar filtra a lista por nome, provider e id", async (t) => {
  const h = setup(t, { models: many, screens: [5, { type: "qwen", index: 0 }] });
  await h.run();
  assert.match(h.rendered[1], /Filtrar/);
  assert.match(h.rendered[1], /GPT-6 Luna/);
  assert.match(h.rendered[2], /Qwen3\.7 Flash/);
  assert.doesNotMatch(h.rendered[2], /GPT-6 Luna|Mistral Nemo|gpt-oss/);
  assert.deepEqual(loadState(h.path).researchModel, { provider: "openrouter", id: "qwen/qwen3.7-flash" });
});

test("Modelo de pesquisa: filtro por provider/id e navegação sobre a lista filtrada", async (t) => {
  const h = setup(t, { models: many, screens: [5, { type: "openrouter", index: 2 }] });
  await h.run();
  assert.doesNotMatch(h.rendered[2], /GPT-6 Luna/);
  assert.deepEqual(loadState(h.path).researchModel, { provider: "openrouter", id: "openai/gpt-oss-20b" });
});

test("Modelo de pesquisa: filtro sem correspondência não salva nada ao confirmar", async (t) => {
  const h = setup(t, { state: { researchModel: { provider: "test", id: "old" } }, models: many, screens: [5, { type: "zzzz", index: 0 }] });
  await h.run();
  assert.match(h.rendered[2], /Nenhum modelo/);
  assert.deepEqual(loadState(h.path).researchModel, { provider: "test", id: "old" });
});

test("model-picker: ida e volta de modelValue e parseModelValue com id contendo '/'", () => {
  const model = { provider: "openrouter", id: "meta-llama/llama-3.3-70b-instruct" };
  const encoded = modelValue(model);
  const parsed = parseModelValue(encoded);
  assert.deepEqual(parsed, model);
});

test("cancelar Modelo de pesquisa preserva a escolha anterior", async (t) => {
  const h = setup(t, { state: { researchModel: { provider: "test", id: "old" } }, models, screens: [5, null] });
  await h.run();
  assert.deepEqual(loadState(h.path).researchModel, { provider: "test", id: "old" });
});

test("validação real do Classificador fica identificada como último teste, inclusive após reabrir", async (t) => {
  const h = setup(t, { available: [jev], screens: [3, null], choices: ["Validar conexão"], classify: async () => ({
    stopReason: "stop", answers: { r0_offtopic: { type: "bool", probability: 0.01 }, r0_level: { type: "choice", choice: "oficial" } },
  }) });
  await h.run();
  assert.ok(h.notices.some((notice) => /conexão validada/.test(notice)));
  assert.equal(loadState(h.path).classifierValidation.model, "openrouter/typesafe/jev-1.14");
  await h.run();
  assert.match(h.rendered[1], /conexão validada.*último teste/);
});

for (const response of [
  { stopReason: "error", errorMessage: "secret-key-should-not-appear" },
  { stopReason: "stop", answers: {} },
  { stopReason: "stop", answers: { r0_offtopic: { type: "bool", probability: 9 }, r0_level: { type: "choice", choice: "oficial" } } },
]) {
  test(`validação com ${response.stopReason}/${JSON.stringify(response.answers)} não promete sucesso nem expõe segredo`, async (t) => {
    const h = setup(t, { available: [jev], screens: [3, null], choices: ["Validar conexão"], classify: async () => response });
    await h.run();
    assert.equal(loadState(h.path).classifierValidation.ok, false);
    await h.run();
    assert.match(h.rendered[1], /indisponível\/erro.*último teste/);
    assert.doesNotMatch(h.notices.join("\n"), /secret-key-should-not-appear|conexão validada/);
  });
}

test("escolher outro classificador não herda a validação do Jev; desativar usa só regras", async (t) => {
  const other = { provider: "other", id: "classifier" };
  const h = setup(t, { available: [jev, other], state: { classifierValidation: { model: "openrouter/typesafe/jev-1.14", testedAt: "2026-11-01T00:00:00Z", ok: true } }, screens: [3, 3, null], choices: ["other/classifier", "nenhum"] });
  await h.run();
  await h.run();
  assert.match(h.rendered[1], /configurado — não validado.*other\/classifier/);
  await h.run();
  assert.match(h.rendered[2], /desativado \(só regras\)/);
  assert.equal(loadState(h.path).classifier, "none");
});

test("falha ao consultar registry aparece como indisponível/erro, não como falta de configuração", async (t) => {
  const h = setup(t, { screens: [null], registryError: "secret-registry-error" });
  await h.run();
  assert.match(h.rendered[0], /Classificador.*indisponível\/erro/);
  assert.doesNotMatch(h.rendered[0], /não configurado|secret-registry-error/);
});

test("Classificador sem autenticação mostra não configurado e guia o login nativo", async (t) => {
  const h = setup(t, { screens: [3], choices: ["Conectar Jev", "OpenRouter"] });
  await h.run();
  assert.match(h.rendered[0], /Classificador.*não configurado/);
  assert.deepEqual(h.editor, ["/login openrouter"]);
  assert.ok(h.notices.some((notice) => /\/web-search.*[Vv]alidar/.test(notice)));
  assert.deepEqual(loadState(h.path).classifier, { provider: "openrouter", id: "typesafe/jev-1.14" });
});
