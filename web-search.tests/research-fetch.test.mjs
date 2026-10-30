// Leitura segura e limpa (ticket #4): redirects com SSRF, Readability e
// Extração focada, observados pelo que o subagente recebe do fetch_url.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, textOf } from "./research-harness.mjs";

const MODEL = { provider: "fake-llm", id: "fake-model" };

async function readThrough(pages, urls, params = { goal: "X" }, extraScript = []) {
  const h = await setupResearch({
    providers: [fakeProvider("tavily")], pages, modelRef: MODEL,
    script: [...urls.map((u) => turn.fetch(u)), ...extraScript, turn.text("fim")],
  });
  try {
    const result = await h.run(params);
    return { result, toolResults: h.llm.toolResults(), requests: [...h.pages.requests] };
  } finally {
    await h.cleanup();
  }
}

test("leitura: redirects encadeados são seguidos até a página final", async () => {
  const { toolResults, requests } = await readThrough({
    "http://a.test/velho": { status: 301, headers: { location: "https://a.test/velho" } },
    "https://a.test/velho": { status: 302, headers: { location: "/novo/" } },
    "https://a.test/novo/": { status: 308, headers: { location: "https://b.test/final" } },
    "https://b.test/final": "<html><body><article><p>Conteúdo final da página.</p></article></body></html>",
  }, ["http://a.test/velho"]);
  assert.deepEqual(requests, ["http://a.test/velho", "https://a.test/velho", "https://a.test/novo/", "https://b.test/final"]);
  assert.match(toolResults[0], /URL final: https:\/\/b\.test\/final/);
  assert.match(toolResults[0], /Conteúdo final da página\./);
});

for (const target of ["http://127.0.0.1/admin", "http://10.0.0.1/interno", "http://localhost:8080/", "http://169.254.169.254/latest/meta-data"]) {
  test(`leitura: redirect para host local/IP privado é bloqueado (${target})`, async () => {
    const { result, toolResults, requests } = await readThrough({
      "https://publico.test/x": { status: 302, headers: { location: "https://publico.test/y" } },
      "https://publico.test/y": { status: 302, headers: { location: target } },
      [target]: "<p>segredo interno</p>",
    }, ["https://publico.test/x"]);
    assert.equal(result.details.synthesized, true);
    assert.deepEqual(requests, ["https://publico.test/x", "https://publico.test/y"]);
    assert.match(toolResults[0], /bloqueou host local ou IP privado/);
    assert.doesNotMatch(toolResults[0], /segredo interno/);
  });
}

const ARTICLE_PAGE = `<!doctype html><html><head><title>Guia de cache HTTP</title></head><body>
<header><nav><ul><li><a href="/">Início MENUTOPO</a></li><li><a href="/blog">Blog MENUTOPO</a></li><li><a href="/contato">Contato MENUTOPO</a></li></ul></nav></header>
<aside class="sidebar"><h3>Posts populares LATERAL</h3><ul><li><a href="/p1">Outro post LATERAL</a></li></ul></aside>
<main><article><h1>Guia de cache HTTP</h1>
<p>O cabeçalho Cache-Control controla por quanto tempo uma resposta pode ser reutilizada por navegadores e proxies intermediários, sendo a peça central de qualquer estratégia de cache na web moderna.</p>
<p>A diretiva max-age define o tempo de vida em segundos, enquanto no-store proíbe qualquer armazenamento da resposta, o que é útil para dados sensíveis que nunca devem ficar em disco.</p>
<p>Já o ETag permite revalidação condicional: o cliente envia If-None-Match e o servidor responde 304 quando o recurso não mudou, economizando banda sem abrir mão da consistência dos dados.</p>
</article></main>
<footer><p>© 2024 Empresa RODAPE. Todos os direitos reservados. Política de privacidade RODAPE.</p></footer>
</body></html>`;

test("leitura: menu, rodapé e navegação não aparecem no conteúdo lido", async () => {
  const { toolResults } = await readThrough({ "https://blog.test/cache": ARTICLE_PAGE }, ["https://blog.test/cache"], { goal: "Como funciona o cache HTTP com Cache-Control e ETag" });
  assert.match(toolResults[0], /Cache-Control controla/);
  assert.match(toolResults[0], /ETag permite revalidação/);
  assert.doesNotMatch(toolResults[0], /MENUTOPO|RODAPE|LATERAL/);
});

test("leitura: HTML que o Readability não processa cai na conversão simples", async () => {
  const { toolResults } = await readThrough({
    "https://curta.test/a": "<html><body><span>Status: operacional</span><br><span>Versão 2.3.1</span></body></html>",
    "https://curta.test/b": "<table><tr><td>chave</td><td>valor-unico-77</td></tr></table>",
  }, ["https://curta.test/a", "https://curta.test/b"]);
  assert.match(toolResults[0], /Status: operacional\nVersão 2\.3\.1/);
  assert.match(toolResults[1], /valor-unico-77/);
});

const filler = (i) => `<p>Parágrafo genérico número ${i} sobre assuntos variados do cotidiano, com bastante texto irrelevante para encher a página e simular um artigo extenso que fala de clima, culinária, esportes e viagens sem nenhum foco específico.</p>`;
const longArticle = (special) => {
  const parts = Array.from({ length: 120 }, (_, i) => filler(i));
  for (const [pos, html] of special) parts.splice(pos, 0, html);
  return `<html><head><title>Artigo longo</title></head><body><article><h1>Artigo longo</h1>${parts.join("\n")}</article></body></html>`;
};

test("extração focada: devolve ~5k caracteres com os trechos do Goal, Focus e query", async () => {
  const page = longArticle([
    [90, "<p>O ornitorrinco é um mamífero monotremado que bota ovos e possui bico semelhante ao de pato. TRECHO-GOAL</p>"],
    [40, "<p>A eletrorrecepção permite ao ornitorrinco detectar presas debaixo d'água. TRECHO-FOCUS</p>"],
    [110, "<p>O veneno do esporão dos machos causa dor intensa em humanos. TRECHO-QUERY</p>"],
  ]);
  const h = await setupResearch({
    providers: [fakeProvider("tavily")], pages: { "https://bio.test/orni": page }, modelRef: MODEL,
    script: [turn.search("veneno esporão machos"), turn.fetch("https://bio.test/orni"), turn.text("fim")],
  });
  try {
    await h.run({ goal: "Por que o ornitorrinco é um mamífero que bota ovos", focus: "eletrorrecepção" });
    const read = h.llm.toolResults()[1];
    assert.ok(page.length > 25_000);
    assert.ok(read.length <= 5_500, `leitura com ${read.length} caracteres`);
    assert.match(read, /TRECHO-GOAL/);
    assert.match(read, /TRECHO-FOCUS/);
    assert.match(read, /TRECHO-QUERY/);
  } finally {
    await h.cleanup();
  }
});

test("extração focada: JSON e texto puro passam pela mesma seleção de trechos", async () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ id: i, nome: `item genérico ${i}`, descricao: "registro qualquer sem importância para a pergunta feita" }));
  items.splice(250, 0, { id: 9999, nome: "capivara", descricao: "maior roedor do mundo JSON-ALVO" });
  const lines = Array.from({ length: 300 }, (_, i) => `linha ${i}: conteúdo de log sem relação nenhuma com o objetivo`);
  lines.splice(200, 0, "linha especial: a capivara pesa até 65 kg TEXTO-ALVO");
  const { toolResults } = await readThrough({
    "https://api.test/itens.json": { contentType: "application/json", body: JSON.stringify(items) },
    "https://api.test/itens-pretty.json": { contentType: "application/json; charset=utf-8", body: JSON.stringify(items, null, 2) },
    "https://txt.test/log.txt": { contentType: "text/plain", body: lines.join("\n") },
  }, ["https://api.test/itens.json", "https://api.test/itens-pretty.json", "https://txt.test/log.txt"], { goal: "Quanto pesa a capivara, o maior roedor" });
  for (const [i, marker] of [[0, /JSON-ALVO/], [1, /JSON-ALVO/], [2, /TEXTO-ALVO/]]) {
    assert.ok(toolResults[i].length <= 5_500, `leitura ${i} com ${toolResults[i].length} caracteres`);
    assert.match(toolResults[i], marker);
  }
});

test("leitura: PDF retorna erro claro e não consome o orçamento de leituras", async () => {
  // quick = 4 leituras: 2 PDFs + 4 páginas devem caber; a 5ª página é recusada.
  const pages = {
    "https://docs.test/manual": { contentType: "application/pdf", body: "%PDF-1.7 binário" },
    "https://docs.test/relatorio.pdf": { contentType: "application/pdf", body: "%PDF-1.4" },
  };
  for (let i = 0; i < 5; i++) pages[`https://p.test/${i}`] = `<p>página ${i}</p>`;
  const urls = ["https://docs.test/manual", "https://docs.test/relatorio.pdf", ...Array.from({ length: 5 }, (_, i) => `https://p.test/${i}`)];
  const { result, toolResults } = await readThrough(pages, urls);
  assert.equal(result.details.synthesized, true);
  assert.match(toolResults[0], /PDF não suportado/);
  assert.match(toolResults[1], /PDF não suportado/);
  for (let i = 2; i < 6; i++) assert.match(toolResults[i], new RegExp(`página ${i - 2}`));
  assert.match(toolResults[6], /Orçamento de páginas esgotado/);
});
