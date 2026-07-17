/**
 * Teste cru do provider.search() — sem mock, sem tool do PI, sem agente.
 *
 * Instancia o TavilyProvider direto, chama search() com uma query real,
 * e imprime o SearchResult[] completo. Este é o teste que prova que:
 *   1. A chave está acessível no ambiente persistente
 *   2. A API do Tavily responde com dados reais
 *   3. O mapeamento SearchResult está correto (title, url, summary)
 *
 * Uso:
 *   cd ~/.pi/agent/extensions/web-search/web-search.tests
 *   node --experimental-strip-types raw-provider-search.test.mjs
 *
 * A chave é lida de: TAVILY_API_KEY (env) ou ~/.pi/agent/settings.json (env.TAVILY_API_KEY).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Resolve a chave (mesma lógica do extension, duplicada para independência)
// ---------------------------------------------------------------------------

function resolveTavilyKey() {
  if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    const env = settings.env;
    if (env?.TAVILY_API_KEY) return env.TAVILY_API_KEY;
  } catch {
    // segue
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const API_KEY = resolveTavilyKey();
if (!API_KEY || API_KEY.startsWith("<COLE")) {
  console.error("ERRO: TAVILY_API_KEY não configurada.");
  console.error("");
  console.error("Resolva com uma das opções:");
  console.error("  1) export TAVILY_API_KEY=tvly-...");
  console.error("  2) Adicione ao ~/.pi/agent/settings.json:");
  console.error('     "env": { "TAVILY_API_KEY": "tvly-..." }');
  console.error("");
  console.error("Depois de rotacionar a chave em https://app.tavily.com/");
  process.exit(1);
}

// Import dinâmico pq o módulo é TypeScript (--experimental-strip-types).
const { TavilyProvider } = await import("../tavily-provider.ts");

const provider = new TavilyProvider(API_KEY);
const QUERY = "resultado jogo Brasil hoje 2026";

console.log(`Provider: ${provider.name}`);
console.log(`Query:    ${QUERY}`);
console.log(`Key:      ${API_KEY.slice(0, 8)}...`);
console.log("");

const start = Date.now();
let response;
try {
  response = await provider.search(QUERY, { timeoutMs: 30_000 });
} catch (err) {
  console.error(`FALHA: ${err.message}`);
  process.exit(2);
}
const elapsed = Date.now() - start;

console.log(`Status:   OK (${elapsed}ms)`);
console.log(`Results:  ${response.results.length}`);
console.log(`Provider: ${response.provider}`);
console.log(`Warnings: ${response.warnings.length > 0 ? response.warnings.join("; ") : "nenhum"}`);
console.log("");

// --- Resultados crus (SearchResult[]) ---
console.log("=== SearchResult[] ===");
for (const [i, r] of response.results.entries()) {
  console.log(`[${i}] title:   ${r.title}`);
  console.log(`    url:     ${r.url}`);
  console.log(`    summary: ${r.summary}`);
  console.log(`    score:   ${r.score}`);
  console.log(`    source:  ${r.source}`);
  console.log("");
}

// --- Telemetria ---
console.log("=== Telemetry ===");
console.log(JSON.stringify(response.telemetry, null, 2));

// --- Validações mínimas ---
const failures = [];
if (response.results.length === 0) {
  failures.push("results vazio — provider não retornou dados");
}
for (const r of response.results) {
  if (!r.title) failures.push(`resultado sem title: ${JSON.stringify(r)}`);
  if (!r.url) failures.push(`resultado sem url: ${JSON.stringify(r)}`);
  if (!r.summary) failures.push(`resultado sem summary: ${JSON.stringify(r)}`);
}
if (response.provider !== "tavily") {
  failures.push(`provider inesperado: ${response.provider}`);
}

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} FALHA(S):`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}

console.log(`\n✅ PASS (${response.results.length} resultados, ${elapsed}ms)`);
process.exit(0);
