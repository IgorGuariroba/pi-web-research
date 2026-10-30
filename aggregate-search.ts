/**
 * aggregate-search.ts — Busca agregada.
 *
 * Uma busca do subagente consulta os Providers e devolve uma lista única,
 * unida pela URL canônica, com a Concordância (Providers que acharam cada
 * resultado). Modos:
 *   - agregada (padrão): todos os Providers em paralelo.
 *   - econômica: um Provider por vez; passa ao próximo só em erro ou vazio.
 * Goose só entra quando não há outro Provider. Falha parcial vira aviso;
 * falha total vira erro.
 */
import type { SearchResult, WebSearchProvider } from "./search-types.ts";
import { canonicalUrl } from "./canonical-url.ts";
import { errorMessage } from "./error-message.ts";

export type SearchMode = "agregada" | "econômica";

/** Modo de busca padrão. */
export const DEFAULT_SEARCH_MODE: SearchMode = "agregada";

export interface AggregatedResult extends SearchResult {
  /** Providers que encontraram este resultado (Concordância). */
  providers: string[];
}

export interface AggregatedSearch {
  results: AggregatedResult[];
  /** Total de resultados recebidos antes da união. */
  found: number;
  /** Providers que responderam com sucesso. */
  providers: string[];
  warnings: string[];
  /** Texto cru do Goose (quando sem resultados estruturados). */
  rawText?: string;
}

const isGoose = (provider: WebSearchProvider) => provider.name.startsWith("goose");

export async function aggregateSearch(
  providers: readonly WebSearchProvider[],
  query: string,
  mode: SearchMode = DEFAULT_SEARCH_MODE,
  signal?: AbortSignal,
): Promise<AggregatedSearch> {
  const keyed = providers.filter((p) => !isGoose(p));
  const active = keyed.length ? keyed : providers.slice(0, 1);
  if (!active.length) throw new Error("Nenhum Provider de busca disponível.");

  const call = async (provider: WebSearchProvider) => provider.search(query, { timeoutMs: 60_000 }, signal);
  const responses: { name: string; results: SearchResult[]; rawText?: string }[] = [];
  const failures: string[] = [];
  const record = (name: string, response: Awaited<ReturnType<typeof call>>) => {
    const meta = response.telemetry?.providerMeta as Record<string, unknown> | undefined;
    responses.push({ name, results: response.results, rawText: meta?.rawAssistantText as string | undefined });
  };

  if (mode === "econômica") {
    for (const provider of active) {
      try {
        const response = await call(provider);
        record(provider.name, response);
        if (response.results.length) break;
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${provider.name} falhou: ${errorMessage(error)}`);
      }
    }
  } else {
    const settled = await Promise.allSettled(active.map(call));
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") record(active[i].name, outcome.value);
      else failures.push(`${active[i].name} falhou: ${errorMessage(outcome.reason)}`);
    });
  }
  if (signal?.aborted) throw signal.reason ?? new Error("Busca cancelada.");
  if (!responses.length) throw new Error(`Todos os Providers falharam: ${failures.join("; ")}`);

  const byUrl = new Map<string, AggregatedResult>();
  let found = 0;
  for (const response of responses) {
    for (const result of response.results) {
      found++;
      const key = canonicalUrl(result.url);
      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, { ...result, providers: [response.name] });
        continue;
      }
      if (!existing.providers.includes(response.name)) existing.providers.push(response.name);
      if ((result.summary ?? "").length > (existing.summary ?? "").length) existing.summary = result.summary;
    }
  }
  return {
    // Concordância conta a favor: mais Providers primeiro (ordenação estável).
    results: [...byUrl.values()].sort((a, b) => b.providers.length - a.providers.length),
    found,
    providers: responses.map((r) => r.name),
    warnings: failures,
    rawText: responses.map((r) => r.rawText).find(Boolean),
  };
}
