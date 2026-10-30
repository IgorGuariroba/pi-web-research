/**
 * source-level.ts — Nível de fonte por regras e corte de spam (ver CONTEXT.md).
 *
 * Caminho sem classificador: o Nível (`oficial`/`docs`/`blog`/`fórum`) vem de
 * padrões de domínio; spam vem de uma lista fixa curta ampliada por
 * `blockedDomains`. Nível baixo é só rebaixado, nunca removido.
 */
import type { AggregatedResult } from "./aggregate-search.ts";
import { canonicalHost } from "./canonical-url.ts";

export type SourceLevel = "oficial" | "docs" | "blog" | "fórum";

export interface LeveledResult extends AggregatedResult {
  level: SourceLevel;
}

export interface CuratedResults {
  results: LeveledResult[];
  /** Resultados removidos como spam. */
  spam: number;
}

/** Máximo de resultados mostrados ao subagente por busca. */
export const MAX_RESULTS_PER_SEARCH = 8;

const LEVEL_RANK: Record<SourceLevel, number> = { oficial: 0, docs: 1, blog: 2, "fórum": 3 };

/** Spam e fazendas de conteúdo conhecidas. */
const SPAM_DOMAINS = [
  "pinterest.com", "ehow.com", "answers.com", "brainly.com", "chegg.com",
  "coursehero.com", "scribd.com", "slideshare.net", "studocu.com",
];

const AUTHORITY_DOMAINS = ["rfc-editor.org", "w3.org", "ietf.org", "iso.org", "whatwg.org"];
const AUTHORITY_TLD = /\.(gov|edu|mil)(\.[a-z]{2})?$|\.gov\.[a-z]{2}$|\.edu\.[a-z]{2}$/;
const DOCS_DOMAINS = ["readthedocs.io", "readthedocs.org", "developer.mozilla.org"];
const DOCS_PREFIX = /^(docs|developer|developers|devdocs)\./;
const FORUM_DOMAINS = [
  "reddit.com", "news.ycombinator.com", "stackoverflow.com", "stackexchange.com",
  "superuser.com", "serverfault.com", "askubuntu.com", "quora.com", "lobste.rs",
];
const FORUM_LABEL = /^(forum|forums|discourse|discuss|community)$/;
/** Rótulos genéricos que não identificam o assunto. */
const GENERIC_LABELS = new Set(["www", "docs", "developer", "developers", "api", "blog", "en", "m", "com", "org", "net", "dev", "io"]);
const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu", "ac"]);

const hostOf = (url: string) => {
  try { return canonicalHost(new URL(url).hostname); } catch { return ""; }
};

const onDomain = (host: string, domains: readonly string[]) =>
  domains.some((d) => host === d || host.endsWith(`.${d}`));

/** Rótulos do host sem o sufixo público (ex.: `docs.react.dev` → docs, react). */
function nameLabels(host: string): string[] {
  const labels = host.split(".");
  labels.pop();
  if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop();
  return labels.filter((label) => !GENERIC_LABELS.has(label));
}

/** Termos do assunto (Goal/query); `Node.js` vira também `nodejs`. */
export function subjectTerms(...texts: (string | undefined)[]): Set<string> {
  const terms = new Set<string>();
  for (const token of texts.join(" ").toLowerCase().split(/\s+/)) {
    const joined = token.replace(/[^\p{L}\p{N}-]/gu, "");
    for (const term of [joined, ...joined.split("-"), ...token.split(/[^\p{L}\p{N}]+/u)]) {
      if (term.length >= 2) terms.add(term);
    }
  }
  return terms;
}

/** `react` ↔ react.dev, `vue` ↔ vuejs.org, `go` ↔ golang.org. */
function matchesSubject(label: string, terms: ReadonlySet<string>): boolean {
  const plain = label.replace(/-/g, "");
  if (plain.length >= 3 && terms.has(plain)) return true;
  const stem = plain.replace(/(js|lang)$/, "");
  return stem !== plain && stem.length >= 2 && terms.has(stem);
}

export function sourceLevel(url: string, terms: ReadonlySet<string>): SourceLevel {
  const host = hostOf(url);
  if (onDomain(host, AUTHORITY_DOMAINS) || AUTHORITY_TLD.test(host)) return "oficial";
  const labels = nameLabels(host);
  if (labels.some((label) => matchesSubject(label, terms))) return "oficial";
  if (onDomain(host, DOCS_DOMAINS) || DOCS_PREFIX.test(host)) return "docs";
  if (onDomain(host, FORUM_DOMAINS) || host.split(".").some((label) => FORUM_LABEL.test(label))) return "fórum";
  return "blog";
}

export function isSpam(url: string, blockedDomains: readonly string[] = []): boolean {
  const host = hostOf(url);
  const blocked = blockedDomains.map(canonicalHost).filter(Boolean);
  return onDomain(host, SPAM_DOMAINS) || onDomain(host, blocked);
}

/**
 * Corta spam, atribui o Nível e ordena por Nível → Concordância (estável).
 * Não limita a quantidade; use `MAX_RESULTS_PER_SEARCH` ao mostrar.
 */
export function curateByRules(
  results: readonly AggregatedResult[],
  terms: ReadonlySet<string>,
  blockedDomains: readonly string[] = [],
): CuratedResults {
  const kept = results.filter((result) => !isSpam(result.url, blockedDomains));
  const leveled = kept.map((result) => ({ ...result, level: sourceLevel(result.url, terms) }));
  return { results: sortByLevel(leveled), spam: results.length - kept.length };
}

/** Ordena por Nível → Concordância (estável, in place). */
export function sortByLevel<T extends LeveledResult>(results: T[]): T[] {
  return results.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.providers.length - a.providers.length);
}

const SNIPPET_MAX = 280;

/** Trecho curto do resumo para o subagente. */
export function shortSnippet(summary: string | undefined): string {
  const text = (summary ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET_MAX) return text;
  const cut = text.slice(0, SNIPPET_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SNIPPET_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Rótulo de fonte `[categoria · nível · providers]`; Categoria e Providers são
 * opcionais (ex.: `[nível]` em Fontes sem Critério).
 */
export const sourceLabelText = ({ category, level, providers }: { category?: string; level: string; providers?: readonly string[] }) =>
  `[${[category, level, providers?.length ? providers.join("+") : undefined].filter(Boolean).join(" · ")}]`;
