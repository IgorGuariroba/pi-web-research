/**
 * Teste cru do ExaProvider.search() — sem mock, sem tool do PI, sem agente.
 *
 * Instancia o ExaProvider direto, chama search() com uma query real,
 * e imprime o SearchResult[] completo.
 *
 * Uso:
 *   cd ~/.pi/agent/extensions/web-search/web-search.tests
 *   EXA_API_KEY=exa-... node --experimental-strip-types raw-exa-search.test.mjs
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { resolveKey } from "../state.ts";

const STATE_PATH = join(homedir(), ".pi", "agent", "extensions", "web-search", "state.json");
const API_KEY = resolveKey(STATE_PATH, "exa") || process.env.EXA_API_KEY;

if (!API_KEY || API_KEY.startsWith("<COLE")) {
  console.error("ERRO: EXA_API_KEY não configurada.");
  console.error("");
  console.error("Resolva com uma das opções:");
  console.error("  1) export EXA_API_KEY=...");
  console.error("  2) Use /web-search na TUI para configurar");
  process.exit(1);
}

const { ExaProvider } = await import("../exa-provider.ts");

const provider = new ExaProvider(API_KEY);
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
  console.log(`[${i}] title:       ${r.title}`);
  console.log(`    url:         ${r.url}`);
  console.log(`    summary:     ${r.summary}`);
  console.log(`    score:       ${r.score}`);
  console.log(`    source:      ${r.source}`);
  console.log(`    publishedAt: ${r.publishedAt?.toISOString() ?? "N/A"}`);
  console.log("");
}

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
if (response.provider !== "exa") {
  failures.push(`provider inesperado: ${response.provider}`);
}

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} FALHA(S):`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}

console.log(`\n✅ PASS (${response.results.length} resultados, ${elapsed}ms)`);
process.exit(0);
