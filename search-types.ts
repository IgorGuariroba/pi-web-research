/**
 * search-types.ts — contrato público de busca (neutro quanto a provider).
 *
 * Nem a tool nem a Busca agregada conhecem "goose". Eles operam sobre estes
 * tipos. O adapter específico de cada provider (ex: goose-adapter.ts) converte o
 * formato cru do provider neste contrato.
 *
 * Imports de tipo de @earendil-works/pi-coding-agent são type-only (apagados em
 * runtime), para que módulos puros como goose-adapter.ts permaneçam testáveis
 * sem o runtime do PI.
 */

import type { ExecResult } from "@earendil-works/pi-coding-agent";

/** Qual estratégia de parse produziu os resultados (para telemetria). */
export type ParseStrategy = "json" | "markdown" | "bracket" | "raw" | "none";

export interface SearchResult {
  title: string;
  url: string;
  summary: string;
  /** Provedor que originou o resultado (ex: "goose:computercontroller"). */
  source?: string;
  /** Score de relevância (escala definida pelo provider/normalizer). */
  score?: number;
  /** Data de publicação, quando disponível. */
  publishedAt?: Date;
}

export interface SearchOptions {
  timeoutMs?: number;
  /**
   * Opções específicas do provider. Contrato: cada provider valida o
   * `unknown` na sua borda, NUNCA faz cast cego. O Goose põe `{maxTurns}`;
   * o Tavily ignora (vazio). `unknown` é o teto de segurança — não o piso.
   */
  providerOptions?: unknown;
}

/**
 * Telemetria de uma execução de busca. Nome "Telemetry" (não "Trace") pois
 * tende a crescer: retries, cacheHit, dedupCount, rerank aplicado, etc. Esses
 * campos entram (opcionais) quando os respectivos componentes existirem —
 * adicionar campo opcional a este objeto é non-breaking.
 */
export interface SearchTelemetry {
  provider: string;
  durationMs: number;
  warnings: string[];
  /**
   * Metadados opacos específicos do provider. Ex: Goose põe
   * `{rawAssistantText, parseStrategy, parseFallback, tokens}`; Tavily
   * não põe nada. Cada provider valida/define seu próprio shape.
   */
  providerMeta?: unknown;
}

/**
 * Retorno canônico de uma busca. Objeto (não array) para crescer sem quebrar
 * a API: futuras adições (cacheHit, providerChain, etc.) entram como opcionais.
 */
export interface SearchResponse {
  results: SearchResult[];
  provider: string;
  durationMs: number;
  warnings: string[];
  telemetry: SearchTelemetry;
}

/** Contrato de um provedor de web search. Tool e Busca agregada não conhecem a implementação. */
export interface WebSearchProvider {
  readonly name: string;
  search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResponse>;
}

/** Execução desacoplada do ExtensionAPI (DI p/ manter o provider testável). */
export interface ExecFn {
  (
    cmd: string,
    args: string[],
    opts: { signal?: AbortSignal; timeout?: number },
  ): Promise<ExecResult>;
}
