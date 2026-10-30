/**
 * state.ts — storage próprio da extensão web-search.
 *
 * Arquivo único `state.json` contendo chaves API e provider ativo.
 * Tratado inteiramente como secreto: permissões 0600 (arquivo) e 0700
 * (diretório-pai). Nunca lê `settings.json` — essa fonte foi aposentada.
 *
 * Formato:
 *   {
 *     activeProvider?: "tavily" | "exa" | "goose",
 *     researchModel?: { provider, id },
 *     searchMode?: "agregada" | "econômica",
 *     blockedDomains?: string[],
 *     keys?: { tavily?: string, exa?: string }
 *   }
 *
 * Resolução de chave (prioridade):
 *   state.json.keys.<provider> → process.env.<PROVIDER>_API_KEY
 */

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// --------------------------------------------------------------------------- //
// Tipos
// --------------------------------------------------------------------------- //

export type ProviderName = "tavily" | "exa" | "goose";

export interface WebSearchState {
  activeProvider?: ProviderName;
  researchModel?: { provider: string; id: string };
  /** Modo de busca: `agregada` (padrão) ou `econômica`. */
  searchMode?: "agregada" | "econômica";
  /** Domínios cortados como spam, além da lista fixa. */
  blockedDomains?: string[];
  keys?: {
    tavily?: string;
    exa?: string;
  };
}

/** Env var name para cada provider (fallback quando state.json não tem a chave). */
const PROVIDER_ENV_MAP: Record<string, string> = {
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
};

// --------------------------------------------------------------------------- //
// Permissões
// --------------------------------------------------------------------------- //

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// --------------------------------------------------------------------------- //
// initSecureStateFile — cria o arquivo com permissões seguras se não existir.
// Idempotente: não sobrescreve se já existe.
// --------------------------------------------------------------------------- //

export function initSecureStateFile(filePath: string): void {
  if (existsSync(filePath)) {
    // Reforça permissões mesmo se já existe
    try {
      chmodSync(filePath, FILE_MODE);
    } catch {
      //chmod pode falhar em certos FS; não é fatal
    }
    return;
  }

  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // Reforça permissão do diretório recém-criado
    try {
      chmodSync(dir, DIR_MODE);
    } catch {
      // ok
    }
  }

  writeFileSync(filePath, JSON.stringify({ activeProvider: undefined, keys: {} }, null, 2) + "\n", {
    mode: FILE_MODE,
  });
  // Reforço duplo de permissão
  try {
    chmodSync(filePath, FILE_MODE);
  } catch {
    // ok
  }
}

// --------------------------------------------------------------------------- //
// loadState — lê o state.json. Em caso de erro, devolve state vazio.
// --------------------------------------------------------------------------- //

export function loadState(filePath: string): WebSearchState {
  const empty: WebSearchState = { activeProvider: undefined, keys: {} };
  try {
    if (!existsSync(filePath)) return empty;
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as WebSearchState;
    const researchModel = parsed.researchModel;
    return {
      activeProvider: parsed.activeProvider,
      ...(researchModel && typeof researchModel.provider === "string" && typeof researchModel.id === "string"
        ? { researchModel }
        : {}),
      ...(parsed.searchMode === "agregada" || parsed.searchMode === "econômica" ? { searchMode: parsed.searchMode } : {}),
      ...(Array.isArray(parsed.blockedDomains)
        ? { blockedDomains: parsed.blockedDomains.filter((d): d is string => typeof d === "string") }
        : {}),
      keys: parsed.keys ?? {},
    };
  } catch {
    return empty;
  }
}

// --------------------------------------------------------------------------- //
// saveState — grava o state.json. Garante permissões 0600.
// --------------------------------------------------------------------------- //

export function saveState(filePath: string, state: WebSearchState): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }

  writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", { mode: FILE_MODE });
  // Reforço duplo
  try {
    chmodSync(filePath, FILE_MODE);
  } catch {
    // ok
  }
}

// --------------------------------------------------------------------------- //
// resolveKey — resolve a chave de um provider.
// Prioridade: state.json.keys.<provider> → process.env.<PROVIDER>_API_KEY
// --------------------------------------------------------------------------- //

export function resolveKey(statePath: string, provider: string): string | undefined {
  const state = loadState(statePath);
  const fromState = state.keys?.[provider as keyof NonNullable<WebSearchState["keys"]>];
  if (fromState) return fromState;

  const envVar = PROVIDER_ENV_MAP[provider];
  if (envVar) return process.env[envVar];

  return undefined;
}
