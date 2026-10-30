/**
 * goose-provider.ts — provedor Goose (computercontroller / web_search).
 *
 * Responsabilidade: apenas I/O — executar o `goose run` e delegar a tradução do
 * formato cru ao GooseAdapter (goose-adapter.ts). Toda a lógica de parsing e
 * montagem da SearchResponse vive no adapter (pura, testável).
 */

import type { ExecFn, SearchOptions, SearchResponse, WebSearchProvider } from "./search-types.ts";
import {
  buildSearchPrompt,
  capStderr,
  extractAssistantText,
  extractTokens,
  gooseResponseFromText,
} from "./goose-adapter.ts";
import { existsSync } from "node:fs";
import { errorMessage } from "./error-message.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TURNS = 3;

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveGooseBin(): string {
  const envVal = process.env.PI_GOOSE_PATH;
  return envVal && envVal.trim() ? envVal.trim() : "goose";
}

function gooseConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".config");
  return join(base, "goose", "config.yaml");
}

/** Fail-fast: mensagem acionável se o goose não está pronto para uso headless. */
function gooseReadinessError(): string | null {
  const override = process.env.PI_GOOSE_PATH;
  if (override && !existsSync(override)) {
    return `goose: binário não encontrado em PI_GOOSE_PATH=${override}`;
  }
  const hasEnvProvider = Boolean(process.env.GOOSE_PROVIDER && process.env.GOOSE_MODEL);
  const hasConfigFile = existsSync(gooseConfigPath());
  if (!hasEnvProvider && !hasConfigFile) {
    return [
      "goose está instalado mas não configurado para uso headless.",
      "",
      "Não há GOOSE_PROVIDER/GOOSE_MODEL no ambiente nem config em:",
      `  ${gooseConfigPath()}`,
      "",
      "Resolva com uma das opções:",
      "  1) rode: goose configure",
      "  2) exporte: GOOSE_PROVIDER=<provider> GOOSE_MODEL=<modelo>",
    ].join("\n");
  }
  return null;
}

/** Shape esperado do `providerOptions` do Goose. */
interface GooseProviderOptions {
  maxTurns: number;
}

function parseGooseOptions(raw: unknown, defaultMaxTurns: number): GooseProviderOptions {
  if (raw == null) return { maxTurns: defaultMaxTurns };
  const obj = raw as Record<string, unknown>;
  const maxTurns = obj.maxTurns;
  if (typeof maxTurns !== "number" || !Number.isFinite(maxTurns) || maxTurns < 1) {
    throw new Error(`goose: providerOptions.maxTurns inválido: ${JSON.stringify(raw)}`);
  }
  return { maxTurns };
}

export class GooseBuiltinProvider implements WebSearchProvider {
  readonly name = "goose:computercontroller";
  private readonly exec: ExecFn;

  constructor(exec: ExecFn) {
    this.exec = exec;
  }

  async search(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
    const readiness = gooseReadinessError();
    if (readiness) throw new Error(readiness);

    const bin = resolveGooseBin();
    const timeoutMs = options.timeoutMs ?? envNumber("PI_WEB_SEARCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    const { maxTurns } = parseGooseOptions(options.providerOptions, envNumber("PI_WEB_SEARCH_MAX_TURNS", DEFAULT_MAX_TURNS));

    const args = [
      "run",
      "--no-session",
      "--no-profile",
      "--with-builtin", "computercontroller",
      "--max-turns", String(maxTurns),
      "--max-tool-repetitions", "1",
      "--quiet",
      "--output-format", "json",
      "-t", buildSearchPrompt(query),
    ];

    const start = Date.now();
    let res;
    try {
      res = await this.exec(bin, args, { signal, timeout: timeoutMs });
    } catch (err) {
      throw new Error(`web_search: falha ao executar goose (${bin}): ${errorMessage(err)}`);
    }
    const durationMs = Date.now() - start;

    if (res.killed) throw new Error(`web_search: abortado ou timeout de ${timeoutMs}ms atingido`);

    const rawAssistantText = extractAssistantText(res.stdout);

    if (rawAssistantText.length === 0 && res.code !== 0) {
      const why = capStderr(res.stderr) || "sem saída do assistente";
      throw new Error(`web_search: goose saiu com código ${res.code} — ${why}`);
    }

    const tokens = extractTokens(res.stdout);
    return gooseResponseFromText(rawAssistantText, this.name, durationMs, tokens);
  }
}
