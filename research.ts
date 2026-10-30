import type { Criterion } from "./criteria.ts";

export type ResearchDepth = "quick" | "deep";

const LIMITS = {
  quick: { searches: 3, fetches: 4, timeoutMs: 90_000 },
  deep: { searches: 12, fetches: 15, timeoutMs: 300_000 },
} as const;

export function getResearchLimits(depth: ResearchDepth) {
  return LIMITS[depth];
}

/** Categorias que a Cobertura exige no Depth: `deep` todas as não descartadas; `quick` as 2 primeiras. */
export function coverageCategories(criteria: readonly Criterion[], depth: ResearchDepth): string[] {
  const kept = criteria.filter((c) => !c.discard).map((c) => c.category);
  return depth === "quick" ? kept.slice(0, 2) : kept;
}

function criteriaSection(criteria: readonly Criterion[], depth: ResearchDepth): string[] {
  return [
    "Critério do agente pai (Categorias de fonte, em ordem de prioridade):",
    ...criteria.map((c, i) => `${i + 1}. ${c.category}: ${c.description}${c.discard ? " (descartar)" : ""}`),
    "Busque ativamente cada Categoria não descartada com queries próprias (ex.: termos que esse tipo de fonte usa), em vez de repetir as palavras do objetivo.",
    "Os resultados de busca vêm rotulados [categoria · nível · providers]; priorize ler as Categorias de maior prioridade.",
    `Cobertura: leia ao menos uma fonte de cada Categoria não descartada (${coverageCategories(criteria, depth).join(", ")}) antes de ler uma segunda fonte de alguma delas.`,
    "Não escreva uma seção 'Não encontrado': ela é gerada a partir das Fontes lidas.",
  ];
}

export function buildResearchPrompt(
  goal: string, focus: string | undefined, depth: ResearchDepth, criteria?: readonly Criterion[],
): string {
  const limits = LIMITS[depth];
  return [
    "Você é um subagente de pesquisa isolado. Investigue usando somente web_search e fetch_url.",
    `Objetivo: ${goal}`,
    focus ? `Foco do agente pai: ${focus}` : "Foco: responda apenas o necessário para o objetivo.",
    `Profundidade: ${depth}. Faça no máximo ${limits.searches} buscas e ${limits.fetches} leituras de página.`,
    ...(criteria?.length ? criteriaSection(criteria, depth) : []),
    "Prefira fontes primárias e oficiais. Cruze fontes quando houver conflito.",
    "Sua resposta final deve ser uma síntese curta e diretamente útil, sem narrar o processo.",
    "Termine com uma seção 'Fontes' contendo somente as URLs efetivamente usadas.",
  ].join("\n");
}

export interface ResearchBudget {
  consumeSearch(): boolean;
  consumeFetch(): boolean;
  /** Devolve uma leitura consumida que não chegou a ser feita (ex.: PDF). */
  refundFetch(): void;
}

export function createResearchBudget(depth: ResearchDepth): ResearchBudget {
  const limits = LIMITS[depth];
  let searches = 0;
  let fetches = 0;
  return {
    consumeSearch: () => searches++ < limits.searches,
    consumeFetch: () => fetches++ < limits.fetches,
    refundFetch: () => { if (fetches > 0) fetches--; },
  };
}
