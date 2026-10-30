// Nível de fonte por regras, spam e blockedDomains (ticket #6), exercitados pelo núcleo de Research.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupResearch, turn, fakeProvider, r, textOf } from "./research-harness.mjs";

const modelRef = { provider: "fake-llm", id: "fake-model" };

async function withResearch(setup, fn) {
  const h = await setupResearch({ modelRef, script: [turn.search("react hooks"), turn.text("fim")], ...setup });
  try { return await fn(h); } finally { await h.cleanup(); }
}

const order = (seen) => [...seen.matchAll(/^\d+\. .*\n(\S+)/gm)].map((m) => m[1]);

test("domínio oficial do assunto do Goal é rotulado oficial e vem antes de blog e fórum", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://www.reddit.com/r/reactjs/1", "Thread"),
      r("https://someblog.test/react", "Post"),
      r("https://react.dev/reference/react/useState", "useState"),
    ])],
  }, async (h) => {
    await h.run({ goal: "Como usar React hooks" });
    const [seen] = h.llm.toolResults();
    assert.deepEqual(order(seen), [
      "https://react.dev/reference/react/useState",
      "https://someblog.test/react",
      "https://www.reddit.com/r/reactjs/1",
    ]);
    assert.match(seen, /1\. useState \[oficial · tavily\]/);
    assert.match(seen, /2\. Post \[blog · tavily\]/);
    assert.match(seen, /3\. Thread \[fórum · tavily\]/);
  }));

test("oficial depende do assunto: react.dev não é oficial para Vue", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://react.dev/learn", "React"), r("https://vuejs.org/guide", "Vue")])],
    script: [turn.search("vue composition api"), turn.text("fim")],
  }, async (h) => {
    await h.run({ goal: "Vue composition API" });
    const [seen] = h.llm.toolResults();
    assert.match(seen, /1\. Vue \[oficial · tavily\]/);
    assert.match(seen, /2\. React \[blog · tavily\]/);
  }));

test("autoridade (.gov/.edu/rfc-editor/w3/ietf) é oficial; docs.*, developer.*, readthedocs e MDN são docs", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://stackoverflow.com/q/1", "SO"),
      r("https://news.ycombinator.com/item?id=1", "HN"),
      r("https://forum.discourse.test/t/1", "Disc"),
      r("https://medium.com/@x/post", "Medium"),
      r("https://docs.python.test/x", "DocsSub"),
      r("https://developer.apple.test/x", "DevSub"),
      r("https://lib.readthedocs.io/en/latest", "RTD"),
      r("https://developer.mozilla.org/en-US/docs/Web/HTTP", "MDN"),
      r("https://www.rfc-editor.org/rfc/rfc9110", "RFC"),
      r("https://www.w3.org/TR/html", "W3C"),
      r("https://datatracker.ietf.org/doc/x", "IETF"),
      r("https://nist.gov/x", "GOV"),
      r("https://mit.edu/x", "EDU"),
    ])],
    script: [turn.search("http semantics"), turn.text("fim")],
  }, async (h) => {
    await h.run({ goal: "HTTP semantics" }, { /* sem blockedDomains */ });
    const [seen] = h.llm.toolResults();
    // só 8 aparecem; oficiais (5) e depois docs (3)
    for (const t of ["RFC", "W3C", "IETF", "GOV", "EDU"]) assert.match(seen, new RegExp(`\\. ${t} \\[oficial · tavily\\]`));
    for (const t of ["DocsSub", "DevSub", "RTD"]) assert.match(seen, new RegExp(`\\. ${t} \\[docs · tavily\\]`));
    assert.equal((seen.match(/^\d+\. /gm) ?? []).length, 8);
  }));

test("no máximo 8 resultados por busca; fórum e blog continuam presentes abaixo", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://stackoverflow.com/q/1", "SO"),
      r("https://news.ycombinator.com/item?id=1", "HN"),
      r("https://forum.discourse.test/t/1", "Disc"),
      r("https://medium.com/@x/post", "Medium"),
      r("https://lib.readthedocs.io/en/latest", "RTD"),
      r("https://developer.mozilla.org/en-US/docs/Web/HTTP", "MDN"),
    ])],
    script: [turn.search("http"), turn.text("fim")],
  }, async (h) => {
    await h.run({ goal: "HTTP caching" });
    const [seen] = h.llm.toolResults();
    assert.match(seen, /1\. RTD \[docs · tavily\]/);
    assert.match(seen, /2\. MDN \[docs · tavily\]/);
    assert.match(seen, /3\. Medium \[blog · tavily\]/);
    for (const t of ["SO", "HN", "Disc"]) assert.match(seen, new RegExp(`\\. ${t} \\[fórum · tavily\\]`));
  }));

test("empate de Nível é resolvido pela Concordância", () =>
  withResearch({
    providers: [
      fakeProvider("tavily", [r("https://um.test/a", "Um"), r("https://dois.test/b", "Dois")]),
      fakeProvider("exa", [r("https://dois.test/b", "Dois"), r("https://react.dev/x", "Oficial")]),
    ],
  }, async (h) => {
    await h.run({ goal: "React" });
    const [seen] = h.llm.toolResults();
    assert.deepEqual(order(seen), ["https://react.dev/x", "https://dois.test/b", "https://um.test/a"]);
    assert.match(seen, /2\. Dois \[blog · tavily\+exa\]/);
  }));

test("trecho curto: resumo longo é encurtado", () =>
  withResearch({
    providers: [fakeProvider("tavily", [r("https://a.test/x", "A", "palavra ".repeat(200))])],
  }, async (h) => {
    await h.run({ goal: "React" });
    const [seen] = h.llm.toolResults();
    assert.ok(seen.length < 600, `resultado longo demais: ${seen.length}`);
    assert.match(seen, /…/);
  }));

test("spam da lista fixa e de blockedDomains é removido e contado em details e progresso", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://www.pinterest.com/pin/1", "Pin"),
      r("https://sub.fazenda.test/x", "Fazenda"),
      r("https://ok.test/x", "Ok"),
    ])],
  }, async (h) => {
    const result = await h.run({ goal: "React" }, { blockedDomains: ["fazenda.test"] });
    const [seen] = h.llm.toolResults();
    assert.doesNotMatch(seen, /pinterest|fazenda/);
    assert.match(seen, /1\. Ok \[blog · tavily\]/);
    assert.deepEqual(result.details.funnel, { found: 3, unique: 3, duplicates: 0, spam: 2 });
    assert.equal(h.progress.includes("3 resultados → 3 únicos → 1 após descarte (2 spam)"), true);
  }));

test("Fallback cru é curado: spam removido e ordenado por Nível", () =>
  withResearch({
    providers: [fakeProvider("tavily", [
      r("https://blog.test/x", "Blog"),
      r("https://www.pinterest.com/pin/1", "Pin"),
      r("https://react.dev/x", "Oficial"),
    ])],
    script: [turn.error(400, "quebrou")],
  }, async (h) => {
    const result = await h.run({ goal: "React hooks" });
    const text = textOf(result);
    assert.match(text, /1\. Oficial \[oficial · tavily\]\n   https:\/\/react\.dev\/x/);
    assert.match(text, /2\. Blog \[blog · tavily\]/);
    assert.doesNotMatch(text, /pinterest/);
    assert.equal(result.details.resultCount, 2);
    assert.equal(result.details.funnel.spam, 1);
  }));
