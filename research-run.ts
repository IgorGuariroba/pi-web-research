/**
 * research-run.ts — estado de uma Research em andamento (Funil, avisos,
 * Classificador, Critério ativo) e os details/avisos derivados dele.
 */
import { DEFAULT_SEARCH_MODE } from "./aggregate-search.ts";
import type { Classifier } from "./classifier.ts";
import type { Criterion } from "./criteria.ts";
import { errorMessage } from "./error-message.ts";
import type { RunResearchOptions } from "./research-runner.ts";
import type { LeveledResult } from "./source-level.ts";

/** Contadores do Funil, acumulados nas buscas de uma Research. */
export interface Funnel {
  found: number;
  unique: number;
  duplicates: number;
  /** Resultados descartados como spam. */
  spam: number;
  /** Resultados descartados como Fora do tema (só com classificador). */
  offTopic?: number;
  /** Resultados descartados por Categoria de descarte do Critério (só com Critério ativo). */
  criteriaDiscarded?: number;
}

export const emptyFunnel = (classifier: Classifier | undefined, criteria?: readonly Criterion[]): Funnel => ({
  found: 0, unique: 0, duplicates: 0, spam: 0,
  ...(classifier ? { offTopic: 0 } : {}),
  ...(classifier && criteria ? { criteriaDiscarded: 0 } : {}),
});

/** Resultados que sobreviveram ao descarte (spam, Fora do tema, Critério). */
export const keptCount = (funnel: Funnel) => funnel.unique - funnel.spam - (funnel.offTopic ?? 0) - (funnel.criteriaDiscarded ?? 0);

/** Resultado curado com a Categoria do Critério, quando houver. */
export type CuratedResult = LeveledResult & { category?: string };

export interface ResearchRun {
  options: RunResearchOptions;
  funnel: Funnel;
  searchWarnings: string[];
  classifier?: Classifier;
  classifierCost: number;
  /** Critério ativo (só com classificador; sem ele o Critério é ignorado). */
  criteria?: readonly Criterion[];
  /** Julgamentos de resultados/páginas que caíram nas regras por falha do classificador. */
  judgeFailures: number;
  /** Amostra dos descartados por Fora do tema (auditoria/recalibração do limiar; só nos details). */
  offTopicDiscarded: OffTopicDiscard[];
}

export interface OffTopicDiscard {
  url: string;
  /** Probabilidade de Fora do tema dada pelo classificador. */
  offTopic: number;
}

/** Máximo de descartados por Fora do tema listados nos details. */
const OFF_TOPIC_SAMPLE = 20;

export function recordOffTopic(run: ResearchRun, url: string, offTopic: number) {
  if (run.offTopicDiscarded.length < OFF_TOPIC_SAMPLE) run.offTopicDiscarded.push({ url, offTopic });
}

/**
 * Falha do classificador: cancelamento propaga; senão vira aviso (o chamador cai
 * nas regras). Falha de julgamento (Fora do tema/Nível/Categoria) conta para o
 * Critério degradado.
 */
export function classifierFailed(run: ResearchRun, classifier: Classifier, error: unknown, signal: AbortSignal | undefined, judging: boolean) {
  if (signal?.aborted) throw error;
  run.searchWarnings.push(`classificador ${classifier.name} falhou: ${errorMessage(error)}; usando regras`);
  if (judging) run.judgeFailures++;
}

export function funnelDetails(run: ResearchRun) {
  const details: Record<string, unknown> = {
    searchMode: run.options.searchMode ?? DEFAULT_SEARCH_MODE, funnel: { ...run.funnel },
    classifier: run.classifier?.name ?? "nenhum", classifierCost: run.classifierCost,
  };
  if (run.offTopicDiscarded.length) details.offTopicDiscarded = [...run.offTopicDiscarded];
  if (run.searchWarnings.length) details.searchWarnings = [...run.searchWarnings];
  return details;
}

const CRITERIA_IGNORED =
  "Critério ignorado — nenhum classificador disponível; resultados curados só por regras (sem Categoria nem descarte por Critério).";

/**
 * Aviso sobre o Critério (topo da Síntese e details): ignorado (sem
 * classificador) ou degradado (classificador falhou em parte dos julgamentos).
 */
export function criteriaNotice(run: ResearchRun): { text?: string; details: Record<string, string> } {
  if (run.options.criteria && !run.criteria) return { text: CRITERIA_IGNORED, details: { criteriaIgnored: CRITERIA_IGNORED } };
  if (run.criteria && run.classifier && run.judgeFailures) {
    const text = `Critério degradado — classificador ${run.classifier.name} falhou em ${run.judgeFailures} julgamento(s); `
      + "esses resultados/páginas foram curados só por regras (sem Categoria nem descarte por Critério).";
    return { text, details: { criteriaDegraded: text } };
  }
  return { details: {} };
}
