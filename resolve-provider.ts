/**
 * resolve-provider.ts — lógica de resolução do provider ativo.
 *
 * Regras de resolução (em ordem):
 *   1) activeProvider === "exa" e há chave exa → ExaProvider
 *   2) activeProvider === "goose" → GooseBuiltinProvider
 *   3) há chave tavily → TavilyProvider (default)
 *   4) há chave exa → ExaProvider
 *   5) → GooseBuiltinProvider
 *
 * Provider preferido sem chave cai para o próximo disponível.
 */

import type { ExecFn, WebSearchProvider } from "./search-types.ts";
import { TavilyProvider } from "./tavily-provider.ts";
import { ExaProvider } from "./exa-provider.ts";
import { GooseBuiltinProvider } from "./goose-provider.ts";

export function resolveActiveProvider(
  activeProvider: string | undefined,
  tavilyKey: string | undefined,
  exaKey: string | undefined,
  execFn: ExecFn,
): WebSearchProvider {
  // 1) exa preferido se há chave
  if (activeProvider === "exa" && exaKey) {
    return new ExaProvider(exaKey);
  }
  // 2) goose explícito
  if (activeProvider === "goose") {
    return new GooseBuiltinProvider(execFn);
  }
  // 3) default: tavily se há chave
  if (tavilyKey) {
    return new TavilyProvider(tavilyKey);
  }
  // 4) exa se há chave
  if (exaKey) {
    return new ExaProvider(exaKey);
  }
  // 5) goose como fallback
  return new GooseBuiltinProvider(execFn);
}
