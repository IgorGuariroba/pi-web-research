/**
 * ExaProvider — provedor de web search via Exa Search API.
 *
 * Terceira implementação de WebSearchProvider. Usa HttpSearchProvider base
 * para retry/backoff compartilhado com Tavily.
 *
 * API: POST https://api.exa.ai/search
 * Auth: header x-api-key (NÃO Bearer)
 * Body: { query, type: "auto", numResults: 10, contents: { highlights: { query, maxCharacters: 1000 } } }
 * Não usa text nem contents.summary.
 *
 * Mapeamento para SearchResult:
 *   title → title
 *   url → url
 *   highlights[0] → summary (excerpt, pode vir truncado)
 *   highlightScores[0] → score
 *   publishedDate → publishedAt (Date)
 *   source: "exa"
 *
 * Política de falha: mesma do Tavily (via HttpSearchProvider base).
 */

import type { SearchOptions, SearchResponse, SearchResult, WebSearchProvider } from "./search-types.ts";
import { backoff, isTransient, isAbort, MAX_RETRIES } from "./http-search-provider.ts";

const BASE_URL = "https://api.exa.ai/search";

// --------------------------------------------------------------------------- //
// Provider
// --------------------------------------------------------------------------- //

export class ExaProvider implements WebSearchProvider {
  readonly name = "exa";
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
    // Exa não usa providerOptions.
    if (options.providerOptions != null) {
      const raw = options.providerOptions as Record<string, unknown>;
      if (Object.keys(raw).length > 0) {
        throw new Error(`exa: providerOptions inesperado: ${JSON.stringify(raw)}`);
      }
    }

    const start = Date.now();
    const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout);

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // --- fetch (pode rejeitar: rede / abort / timeout) ---
      let res: Response;
      try {
        res = await fetch(BASE_URL, {
          method: "POST",
          headers: {
            "x-api-key": this.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            type: "auto",
            numResults: 10,
            contents: {
              highlights: {
                query,
                maxCharacters: 1000,
              },
            },
          }),
          signal: combined,
        });
      } catch (err: any) {
        if (isAbort(err)) {
          throw new Error(`exa: abortado ou timeout de ${options.timeoutMs ?? "?"}ms`);
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES - 1) {
          await backoff(null, combined);
          continue;
        }
        break;
      }

      // --- 401/403: auth error → throw imediato (determinístico) ---
      if (res.status === 401 || res.status === 403) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`exa: ${body.error || `HTTP ${res.status}`}`);
      }

      // --- 429/5xx: transient → retry com backoff ---
      if (isTransient(res.status)) {
        if (attempt < MAX_RETRIES - 1) {
          await backoff(res, combined);
          continue;
        }
        const body = await res.json().catch(() => ({}));
        throw new Error(
          `exa: HTTP ${res.status} após ${MAX_RETRIES} tentativas — ${body.error || res.statusText}`,
        );
      }

      // --- outros erros HTTP ---
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`exa: ${body.error || `HTTP ${res.status}`}`);
      }

      // --- parse ---
      const data = await res.json();
      if (data.error) {
        throw new Error(`exa: ${data.error}`);
      }

      // --- sucesso: mapeamento Exa → SearchResult ---
      const durationMs = Date.now() - start;
      const results: SearchResult[] = (data.results || []).map((r: any) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        summary: Array.isArray(r.highlights) && r.highlights.length > 0 ? r.highlights[0] : "",
        score: Array.isArray(r.highlightScores) && r.highlightScores.length > 0 ? r.highlightScores[0] : undefined,
        source: this.name,
        publishedAt: r.publishedDate ? new Date(r.publishedDate) : undefined,
      }));

      return {
        results,
        provider: this.name,
        durationMs,
        warnings: [],
        telemetry: {
          provider: this.name,
          durationMs,
          warnings: [],
        },
      };
    }

    throw lastError || new Error("exa: falha desconhecida");
  }
}
