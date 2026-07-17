/**
 * GooseAdapter — normalização específica do provider Goose (builtin
 * computercontroller). É a única camada que entende o formato cru do Goose:
 *
 *   stdout do `goose run --output-format json`
 *     ↓ extractAssistantText        (pega o texto da última msg assistant)
 *   texto do assistente
 *     ↓ parseResults / parseResultsDetailed   (JSON → SearchResult[])
 *   resultados estruturados
 *     ↓ gooseResponseFromText       (monta SearchResponse com telemetry)
 *   contrato público
 *
 * Princípio: o restante do sistema nunca vê o formato cru do Goose.
 *
 * Este módulo é PURAMENTE de lógica (sem I/O, sem ExtensionAPI), portanto
 * testável isoladamente via node:test + --experimental-strip-types.
 *
 * NOTA: ainda não é uma `interface ProviderAdapter<T>` abstrata. Seguindo o
 * princípio "extraia a abstração com 2 implementações reais", ela só emerge
 * quando o segundo provider (Exa/Brave/Tavily) chegar e a fronteira entre os
 * adapters ficar visível. Hoje há um único adapter concreto: este.
 */

import type {
  ParseStrategy,
  SearchResponse,
  SearchResult,
  SearchTelemetry,
} from "./search-types.ts";

export type { SearchResult };

// --------------------------------------------------------------------------- //
// Prompt
// --------------------------------------------------------------------------- //

/** Prompt determinístico enviado ao agente goose: força JSON, mínima "criatividade". */
export function buildSearchPrompt(query: string): string {
  return [
    `Search the web for: ${query}`,
    "",
    "Respond with ONLY a minified JSON array. No prose, no markdown, no code fences, no explanation.",
    "Schema (the 5 most relevant results):",
    '[{"title": string, "url": string, "summary": string}]',
    "- summary: at most 2 sentences, factual.",
    "- Preserve the exact original URLs.",
    "",
    "Example:",
    '[{"title":"Open Knowledge Format","url":"https://okf.md/","summary":"An open spec for agent+human knowledge."}]',
  ].join("\n");
}

// --------------------------------------------------------------------------- //
// Envelope do goose (stdout → texto do assistente)
// --------------------------------------------------------------------------- //

/** Resume o stderr em algo curto e útil. */
export function capStderr(stderr: string): string {
  const t = (stderr ?? "").trim();
  if (!t) return "";
  const lines = t.split("\n").filter((l) => l.length > 0);
  const first = lines[0].slice(0, 200);
  return lines.length > 1 ? `${first} (… +${lines.length - 1} linha(s))` : first;
}

/**
 * Extrai o texto da última mensagem assistant do envelope JSON do
 * `goose run --output-format json` (shape: { messages, metadata }).
 * Se o stdout não for JSON (erro fatal/prompt de config), devolve o texto cru.
 */
export function extractAssistantText(stdout: string): string {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return stdout.trim();
  }
  const messages = (envelope as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return "";
  const lastAssistant = [...messages].reverse().find((m) => (m as { role?: string })?.role === "assistant");
  const contents = (lastAssistant as { content?: unknown })?.content;
  if (!Array.isArray(contents)) return "";
  return contents
    .filter((c) => (c as { type?: string })?.type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => (c as { text: string }).text)
    .join("\n")
    .trim();
}

/**
 * Extrai metadados de uso de tokens do envelope do goose, quando presentes.
 * Devolve undefined se o stdout não for JSON ou não houver metadata.
 */
export function extractTokens(stdout: string): { total?: number; input?: number; output?: number } | undefined {
  try {
    const env = JSON.parse(stdout) as { metadata?: { total_tokens?: number; input_tokens?: number; output_tokens?: number } };
    const m = env?.metadata;
    if (!m) return undefined;
    const out: { total?: number; input?: number; output?: number } = {};
    if (typeof m.total_tokens === "number") out.total = m.total_tokens;
    if (typeof m.input_tokens === "number") out.input = m.input_tokens;
    if (typeof m.output_tokens === "number") out.output = m.output_tokens;
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

// --------------------------------------------------------------------------- //
// Parser (texto do assistente → SearchResult[])
// --------------------------------------------------------------------------- //

export interface ParseDetails {
  results: SearchResult[];
  strategy: ParseStrategy;
  warnings: string[];
}

const tryParse = (s: string): SearchResult[] | null => {
  try {
    const v = JSON.parse(s);
    if (!Array.isArray(v)) return null;
    return v
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
      .map((r) => ({
        title: String(r.title ?? "").trim(),
        url: String(r.url ?? "").trim(),
        summary: String(r.summary ?? "").trim(),
      }))
      .filter((r) => r.url.length > 0);
  } catch {
    return null;
  }
};

/**
 * Parse detalhado: devolve resultados + estratégia que funcionou + warnings.
 * Estratégia tenta, em ordem: json direto → code fence → array entre colchetes.
 *
 * Não inclui a estratégia "raw" — essa é decisão do PROVIDER (usar o texto cru
 * quando results está vazio), refletida em gooseResponseFromText.
 */
export function parseResultsDetailed(text: string): ParseDetails {
  const direct = tryParse(text.trim());
  if (direct) return { results: direct, strategy: "json", warnings: [] };

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fence) {
    const inFence = tryParse(fence.trim());
    if (inFence) {
      return {
        results: inFence,
        strategy: "markdown",
        warnings: ["parse fallback: extracted from code fence (direct JSON parse failed)"],
      };
    }
  }

  const bracket = text.match(/\[[\s\S]*\]/)?.[0];
  if (bracket) {
    const asArray = tryParse(bracket);
    if (asArray) {
      return {
        results: asArray,
        strategy: "bracket",
        warnings: ["parse fallback: extracted from bracketed array (no code fence)"],
      };
    }
  }

  return { results: [], strategy: "none", warnings: [] };
}

/** API simples: só os resultados (compatível com código existente). */
export function parseResults(text: string): SearchResult[] {
  return parseResultsDetailed(text).results;
}

// --------------------------------------------------------------------------- //
// Montagem da SearchResponse (pura, testável)
// --------------------------------------------------------------------------- //

/**
 * Monta a SearchResponse a partir do texto do assistente. Pura (sem I/O):
 * o provider fica só com a execução (goose run) e delega a montagem aqui.
 * Isso mantém a lógica de "como o goose fala" inteiramente neste adapter.
 */
export function gooseResponseFromText(
  rawAssistantText: string,
  providerName: string,
  durationMs: number,
  tokens?: { total?: number; input?: number; output?: number },
): SearchResponse {
  const details = parseResultsDetailed(rawAssistantText);
  const results = details.results.map((r) => ({ ...r, source: providerName }));
  const warnings = [...details.warnings];
  let strategy = details.strategy;

  // Fallback final: sem resultados estruturados mas há texto → sinaliza "raw".
  if (results.length === 0 && rawAssistantText.length > 0) {
    strategy = "raw";
    warnings.push("parse fallback: returning raw assistant text (no structured results extracted)");
  }

  const telemetry: SearchTelemetry = {
    provider: providerName,
    durationMs,
    warnings,
    providerMeta: { rawAssistantText, parseStrategy: strategy, parseFallback: strategy !== "json", tokens },
  };

  return {
    results,
    provider: providerName,
    durationMs,
    warnings,
    telemetry,
  };
}
