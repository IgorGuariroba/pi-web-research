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
import { OTHER_CATEGORY, type Criterion } from "./criteria.ts";

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
  /** Critério do Agente pai: com ele, cada resultado também recebe uma Categoria. */
  criteria?: readonly Criterion[];
}

export interface ResultJudgement {
  /** Probabilidade (0..1) de o resultado estar Fora do tema. */
  offTopic: number;
  level: JudgedLevel;
  /** Categoria do Critério (ou `outros`); só quando o input traz `criteria`. */
  category?: string;
}

export interface JudgeResultsOutput {
  /** Um julgamento por resultado, na mesma ordem do input. */
  judgements: ResultJudgement[];
  /** Custo da chamada em USD. */
  costUsd: number;
}

export interface ScorePassagesInput {
  goal: string;
  focus?: string;
  /** Última query buscada, se houver. */
  query?: string;
  /** Trechos candidatos da página (pré-selecionados pelas regras). */
  passages: readonly string[];
}

export interface ScorePassagesOutput {
  /** Nota de relevância (0..1) de cada trecho, na mesma ordem do input. */
  scores: number[];
  /** Custo da chamada em USD. */
  costUsd: number;
}

export interface Classifier {
  /** Identificação exibida nos details (ex.: `openrouter/typesafe/jev-1.14`). */
  readonly name: string;
  /**
   * Uma chamada por busca (e uma por leitura de página fora das buscas).
   * Rejeita em falha (o núcleo cai nas regras).
   */
  judgeResults(input: JudgeResultsInput, signal?: AbortSignal): Promise<JudgeResultsOutput>;
  /**
   * Extração focada: nota de relevância dos trechos contra Goal + Focus + query.
   * Opcional; ausente ou rejeitando → Extração focada por regras.
   */
  scorePassages?(input: ScorePassagesInput, signal?: AbortSignal): Promise<ScorePassagesOutput>;
}

/** Escolha persistida em /web-search. */
export type ClassifierChoice = "auto" | "none" | { provider: string; id: string };

/** Escolha padrão: detecção automática. */
export const DEFAULT_CLASSIFIER: ClassifierChoice = "auto";

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
export const questionKeys = (i: number) => ({ offTopic: `r${i}_offtopic`, level: `r${i}_level`, category: `r${i}_category` });

/** Chave da pergunta de relevância do trecho `i` (adaptador Pi). */
export const passageKey = (i: number) => `p${i}_relevant`;

/**
 * Rótulos de choice das Categorias (sem acento/espaço) → Categoria original,
 * na ordem do Critério, mais `outros`. Mapeamento único: slug repetido, vazio
 * ou `outros` ganha `c<n>` livre (nunca o slug de outra Categoria).
 */
export function categoryLabels(criteria: readonly Criterion[]): Map<string, string> {
  const slugs = criteria.map((criterion) => criterion.category.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, ""));
  const used = new Set<string>([OTHER_CATEGORY]);
  const own = slugs.map((slug) => (slug && !used.has(slug) ? (used.add(slug), slug) : undefined));
  let next = 0;
  const free = () => {
    while (used.has(`c${next}`)) next++;
    used.add(`c${next}`);
    return `c${next}`;
  };
  const labels = new Map<string, string>();
  criteria.forEach((criterion, i) => labels.set(own[i] ?? free(), criterion.category));
  labels.set(OTHER_CATEGORY, OTHER_CATEGORY);
  return labels;
}

const LEVEL_LABELS: Record<string, JudgedLevel> = {
  oficial: "oficial", docs: "docs", blog: "blog", forum: "fórum", spam: "spam",
};

const SUMMARY_MAX = 300;

/**
 * Referência ao resultado dentro da própria pergunta: o julgamento é em lote
 * (uma chamada por busca, decisão da spec), então cada pergunta repete título e
 * URL do item para o modelo não depender só do índice.
 */
const itemRef = (i: number, result: ResultToJudge) => `results[${i}] ("${result.title.slice(0, 120)}" — ${result.url})`;

type ClassifierModel = Parameters<ModelRegistry["classify"]>[0];

/** Adaptador do Classificador sobre a classificação do model registry do Pi. */
export function piClassifier(registry: ModelRegistry, model: ClassifierModel): Classifier {
  /** Uma `classify` do registry; rejeita se o modelo não terminou normalmente. */
  const classify = async (context: { state: unknown; questions: Record<string, unknown> }, signal?: AbortSignal) => {
    const response = await registry.classify(model, context as never, { signal });
    if (response.stopReason !== "stop") throw new Error(response.errorMessage ?? `classificador: ${response.stopReason}`);
    return response;
  };
  return {
    name: `${model.provider}/${model.id}`,
    async judgeResults(input, signal) {
      const questions: Record<string, unknown> = {};
      const criteria = input.criteria?.length ? input.criteria : undefined;
      const labels = criteria ? categoryLabels(criteria) : undefined;
      const categoryCriteria: Record<string, string> = {};
      if (criteria && labels) {
        for (const [label, category] of labels) {
          const criterion = criteria.find((c) => c.category === category);
          categoryCriteria[label] = criterion ? criterion.description : "não se encaixa em nenhuma das outras Categorias";
        }
      }
      input.results.forEach((result, i) => {
        const keys = questionKeys(i);
        const item = itemRef(i, result);
        questions[keys.offTopic] = {
          type: "bool",
          instructions: `O assunto de ${item} é diferente do assunto do goal?`,
          criteria: {
            true: "fora do tema: trata de outro assunto (ex.: homônimo, outro produto, outro domínio)",
            false: "mesmo assunto do goal, ainda que genérico, introdutório ou pouco detalhado",
          },
        };
        questions[keys.level] = {
          type: "choice",
          instructions: `Nível de fonte de ${item} em relação ao assunto do goal.`,
          criteria: {
            oficial: "site oficial do projeto/produto/organização do assunto, ou norma/autoridade",
            docs: "documentação técnica ou referência (não oficial do assunto)",
            blog: "artigo, blog, tutorial ou notícia",
            forum: "fórum, Q&A, discussão de comunidade",
            spam: "spam, fazenda de conteúdo, SEO sem conteúdo",
          },
        };
        if (criteria) {
          questions[keys.category] = {
            type: "choice",
            instructions: `Categoria do Critério (tipo de fonte) que melhor descreve ${item}.`,
            criteria: categoryCriteria,
          };
        }
      });
      const state = {
        goal: input.goal, ...(input.focus ? { focus: input.focus } : {}), query: input.query,
        results: input.results.map((result) => ({
          url: result.url, title: result.title, summary: (result.summary ?? "").slice(0, SUMMARY_MAX),
        })),
        ...(criteria ? { criteria: criteria.map(({ category, description }) => ({ category, description })) } : {}),
      };
      const response = await classify({ state, questions }, signal);
      const judgements = input.results.map((_, i): ResultJudgement => {
        const keys = questionKeys(i);
        const offTopic = response.answers[keys.offTopic];
        const level = response.answers[keys.level];
        const category = response.answers[keys.category];
        return {
          offTopic: offTopic?.type === "bool" ? offTopic.probability : 0,
          level: (level?.type === "choice" && LEVEL_LABELS[level.choice]) || "blog",
          ...(labels ? { category: (category?.type === "choice" && labels.get(category.choice)) || OTHER_CATEGORY } : {}),
        };
      });
      return { judgements, costUsd: response.usage?.cost.total ?? 0 };
    },
    async scorePassages(input, signal) {
      const questions: Record<string, unknown> = {};
      input.passages.forEach((_, i) => {
        questions[passageKey(i)] = {
          type: "bool",
          instructions: `passages[${i}] traz informação útil para responder o goal (considerando focus e query)?`,
          criteria: { true: "relevante: responde ou sustenta o goal", false: "irrelevante: navegação, assunto lateral ou genérico" },
        };
      });
      const state = {
        goal: input.goal, ...(input.focus ? { focus: input.focus } : {}), ...(input.query ? { query: input.query } : {}),
        passages: [...input.passages],
      };
      const response = await classify({ state, questions }, signal);
      const scores = input.passages.map((_, i) => {
        const answer = response.answers[passageKey(i)];
        return answer?.type === "bool" ? answer.probability : 0;
      });
      return { scores, costUsd: response.usage?.cost.total ?? 0 };
    },
  };
}

/**
 * Resolve o Classificador da escolha salva: `none` → sem classificador;
 * `{provider,id}` → esse, se disponível; `auto` → primeiro da preferência disponível.
 */
export async function detectClassifier(registry: ModelRegistry, choice: ClassifierChoice = DEFAULT_CLASSIFIER): Promise<Classifier | undefined> {
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
