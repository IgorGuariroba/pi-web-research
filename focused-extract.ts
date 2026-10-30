/**
 * Extração focada: divide o texto da página em trechos e devolve os mais
 * relevantes ao Goal + Focus + query, em ordem original, até cerca de 5k
 * caracteres. Por regras (sobreposição de termos) ou, com classificador, pela
 * nota de relevância dele sobre ~20 candidatos pré-selecionados pelas regras.
 */

export const FOCUSED_MAX_CHARS = 5_000;
const CHUNK_TARGET = 700;
const SEPARATOR = "\n[…]\n";

const STOPWORDS = new Set([
  // pt
  "a", "o", "as", "os", "um", "uma", "uns", "umas", "de", "do", "da", "dos", "das", "em", "no", "na", "nos", "nas",
  "por", "para", "pra", "com", "sem", "sob", "sobre", "que", "qual", "quais", "quando", "onde", "como", "porque", "por que",
  "e", "ou", "se", "mas", "mais", "menos", "muito", "pouco", "ser", "sao", "esta", "este", "isso", "isto", "essa", "esse",
  "ao", "aos", "ate", "seu", "sua", "seus", "suas", "ele", "ela", "eles", "elas", "nao", "sim", "ja", "tem", "ter", "foi",
  "entre", "cada", "todo", "toda", "todos", "todas", "tambem", "pelo", "pela", "pelos", "pelas", "num", "numa",
  // en
  "the", "an", "of", "to", "in", "on", "for", "with", "and", "or", "is", "are", "was", "be", "by", "at", "from", "what",
  "how", "why", "which", "who", "this", "that", "these", "those", "it", "its", "as", "not", "can", "does", "do",
]);

export function termsOf(text: string): string[] {
  return text
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Divide em trechos de ~CHUNK_TARGET caracteres respeitando linhas/frases. */
function splitIntoChunks(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.length <= CHUNK_TARGET) { pieces.push(trimmed); continue; }
    // linha longa (texto puro/JSON minificado): quebra por frase e, em último caso, à força
    let current = "";
    for (const sentence of trimmed.split(/(?<=[.!?;,}\]])\s+/)) {
      for (let i = 0; i < sentence.length; i += CHUNK_TARGET) {
        const part = sentence.slice(i, i + CHUNK_TARGET);
        if (current && current.length + part.length + 1 > CHUNK_TARGET) { pieces.push(current); current = ""; }
        current = current ? `${current} ${part}` : part;
      }
    }
    if (current) pieces.push(current);
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length + 1 > CHUNK_TARGET) { chunks.push(current); current = ""; }
    current = current ? `${current}\n${piece}` : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

type Passage = { chunk: string; index: number; score: number };

function scoredChunks(text: string, context: readonly (string | undefined)[]): Passage[] {
  const wanted = new Set(context.flatMap((c) => (c ? termsOf(c) : [])));
  return splitIntoChunks(text).map((chunk, index) => {
    const terms = termsOf(chunk);
    const distinct = new Set(terms.filter((t) => wanted.has(t)));
    const hits = terms.filter((t) => wanted.has(t)).length;
    return { chunk, index, score: distinct.size * 10 + Math.min(hits, 10) };
  });
}

const byRules = (a: Passage, b: Passage) => b.score - a.score || a.index - b.index;

/** Junta os trechos na ordem de preferência dada até maxChars; devolve-os em ordem original. */
function assemble(pool: readonly Passage[], maxChars: number): string {
  const picked: Passage[] = [];
  let used = 0;
  for (const candidate of pool) {
    const cost = candidate.chunk.length + (picked.length ? SEPARATOR.length : 0);
    if (used + cost > maxChars) {
      if (!picked.length) { picked.push({ ...candidate, chunk: candidate.chunk.slice(0, maxChars) }); used = maxChars; }
      continue;
    }
    picked.push(candidate);
    used += cost;
  }
  return picked.sort((a, b) => a.index - b.index).map((c) => c.chunk).join(SEPARATOR);
}

/**
 * context: textos que definem a relevância (Goal, Focus, queries).
 * Texto curto volta inteiro; senão, trechos de maior sobreposição de termos.
 */
export function focusedExtract(text: string, context: readonly (string | undefined)[], maxChars = FOCUSED_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const chunks = scoredChunks(text, context);
  const relevant = chunks.filter((c) => c.score > 0).sort(byRules);
  return assemble(relevant.length ? relevant : chunks, maxChars); // sem sobreposição: começo da página
}

/** Quantidade de trechos pré-selecionados pelas regras para a nota do classificador. */
export const FOCUSED_CANDIDATES = 20;

/**
 * Pré-seleção para o classificador: até `max` trechos, primeiro os de maior
 * sobreposição de termos, completados pelos demais em ordem original.
 * `undefined` quando a página cabe inteira (não há o que escolher).
 */
export function focusedCandidates(
  text: string, context: readonly (string | undefined)[], maxChars = FOCUSED_MAX_CHARS, max = FOCUSED_CANDIDATES,
): { passages: string[]; extract(scores: readonly number[]): string } | undefined {
  if (text.length <= maxChars) return undefined;
  const chunks = scoredChunks(text, context);
  const relevant = chunks.filter((c) => c.score > 0).sort(byRules);
  const rest = chunks.filter((c) => c.score <= 0);
  const candidates = [...relevant, ...rest].slice(0, max);
  return {
    passages: candidates.map((c) => c.chunk),
    /** Junta os candidatos pela nota do classificador (empate: ordem das regras). */
    extract: (scores) => assemble(
      candidates.map((c, i) => ({ c, s: scores[i] ?? 0, i })).sort((a, b) => b.s - a.s || a.i - b.i).map(({ c }) => c),
      maxChars,
    ),
  };
}
