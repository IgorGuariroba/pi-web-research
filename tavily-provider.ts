/**
 * TavilyProvider — provedor de web search via Tavily Search API.
 *
 * Segunda implementação de WebSearchProvider (v2 do roadmap). Usa
 * HttpSearchProvider base para retry/backoff compartilhado com Exa.
 *
 * Política de falha:
 *   - 401, 403, PII block → throw imediato (erro determinístico).
 *   - 429, 5xx → retry com backoff + jitter dentro do timeoutMs.
 *   - Erro de rede (fetch reject) → retry; throw ao esgotar.
 *   - Nunca "results:[] silencioso" mascarando falha.
 *
 * Uso: TAVILY_API_KEY no env ou state.json. Tier grátis: 1.000 buscas/mês.
 */

import type { SearchOptions, SearchResponse, SearchResult, WebSearchProvider } from "./search-types.ts";
import { backoff, isTransient, isAbort, MAX_RETRIES } from "./http-search-provider.ts";

const BASE_URL = "https://api.tavily.com/search";

// --------------------------------------------------------------------------- //
// Provider
// --------------------------------------------------------------------------- //

export class TavilyProvider implements WebSearchProvider {
  readonly name = "tavily";
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
    // Validação do unknown: Tavily não usa providerOptions — vazio/undefined OK.
    if (options.providerOptions != null) {
      const raw = options.providerOptions as Record<string, unknown>;
      if (Object.keys(raw).length > 0) {
        throw new Error(`tavily: providerOptions inesperado: ${JSON.stringify(raw)}`);
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
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query,
            search_depth: "basic",
            include_answer: false,
            include_raw_content: false,
            max_results: 10,
            topic: "general",
          }),
          signal: combined,
        });
      } catch (err: any) {
        if (isAbort(err)) {
          throw new Error(`tavily: abortado ou timeout de ${options.timeoutMs ?? "?"}ms`);
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES - 1) {
          await backoff(null, combined);
          continue;
        }
        break;
      }

      // --- Response recebida. Status determinístico → throw SEM backoff ---
      if (isTransient(res.status)) {
        if (attempt < MAX_RETRIES - 1) {
          await backoff(res, combined);
          continue;
        }
        const body = await res.json().catch(() => ({}));
        throw new Error(
          `tavily: HTTP ${res.status} após ${MAX_RETRIES} tentativas — ${body.error || res.statusText}`,
        );
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(`tavily: ${body.error || `HTTP ${res.status}`}`);
      }

      const data = await res.json();

      if (data.error) {
        throw new Error(`tavily: ${data.error}`);
      }

      // --- sucesso ---
      const durationMs = Date.now() - start;
      const results: SearchResult[] = (data.results || []).map((r: any) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        summary: r.content ?? "",
        score: r.score,
        source: this.name,
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

    throw lastError || new Error("tavily: falha desconhecida");
  }
}
