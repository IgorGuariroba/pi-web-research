import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasRealCode,
  hasRelevantChanges,
  isRelevantFile,
  mutationRanges,
  requiresFullMutation,
  stripCommentsAndWhitespace,
} from "../scripts/mutation-scope.mjs";

test("mutation: stripCommentsAndWhitespace remove comentários e whitespace preservando literais", () => {
  assert.equal(stripCommentsAndWhitespace("// comentário de linha\nconst a = 1;"), "consta=1;");
  assert.equal(stripCommentsAndWhitespace("/* bloco \n de comentário */ const b = 2;"), "constb=2;");
  assert.equal(stripCommentsAndWhitespace('const url = "http://example.com//path"; // fim'), 'consturl="http://example.com//path";');
  assert.equal(stripCommentsAndWhitespace("const msg = '/* não é bloco */';"), "constmsg='/* não é bloco */';");
  assert.equal(stripCommentsAndWhitespace("const tmpl = `foo // bar`;"), "consttmpl=`foo // bar`;");
  assert.equal(stripCommentsAndWhitespace("   \n\t  // vazio\n  /* vazio */ "), "");
});

test("mutation: hasRealCode detecta se o trecho contém código executável", () => {
  assert.equal(hasRealCode("// só comentário"), false);
  assert.equal(hasRealCode("/* bloco */ \n  "), false);
  assert.equal(hasRealCode("const x = 1;"), true);
  assert.equal(hasRealCode("'apenas string'"), true);
});

test("mutation: linhas novas e hunks separados, sem incluir linhas intermediárias", () => {
  assert.deepEqual(mutationRanges("a.ts", "@@ -2 +2 @@\n-x\n+y\n@@ -10,2 +10,3 @@\n"), ["a.ts:2-2", "a.ts:10-12"]);
});

test("mutation: deleção pura valida o arquivo restante", () => {
  assert.deepEqual(mutationRanges("a.ts", "@@ -2,3 +1,0 @@\n@@ -10 +7 @@\n"), ["a.ts"]);
});

test("mutation: deleção de código real valida o arquivo restante", () => {
  assert.deepEqual(
    mutationRanges("a.ts", "@@ -5,1 +5,0 @@\n-const deadCode = true;\n"),
    ["a.ts"]
  );
});

test("mutation: deleção exclusiva de comentários não valida o arquivo restante", () => {
  assert.deepEqual(
    mutationRanges("a.ts", "@@ -5,2 +5,0 @@\n-// comentário 1\n-// comentário 2\n"),
    []
  );
});

test("mutation: alteração exclusiva de comentários ou whitespace é ignorada", () => {
  assert.deepEqual(
    mutationRanges("a.ts", "@@ -5,1 +5,1 @@\n-// antigo comentário\n+// novo comentário\n"),
    []
  );
  assert.deepEqual(
    mutationRanges("a.ts", "@@ -10,1 +10,1 @@\n-   \n+       \n"),
    []
  );
});

test("mutation: adição com código real é mantida mesmo contendo comentários no hunk", () => {
  assert.deepEqual(
    mutationRanges("a.ts", "@@ -5,0 +5,2 @@\n+// comentário\n+const live = 1;\n"),
    ["a.ts:5-6"]
  );
});

test("mutation: diff vazio não cria um escopo", () => {
  assert.deepEqual(mutationRanges("a.ts", ""), []);
});

test("mutation: detecção de arquivos relevantes separa código/testes/configs de documentação", () => {
  assert.equal(isRelevantFile("classifier.ts"), true);
  assert.equal(isRelevantFile("types.d.ts"), false);
  assert.equal(isRelevantFile("web-search.tests/foo.test.mjs"), true);
  assert.equal(isRelevantFile("scripts/mutation.mjs"), true);
  assert.equal(isRelevantFile("package.json"), true);
  assert.equal(isRelevantFile("package-lock.json"), true);
  assert.equal(isRelevantFile("stryker.config.mjs"), true);
  assert.equal(isRelevantFile("vitest.config.mjs"), true);

  assert.equal(isRelevantFile("README.md"), false);
  assert.equal(isRelevantFile("AGENTS.md"), false);
  assert.equal(isRelevantFile("docs/adr/0001.md"), false);
  assert.equal(isRelevantFile(".gitignore"), false);

  assert.equal(hasRelevantChanges(["README.md", "docs/index.md"]), false);
  assert.equal(hasRelevantChanges(["README.md", "classifier.ts"]), true);
});

test("mutation: mudanças em testes, infraestrutura e dependências exigem base completa", () => {
  for (const file of ["web-search.tests/a.test.mjs", "scripts/test.mjs", "package.json", "package-lock.json", "stryker.config.mjs", "vitest.config.mjs"]) {
    assert.equal(requiresFullMutation([file]), true, file);
  }
  assert.equal(requiresFullMutation(["README.md", "classifier.ts"]), false);
});
