/**
 * Helpers compartilhados da suíte de regressão.
 *
 * Execução:
 *   cd ~/.pi/agent/extensions/web-search.tests
 *   node --test --experimental-strip-types *.test.mjs
 *
 * Por que node:test: extensão global sem node_modules de teste; node:test é
 * built-in. Por que --experimental-strip-types: os módulos .ts sob teste são
 * TS puramente tipado (só tipos/interfaces), então o Node faz strip sem
 * compilar. Se algum módulo passar a usar TS semântico, migrar para jiti/tsx.
 */

export const GOOSE_ADAPTER = "../goose-adapter.ts";
export const SEARCH_TYPES = "../search-types.ts";

/** Resultado canônico usado em vários testes. */
export const OKF = {
  title: "Open Knowledge Format",
  url: "https://okf.md/",
  summary: "An open spec for agent+human knowledge.",
};
