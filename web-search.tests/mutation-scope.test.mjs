import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasRealCode,
  hasRelevantChanges,
  isGateScript,
  isProductionSource,
  isRelevantFile,
  isTestFile,
  lockfileRequiresFull,
  manifestRequiresFull,
  mutationPlan,
  mutationRanges,
  productionFilesAffectedByTests,
  referencedFiles,
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

const tree = (contents) => ({ files: new Set(Object.keys(contents)), read: (file) => contents[file] });

const baseTree = {
  "a.ts": 'import { b } from "./b.ts";\nexport const a = () => b();\n',
  "b.ts": "export const b = () => 1;\n",
  "c.ts": "export const c = 2;\n",
  "types.d.ts": "export type T = string;\n",
  "web-search.tests/harness.mjs": 'export { a } from "../a.ts";\n',
  "web-search.tests/a.test.mjs": 'import { a } from "./harness.mjs";\n',
  "web-search.tests/c.test.mjs": 'const { c } = await import("../c.ts");\n',
  "web-search.tests/spawn.test.mjs": 'run("web-search.tests/c.test.mjs");\n',
  "web-search.tests/scope.test.mjs": 'import { x } from "../scripts/mutation-scope.mjs";\n',
  "web-search.tests/raw-live.test.mjs": 'import { b } from "../b.ts";\n',
  "scripts/mutation-scope.mjs": "export const x = 1;\n",
  "package.json": JSON.stringify({ name: "p", version: "1.0.0", type: "module", scripts: { test: "node t" }, dependencies: { linkedom: "1" }, devDependencies: { vitest: "4.1.12" } }),
  "package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/linkedom": { version: "1" }, "node_modules/vitest": { version: "4.1.12", integrity: "a" } } }),
};

test("mutation: classifica fontes de produção, testes executados e scripts do gate", () => {
  assert.equal(isProductionSource("a.ts"), true);
  assert.equal(isProductionSource("types.d.ts"), false);
  assert.equal(isProductionSource("dir/a.ts"), false);
  assert.equal(isTestFile("web-search.tests/a.test.mjs"), true);
  assert.equal(isTestFile("web-search.tests/raw-live.test.mjs"), false);
  assert.equal(isTestFile("web-search.tests/harness.mjs"), false);
  assert.equal(isTestFile("web-search.tests/sub/a.test.mjs"), false);
  for (const file of ["scripts/mutation.mjs", "scripts/mutation-scope.mjs", "scripts/mutation-smoke.mjs"]) assert.equal(isGateScript(file), true, file);
  for (const file of ["scripts/test.mjs", "scripts/vitest-isolation.mjs", "scripts/mutation-other.mjs"]) assert.equal(isGateScript(file), false, file);
});

test("mutation: referências incluem imports estáticos, dinâmicos, re-exports e caminhos em literais", () => {
  const files = new Set(Object.keys(baseTree));
  const exists = (file) => files.has(file);
  assert.deepEqual(referencedFiles("web-search.tests/harness.mjs", baseTree["web-search.tests/harness.mjs"], exists), ["a.ts"]);
  assert.deepEqual(referencedFiles("web-search.tests/c.test.mjs", baseTree["web-search.tests/c.test.mjs"], exists), ["c.ts"]);
  assert.deepEqual(referencedFiles("web-search.tests/spawn.test.mjs", baseTree["web-search.tests/spawn.test.mjs"], exists), ["web-search.tests/c.test.mjs"]);
  assert.deepEqual(referencedFiles("web-search.tests/x.mjs", 'f("c.test.mjs"); f(\'../../fora.ts\'); f(`../nao-existe.ts`);', exists), ["web-search.tests/c.test.mjs"]);
  assert.deepEqual(referencedFiles("a.ts", 'import "./b.ts";\nimport type { T } from "./types.d.ts";', exists), ["b.ts", "types.d.ts"]);
});

test("mutation: teste alterado muta só a produção que ele alcança, transitivamente", () => {
  const snapshot = tree(baseTree);
  assert.deepEqual(productionFilesAffectedByTests(["web-search.tests/a.test.mjs"], [snapshot]), ["a.ts", "b.ts"]);
  assert.deepEqual(productionFilesAffectedByTests(["web-search.tests/harness.mjs"], [snapshot]), ["a.ts", "b.ts"]);
  assert.deepEqual(productionFilesAffectedByTests(["web-search.tests/c.test.mjs"], [snapshot]), ["c.ts"]);
  assert.deepEqual(productionFilesAffectedByTests(["web-search.tests/scope.test.mjs"], [snapshot]), []);
  assert.deepEqual(productionFilesAffectedByTests(["web-search.tests/raw-live.test.mjs"], [snapshot]), []);
  assert.deepEqual(productionFilesAffectedByTests([], [snapshot]), []);
});

test("mutation: teste removido usa a versão anterior para escolher a produção afetada", () => {
  const after = { ...baseTree };
  delete after["web-search.tests/c.test.mjs"];
  after["web-search.tests/spawn.test.mjs"] = "run();\n";
  assert.deepEqual(productionFilesAffectedByTests(["web-search.tests/c.test.mjs"], [tree(baseTree), tree(after)]), ["c.ts"]);
  assert.deepEqual(productionFilesAffectedByTests(["web-search.tests/c.test.mjs"], [tree(after)]), []);
});

test("mutation: package.json só exige base completa quando muda execução ou infraestrutura de teste", () => {
  const pkg = JSON.parse(baseTree["package.json"]);
  const same = baseTree["package.json"];
  const variant = (change) => JSON.stringify(change(structuredClone(pkg)));
  assert.equal(manifestRequiresFull(same, variant((p) => ({ ...p, version: "2.0.0", description: "x", keywords: ["k"] }))), false);
  assert.equal(manifestRequiresFull(same, variant((p) => ({ ...p, dependencies: { linkedom: "2" } }))), false);
  assert.equal(manifestRequiresFull(same, variant((p) => ({ ...p, devDependencies: { vitest: "5.0.0" } }))), true);
  assert.equal(manifestRequiresFull(same, variant((p) => ({ ...p, devDependencies: { ...p.devDependencies, "@stryker-mutator/core": "1" } }))), true);
  assert.equal(manifestRequiresFull(same, variant((p) => ({ ...p, scripts: { test: "node outro" } }))), true);
  assert.equal(manifestRequiresFull(same, variant((p) => ({ ...p, type: "commonjs" }))), true);
  assert.equal(manifestRequiresFull(same, variant((p) => ({ type: p.type, scripts: p.scripts, devDependencies: p.devDependencies, dependencies: p.dependencies, name: p.name }))), false);
  assert.equal(manifestRequiresFull(undefined, same), true);
  assert.equal(manifestRequiresFull(same, "{inválido"), true);
});

test("mutation: lockfile só exige base completa quando muda pacote de execução de testes", () => {
  const lock = JSON.parse(baseTree["package-lock.json"]);
  const same = baseTree["package-lock.json"];
  const variant = (change) => { const copy = structuredClone(lock); change(copy.packages); return JSON.stringify(copy); };
  assert.equal(lockfileRequiresFull(same, variant((p) => { p["node_modules/linkedom"].version = "2"; })), false);
  assert.equal(lockfileRequiresFull(same, variant((p) => { p["node_modules/x/node_modules/semver"] = { version: "7" }; })), false);
  assert.equal(lockfileRequiresFull(same, variant((p) => { p["node_modules/vitest"].version = "5"; })), true);
  assert.equal(lockfileRequiresFull(same, variant((p) => { p["node_modules/vitest"].integrity = "b"; })), true);
  assert.equal(lockfileRequiresFull(same, variant((p) => { p["node_modules/a/node_modules/@vitest/runner"] = { version: "4" }; })), true);
  assert.equal(lockfileRequiresFull(same, variant((p) => { p["node_modules/@sinonjs/fake-timers"] = { version: "15" }; })), true);
  assert.equal(lockfileRequiresFull(same, "{}"), true);
  assert.equal(lockfileRequiresFull(undefined, same), true);
});

test("mutation: plano exige base completa só para infraestrutura de execução", () => {
  const before = tree(baseTree);
  const plan = (files, changes = {}) => mutationPlan(files, { before, after: tree({ ...baseTree, ...changes }) });
  for (const file of ["stryker.config.mjs", "vitest.config.mjs", "tsconfig.json", "scripts/test.mjs", "scripts/vitest-node-test.mjs", "scripts/novo.mjs"]) {
    assert.equal(plan([file]).full, true, file);
  }
  for (const file of ["scripts/mutation.mjs", "scripts/mutation-smoke.mjs", "web-search.tests/a.test.mjs", "classifier.ts", "README.md"]) {
    assert.equal(plan([file]).full, false, file);
  }
  const release = JSON.stringify({ ...JSON.parse(baseTree["package.json"]), version: "1.0.1" });
  assert.deepEqual(plan(["package.json"], { "package.json": release }), { full: false, smoke: false, wholeFiles: [], runTests: true });
  const vitestBump = JSON.stringify({ ...JSON.parse(baseTree["package.json"]), devDependencies: { vitest: "5" } });
  assert.equal(plan(["package.json"], { "package.json": vitestBump }).full, true);
  const lockBump = JSON.parse(baseTree["package-lock.json"]);
  lockBump.packages["node_modules/vitest"].version = "5";
  assert.equal(plan(["package-lock.json"], { "package-lock.json": JSON.stringify(lockBump) }).full, true);
  assert.equal(plan(["package-lock.json"]).full, false);
});

test("mutation: plano indica smoke, produção afetada e necessidade da suíte normal", () => {
  const before = tree(baseTree);
  const plan = (files) => mutationPlan(files, { before, after: tree(baseTree) });
  assert.deepEqual(plan(["scripts/mutation-scope.mjs"]), { full: false, smoke: true, wholeFiles: [], runTests: true });
  assert.deepEqual(plan(["web-search.tests/a.test.mjs"]), { full: false, smoke: false, wholeFiles: ["a.ts", "b.ts"], runTests: true });
  assert.deepEqual(plan(["a.ts"]), { full: false, smoke: false, wholeFiles: [], runTests: false });
  assert.deepEqual(plan(["README.md"]), { full: false, smoke: false, wholeFiles: [], runTests: false });
  const removed = { ...baseTree };
  delete removed["c.ts"];
  assert.deepEqual(mutationPlan(["web-search.tests/c.test.mjs", "c.ts"], { before, after: tree(removed) }).wholeFiles, []);
});
