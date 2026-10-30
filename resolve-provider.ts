/**
 * resolve-provider.ts — resolução da lista de Providers da Busca agregada.
 */

import type { ExecFn, WebSearchProvider } from "./search-types.ts";
import { TavilyProvider } from "./tavily-provider.ts";
import { ExaProvider } from "./exa-provider.ts";
import { GooseBuiltinProvider } from "./goose-provider.ts";

/**
 * Providers da Busca agregada: todos com chave (o ativo primeiro, ordem usada
 * pelo modo `econômica`). Goose só entra quando nenhum Provider tem chave.
 */
export function resolveSearchProviders(
  activeProvider: string | undefined,
  tavilyKey: string | undefined,
  exaKey: string | undefined,
  execFn: ExecFn,
): WebSearchProvider[] {
  const keyed: WebSearchProvider[] = [];
  if (tavilyKey) keyed.push(new TavilyProvider(tavilyKey));
  if (exaKey) keyed.push(new ExaProvider(exaKey));
  if (!keyed.length) return [new GooseBuiltinProvider(execFn)];
  return keyed.sort((a, b) => Number(b.name === activeProvider) - Number(a.name === activeProvider));
}
