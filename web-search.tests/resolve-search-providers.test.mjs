// Categoria: resolveSearchProviders — lista de Providers da Busca agregada.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSearchProviders } from "../resolve-provider.ts";

// Mock do pi.exec
const mockExec = async () => ({ stdout: "{}", stderr: "", code: 0 });
const pi = { exec: mockExec };

// ---- resolveSearchProviders: lista para a Busca agregada ----

test("resolveSearch: com as duas chaves → tavily e exa, sem Goose", () => {
  assert.deepEqual(resolveSearchProviders(undefined, "t", "e", pi).map((p) => p.name), ["tavily", "exa"]);
});

test("resolveSearch: provider ativo vem primeiro (ordem do modo econômica)", () => {
  assert.deepEqual(resolveSearchProviders("exa", "t", "e", pi).map((p) => p.name), ["exa", "tavily"]);
});

test("resolveSearch: Goose só sem nenhuma chave", () => {
  assert.deepEqual(resolveSearchProviders("goose", "t", undefined, pi).map((p) => p.name), ["tavily"]);
  assert.deepEqual(resolveSearchProviders(undefined, undefined, undefined, pi).map((p) => p.name), ["goose:computercontroller"]);
});
