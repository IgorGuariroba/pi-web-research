/**
 * classifier.ts — Classificador (ADR 0002).
 *
 * Interface estreita usada pelo núcleo de Research para julgar resultados de
 * busca numa única chamada por busca: Fora do tema (probabilidade) e Nível de
 * fonte. Implementação de produção sobre `modelRegistry.classify()` do Pi;
 * ausência de classificador (`undefined`) ativa o caminho só com regras.
 * Documentação: ~/.cache/pi-web-research-notes/classifier.md.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SourceLevel } from "./source-level.ts";

/** Nível atribuído pelo classificador; `spam` sai do Funil. */
export type JudgedLevel = SourceLevel | "spam";

export interface ResultToJudge {
  url: string;
  title: string;
  summary?: string;
}

export interface JudgeResultsInput {
  goal: string;
  focus?: string;
  query: string;
  results: readonly ResultToJudge[];
}

export interface ResultJudgement {
  /** Probabilidade (0..1) de o resultado estar Fora do tema. */
  offTopic: number;
  level: JudgedLevel;
}

export interface JudgeResultsOutput {
  /** Um julgamento por resultado, na mesma ordem do input. */
  judgements: ResultJudgement[];
  /** Custo da chamada em USD. */
  costUsd: number;
}

export interface Classifier {
  /** Identificação exibida nos details (ex.: `openrouter/typesafe/jev-1.14`). */
  readonly name: string;
  /** Uma chamada por busca. Rejeita em falha (o núcleo cai nas regras). */
  judgeResults(input: JudgeResultsInput, signal?: AbortSignal): Promise<JudgeResultsOutput>;
}

/** Escolha persistida em /web-search. */
export type ClassifierChoice = "auto" | "none" | { provider: string; id: string };

/** Acima deste limiar o resultado é descartado como Fora do tema. */
export const OFF_TOPIC_THRESHOLD = 0.7;

/** Preferência da detecção automática: Jev (OpenRouter, TypeSafe, Cloudflare, opencode), depois Clef. */
export const CLASSIFIER_PREFERENCE: readonly (readonly [string, string])[] = [
  ["openrouter", "typesafe/jev-1.14"], ["openrouter", "~typesafe/jev-latest"], ["openrouter", "typesafe/jev-1.13"],
  ["typesafe", "jev-latest"],
  ["cloudflare-workers-ai", "typesafe/jev-1.14.0"], ["cloudflare-workers-ai", "typesafe/jev"],
  ["opencode", "jev-1.13"], ["opencode", "jev-1.13-free"],
  ["openrouter", "cloudflare/clef-flash"], ["cloudflare-workers-ai", "@cf/cloudflare/clef-flash"],
  ["openrouter", "cloudflare/clef"], ["cloudflare-workers-ai", "@cf/cloudflare/clef"],
];

/** Chaves das perguntas do resultado `i` no ClassifierContext (convenção do adaptador Pi). */
export const questionKeys = (i: number) => ({ offTopic: `r${i}_offtopic`, level: `r${i}_level` });

const LEVEL_LABELS: Record<string, JudgedLevel> = {
  oficial: "oficial", docs: "docs", blog: "blog", forum: "fórum", spam: "spam",
};

const SUMMARY_MAX = 300;

type ClassifierModel = Parameters<ModelRegistry["classify"]>[0];

/** Adaptador do Classificador sobre a classificação do model registry do Pi. */
export function piClassifier(registry: ModelRegistry, model: ClassifierModel): Classifier {
  return {
    name: `${model.provider}/${model.id}`,
    async judgeResults(input, signal) {
      const questions: Record<string, unknown> = {};
      input.results.forEach((_, i) => {
        const keys = questionKeys(i);
        questions[keys.offTopic] = {
          type: "bool",
          instructions: `results[${i}] está fora do tema do goal (não ajuda a responder goal/focus)?`,
          criteria: { true: "fora do tema: assunto diferente do goal", false: "relacionado ao goal" },
        };
        questions[keys.level] = {
          type: "choice",
          instructions: `Nível de fonte de results[${i}] em relação ao assunto do goal.`,
          criteria: {
            oficial: "site oficial do projeto/produto/organização do assunto, ou norma/autoridade",
            docs: "documentação técnica ou referência (não oficial do assunto)",
            blog: "artigo, blog, tutorial ou notícia",
            forum: "fórum, Q&A, discussão de comunidade",
            spam: "spam, fazenda de conteúdo, SEO sem conteúdo",
          },
        };
      });
      const state = {
        goal: input.goal, ...(input.focus ? { focus: input.focus } : {}), query: input.query,
        results: input.results.map((result) => ({
          url: result.url, title: result.title, summary: (result.summary ?? "").slice(0, SUMMARY_MAX),
        })),
      };
      const response = await registry.classify(model, { state, questions } as never, { signal });
      if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `classificador: ${response.stopReason}`);
      const judgements = input.results.map((_, i): ResultJudgement => {
        const keys = questionKeys(i);
        const offTopic = response.answers[keys.offTopic];
        const level = response.answers[keys.level];
        return {
          offTopic: offTopic?.type === "bool" ? offTopic.probability : 0,
          level: (level?.type === "choice" && LEVEL_LABELS[level.choice]) || "blog",
        };
      });
      return { judgements, costUsd: response.usage?.cost.total ?? 0 };
    },
  };
}

/**
 * Resolve o Classificador da escolha salva: `none` → sem classificador;
 * `{provider,id}` → esse, se disponível; `auto` → primeiro da preferência disponível.
 */
export async function detectClassifier(registry: ModelRegistry, choice: ClassifierChoice = "auto"): Promise<Classifier | undefined> {
  if (choice === "none") return undefined;
  let available: readonly ClassifierModel[];
  try {
    available = (await registry.getAvailableOfType("classifier")) as readonly ClassifierModel[];
  } catch {
    return undefined;
  }
  const find = (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id);
  const model = typeof choice === "object"
    ? find(choice.provider, choice.id)
    : CLASSIFIER_PREFERENCE.map(([provider, id]) => find(provider, id)).find(Boolean);
  return model ? piClassifier(registry, model) : undefined;
}
