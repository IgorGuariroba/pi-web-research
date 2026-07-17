/**
 * search-engine.ts — orquestrador do provider ativo com pipeline de estágios.
 *
 * Suporta dois overloads de construção:
 *   1) Provider fixo (legado): new SearchEngine(provider, stages?)
 *   2) Provider dinâmico: new SearchEngine(() => provider, stages?)
 *
 * No modo dinâmico, resolveProvider é chamado UMA VEZ no topo de cada
 * search() e o provider resultante é mantido até o fim daquela chamada.
 * Troca no meio de uma busca não afeta a busca em andamento — vale só
 * da próxima chamada.
 *
 * stages é readonly: uma vez definidos, não mudam.
 */

import type {
  ResolveProvider,
  SearchContext,
  SearchOptions,
  SearchResponse,
  SearchStage,
  WebSearchProvider,
} from "./search-types.ts";

export class SearchEngine {
  /** Provider fixo (overload legado). Se presente, resolveProvider é ignorado. */
  private readonly _staticProvider?: WebSearchProvider;
  private readonly _resolveProvider?: ResolveProvider;
  private readonly stages: readonly SearchStage[];

  /**
   * Overload legado: provider fixo.
   * Mantido para compatibilidade — equivalente a new SearchEngine(() => provider, stages).
   */
  constructor(provider: WebSearchProvider, stages?: readonly SearchStage[]);
  /**
   * Overload novo: função que resolve o provider dinamicamente.
   * Permite troca de provider entre buscas (mas não no meio de uma busca).
   */
  constructor(resolveProvider: ResolveProvider, stages?: readonly SearchStage[]);
  constructor(providerOrFn: WebSearchProvider | ResolveProvider, stages: readonly SearchStage[] = []) {
    if (typeof providerOrFn === "function") {
      this._resolveProvider = providerOrFn;
    } else {
      this._staticProvider = providerOrFn;
    }
    this.stages = stages;
  }

  async search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
    // Resolve o provider UMA VEZ no topo desta chamada.
    // Regra: troca de provider no meio de uma busca não afeta a busca em
    // andamento — só vale da próxima chamada search().
    const provider = this._staticProvider ?? this._resolveProvider!();

    let response = await provider.search(query, options, signal);
    const context: SearchContext = { query };
    for (const stage of this.stages) {
      response = await stage(response, context);
    }
    return response;
  }
}
