/**
 * Teste cru do provider.search() — sem mock, sem tool do PI, sem agente.
 *
 * Instancia o TavilyProvider direto, chama search() com uma query real,
 * e imprime o SearchResult[] completo. Este é o teste que prova que:
 *   1. A chave foi fornecida explicitamente no ambiente
 *   2. A API do Tavily responde com dados reais
 *   3. O mapeamento SearchResult está correto (title, url, summary)
 *
 * Uso:
 *   cd ~/.pi/agent/extensions/web-search/web-search.tests
 *   TAVILY_API_KEY=... node --experimental-strip-types raw-provider-search.test.mjs
 *
 * Rede opt-in: a chave é lida somente de TAVILY_API_KEY (env).
 */

const API_KEY = process.env.TAVILY_API_KEY;
if (!API_KEY || API_KEY.startsWith("<COLE")) {
  console.error("ERRO: TAVILY_API_KEY não configurada.");
  console.error("");
  console.error("Forneça TAVILY_API_KEY explicitamente no ambiente para habilitar este teste de rede.");
  process.exit(1);
}

// Import dinâmico pq o módulo é TypeScript (--experimental-strip-types).
const { TavilyProvider } = await import("../tavily-provider.ts");

const provider = new TavilyProvider(API_KEY);
const QUERY = "resultado jogo Brasil hoje 2026";

console.log(`Provider: ${provider.name}`);
console.log(`Query:    ${QUERY}`);
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
