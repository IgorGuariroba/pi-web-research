/**
 * read-sources.ts — Fontes lidas e verificação da seção "Fontes" da Síntese.
 */

import { canonicalUrl } from "./canonical-url.ts";
import { sourceLabelText } from "./source-level.ts";
import type { Criterion } from "./criteria.ts";

/** Classificação de uma Fonte lida: Nível e, com Critério ativo, Categoria. */
export interface SourceLabel {
  level: string;
  category?: string;
}

/** Registro das Fontes lidas (leituras bem-sucedidas via fetch_url). */
export class ReadSources {
  #byKey = new Map<string, SourceLabel>();
  #reads: SourceLabel[] = [];

  add(requested: string, final: string | undefined, label: SourceLabel): void {
    const key = canonicalUrl(requested);
    const finalKey = final ? canonicalUrl(final) : key;
    if (this.#byKey.has(key) || this.#byKey.has(finalKey)) return;
    this.#reads.push(label);
    this.#byKey.set(key, label);
    this.#byKey.set(finalKey, label);
  }

  has(url: string): boolean {
    return this.#byKey.has(canonicalUrl(url));
  }

  label(url: string): SourceLabel | undefined {
    return this.#byKey.get(canonicalUrl(url));
  }

  /** Classificação de cada Fonte lida (uma por página). */
  get reads(): readonly SourceLabel[] {
    return this.#reads;
  }

  get size(): number {
    return this.#reads.length;
  }
}

/**
 * Reescreve "Fontes" com o rótulo `[categoria · nível]` (ou `[nível]`) de cada
 * Fonte lida. Linhas com mais de uma URL viram uma linha por URL.
 * Pressupõe que as citações não lidas já foram removidas.
 */
export function labelCitations(text: string, sources: ReadSources): string {
  const lines = text.split("\n");
  const start = sectionStart(lines);
  if (start < 0) return text;
  const body = lines.slice(start + 1).flatMap((line) => {
    const urls = [...new Set(urlsIn(line))].filter((url) => sources.has(url));
    if (!urls.length) return [line];
    if (urls.length === 1) return [`${line.trimEnd()} ${sourceLabelText(sources.label(urls[0])!)}`];
    return urls.map((url) => `- ${url} ${sourceLabelText(sources.label(url)!)}`);
  });
  return [...lines.slice(0, start + 1), ...body].join("\n");
}

const HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*Fontes\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const URL_PATTERN = /https?:\/\/[^\s<>\[\]"'`]+/g;

const count = (text: string, char: string) => text.split(char).length - 1;

/**
 * Tira da ponta da URL o que é delimitador do texto: pontuação final e `)` sem
 * `(` correspondente (fecho de link Markdown ou de parêntese). Parênteses
 * balanceados ficam (ex.: `wiki/Node.js_(runtime)`).
 */
function trimUrl(url: string): string {
  for (;;) {
    const trimmed = url.replace(/[.,;:!?]+$/, "");
    const unbalanced = trimmed.endsWith(")") && count(trimmed, ")") > count(trimmed, "(");
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
    if (next === url) return url;
    url = next;
  }
}

function urlsIn(line: string): string[] {
  return (line.match(URL_PATTERN) ?? []).map(trimUrl);
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

const GAP_HEADING =
  /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:n[ãa]o\s+encontrad[oa]s?|lacunas?(?:\s+declaradas?)?)\s*(?:\*\*|__)?\s*(?::.*)?$/i;
const LIST_ITEM = /^\s*(?:[-*•+]|\d+[.)])\s+|^\s{2,}\S/;

/**
 * Remove as seções de lacuna ("Não encontrado", "Lacunas"…) escritas pelo
 * subagente: título e a lista logo abaixo. A Lacuna declarada é só a do código.
 */
export function stripWrittenGaps(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!GAP_HEADING.test(lines[i])) { kept.push(lines[i]); continue; }
    while (i + 1 < lines.length && (!lines[i + 1].trim() || LIST_ITEM.test(lines[i + 1]))) i++;
  }
  return kept.join("\n").trimEnd();
}

/**
 * Verificação final de "Fontes": tira as citações não lidas, rotula as Fontes
 * lidas e, com Critério ativo, declara a lacuna das Categorias sem Fonte lida.
 * Lacunas escritas pelo subagente saem sempre (sem Critério não há lacuna).
 */
export function verifySources(
  answer: string, sources: ReadSources, criteria?: readonly Criterion[],
): { text: string; removed: string[] } {
  const { text: verified, removed } = removeUnreadCitations(stripWrittenGaps(answer), sources);
  const labeled = labelCitations(verified, sources);
  return { text: criteria ? declareGap(labeled, sources, criteria) : labeled, removed };
}

export function correctionMessage(unread: readonly string[]): string {
  return [
    "Sua seção 'Fontes' cita URLs que você não leu com fetch_url:",
    ...unread.map((url) => `- ${url}`),
    "Reescreva a Síntese completa, citando em 'Fontes' somente páginas que você leu com fetch_url com sucesso.",
    "Responda apenas com a Síntese corrigida.",
  ].join("\n");
}

/** Leituras por Categoria não descartada do Critério (inclui as com 0). */
export function readsByCategory(sources: ReadSources, criteria: readonly Criterion[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of criteria) if (!c.discard) counts[c.category] = 0;
  for (const read of sources.reads) if (read.category && read.category in counts) counts[read.category]++;
  return counts;
}

/** Lacuna declarada: seção "Não encontrado" com as Categorias não descartadas sem Fonte lida. */
export function declareGap(text: string, sources: ReadSources, criteria: readonly Criterion[]): string {
  const reads = readsByCategory(sources, criteria);
  const missing = criteria.filter((c) => !c.discard && reads[c.category] === 0);
  if (!missing.length) return text;
  return `${text.trimEnd()}\n\nNão encontrado\n${missing.map((c) => `- ${c.category}: ${c.description}`).join("\n")}`;
}
