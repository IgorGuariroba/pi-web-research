/**
 * criteria.ts — Critério do Agente pai (ver CONTEXT.md).
 *
 * Lista ordenada de 2 a 8 Categorias `{ category, description, discard? }`; a
 * ordem é a prioridade. O classificador atribui a cada resultado uma Categoria
 * (ou `outros`); Categorias de descarte saem do Funil.
 */

export interface Criterion {
  category: string;
  description: string;
  discard?: boolean;
}

/** Categoria atribuída a resultados que não se encaixam em nenhuma do Critério. */
export const OTHER_CATEGORY = "outros";

export const MIN_CRITERIA = 2;
export const MAX_CRITERIA = 8;

/** Rejeita Critério inválido com mensagem clara para o Agente pai. */
export function validateCriteria(criteria: readonly Criterion[] | undefined): void {
  if (criteria === undefined) return;
  if (!Array.isArray(criteria) || criteria.length < MIN_CRITERIA || criteria.length > MAX_CRITERIA) {
    throw new Error(`research: criteria deve ter entre ${MIN_CRITERIA} e ${MAX_CRITERIA} Categorias (recebido: ${Array.isArray(criteria) ? criteria.length : typeof criteria}).`);
  }
  const names = new Set<string>();
  for (const item of criteria) {
    const name = typeof item?.category === "string" ? item.category.trim() : "";
    if (!name || typeof item.description !== "string" || !item.description.trim()) {
      throw new Error("research: criteria inválido — cada Categoria precisa de category e description não vazios.");
    }
    if (name === OTHER_CATEGORY) throw new Error(`research: criteria inválido — "${OTHER_CATEGORY}" é reservado.`);
    if (names.has(name)) throw new Error(`research: criteria inválido — Categoria repetida: "${name}".`);
    names.add(name);
  }
  if (criteria.every((item) => item.discard)) {
    throw new Error("research: criteria precisa de ao menos uma Categoria sem descarte (discard).");
  }
}
