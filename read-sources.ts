/**
 * read-sources.ts — Fontes lidas e verificação da seção "Fontes" da Síntese.
 */

import { canonicalUrl } from "./canonical-url.ts";

/** Chave de comparação de Fonte lida: a URL canônica. */
export const sourceKey = canonicalUrl;

/** Registro das Fontes lidas (leituras bem-sucedidas via fetch_url). */
export class ReadSources {
  #keys = new Set<string>();
  #count = 0;

  add(requested: string, final?: string): void {
    const key = sourceKey(requested);
    if (!this.#keys.has(key)) this.#count++;
    this.#keys.add(key);
    if (final) this.#keys.add(sourceKey(final));
  }

  has(url: string): boolean {
    return this.#keys.has(sourceKey(url));
  }

  get size(): number {
    return this.#count;
  }
}

const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*Fontes\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const URL_PATTERN = /https?:\/\/[^\s<>()\[\]"'`]+/g;

function urlsIn(line: string): string[] {
  return (line.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,;:!?]+$/, ""));
}

/** Índice da linha de título da (última) seção "Fontes", ou -1. */
function sectionStart(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (HEADING.test(lines[i])) return i;
  return -1;
}

/** URLs citadas em "Fontes" que não são Fontes lidas (sem repetição, em ordem). */
export function unreadCitations(text: string, sources: ReadSources): string[] {
  const lines = text.split("\n");
  const start = sectionStart(lines);
  if (start < 0) return [];
  const unread = lines.slice(start + 1).flatMap(urlsIn).filter((url) => !sources.has(url));
  return [...new Set(unread)];
}

/** Remove de "Fontes" as citações não lidas; some com a seção se ela ficar vazia. */
export function removeUnreadCitations(text: string, sources: ReadSources): { text: string; removed: string[] } {
  const lines = text.split("\n");
  const start = sectionStart(lines);
  if (start < 0) return { text, removed: [] };
  const removed: string[] = [];
  const kept: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const urls = urlsIn(line);
    const bad = urls.filter((url) => !sources.has(url));
    if (!bad.length) { kept.push(line); continue; }
    removed.push(...bad);
    if (bad.length === urls.length) continue;
    let cleaned = line;
    for (const url of bad) cleaned = cleaned.split(url).join("");
    kept.push(cleaned.replace(/\s+([,;])/g, "$1").replace(/[,;]\s*$/, "").trimEnd());
  }
  const body = kept.some((line) => line.trim()) ? [lines[start], ...kept] : [];
  const result = [...lines.slice(0, start), ...body].join("\n").trimEnd();
  return { text: result, removed: [...new Set(removed)] };
}

export function correctionMessage(unread: readonly string[]): string {
  return [
    "Sua seção 'Fontes' cita URLs que você não leu com fetch_url:",
    ...unread.map((url) => `- ${url}`),
    "Reescreva a Síntese completa, citando em 'Fontes' somente páginas que você leu com fetch_url com sucesso.",
    "Responda apenas com a Síntese corrigida.",
  ].join("\n");
}
