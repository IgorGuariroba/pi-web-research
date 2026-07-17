export type ResearchDepth = "quick" | "deep";

const LIMITS = {
  quick: { searches: 2, fetches: 2, timeoutMs: 60_000 },
  deep: { searches: 8, fetches: 8, timeoutMs: 180_000 },
} as const;

export function getResearchLimits(depth: ResearchDepth) {
  return LIMITS[depth];
}

export function buildResearchPrompt(goal: string, focus: string | undefined, depth: ResearchDepth): string {
  const limits = LIMITS[depth];
  return [
    "Você é um subagente de pesquisa isolado. Investigue usando somente web_search e fetch_url.",
    `Objetivo: ${goal}`,
    focus ? `Foco do agente pai: ${focus}` : "Foco: responda apenas o necessário para o objetivo.",
    `Profundidade: ${depth}. Faça no máximo ${limits.searches} buscas e ${limits.fetches} leituras de página.`,
    "Prefira fontes primárias e oficiais. Cruze fontes quando houver conflito.",
    "Sua resposta final deve ser uma síntese curta e diretamente útil, sem narrar o processo.",
    "Termine com uma seção 'Fontes' contendo somente as URLs efetivamente usadas.",
  ].join("\n");
}

export interface ResearchBudget {
  consumeSearch(): boolean;
  consumeFetch(): boolean;
}

export function createResearchBudget(depth: ResearchDepth): ResearchBudget {
  const limits = LIMITS[depth];
  let searches = 0;
  let fetches = 0;
  return {
    consumeSearch: () => searches++ < limits.searches,
    consumeFetch: () => fetches++ < limits.fetches,
  };
}
