// End-to-end gate validation in a disposable Git repository; never touches the real index.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "mutation-smoke-"));
const git = (...args) => execFileSync("git", args, { cwd: temp, stdio: "pipe" });
try {
  mkdirSync(join(temp, "scripts"));
  mkdirSync(join(temp, "web-search.tests"));
  for (const file of ["package.json", "package-lock.json", "stryker.config.mjs", "vitest.config.mjs", "scripts/test.mjs", "scripts/vitest-node-test.mjs", "scripts/vitest-isolation.mjs"]) {
    copyFileSync(join(root, file), join(temp, file));
  }
  symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), "dir");
  writeFileSync(join(temp, ".gitignore"), "node_modules\nreports/\n");
  const source = join(temp, "fixture.ts");
  const test = join(temp, "web-search.tests/fixture.test.mjs");
  const strong = `import { test } from "node:test";
import assert from "node:assert/strict";
import { positive } from "../fixture.ts";
test("boundary", (t) => {
  t.after(() => {}); // node:test cleanup must also work through the Vitest bridge
  assert.equal(positive(1), true);
  assert.equal(positive(0), false);
  assert.equal(positive(-1), false);
});
`;
  writeFileSync(source, "export const positive = (value: number) => value >= 0;\n");
  writeFileSync(test, strong);
  writeFileSync(join(temp, "web-search.tests/unrelated.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("unrelated", () => { assert.equal(1 + 1, 2); });\n');
  git("init", "-q");
  git("config", "user.name", "Mutation Smoke");
  git("config", "user.email", "mutation@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("add", ".");
  git("commit", "-qm", "fixture baseline");
  const base = git("rev-parse", "HEAD").toString().trim();
  const runGate = (args = ["--staged"], env = {}) => {
    const result = spawnSync(process.execPath, [resolve(root, "scripts/mutation.mjs"), ...args], {
      cwd: temp, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    console.log(result.stdout, result.stderr);
    return result;
  };
  writeFileSync(source, "export const positive = (value: number) => value > 0;\n");
  git("add", "fixture.ts");
  // An invalid unstaged edit must NOT affect the passing staged snapshot.
  writeFileSync(source, "invalid TypeScript !!!\n");
  assert.equal(runGate().status, 0, "strong tests must kill mutants from the staged source");
  const report = JSON.parse(readFileSync(join(temp, "reports/mutation/mutation.json"), "utf8"));
  const unrelated = Object.values(report.testFiles).flatMap((file) => file.tests).find((test) => test.name === "unrelated");
  assert.ok(unrelated, "the initial coverage run must discover unrelated tests too");
  const mutants = Object.values(report.files).flatMap((file) => file.mutants);
  assert.ok(mutants.some((mutant) => mutant.coveredBy?.length), "per-test coverage must be recorded");
  assert.ok(mutants.every((mutant) => !mutant.coveredBy?.includes(unrelated.id)), "unrelated tests must not cover the mutant");
  git("checkout", "--", "fixture.ts");
  git("commit", "-qm", "fix boundary");
  assert.equal(runGate(["--base", base]).status, 0, "CI diff must validate HEAD against its base");
  writeFileSync(test, 'import { test } from "node:test";\nimport { positive } from "../fixture.ts";\ntest("weak", () => { positive(1); });\n');
  git("add", "web-search.tests/fixture.test.mjs");
  // Unstaged stronger tests must NOT rescue the weak tests staged for the commit.
  writeFileSync(test, strong);
  const weak = runGate();
  assert.notEqual(weak.status, 0, "surviving mutants must block the commit");
  assert.match(weak.stdout + weak.stderr, /mutation score|threshold/i);
  assert.match(weak.stdout, /Escopo de mutação: fixture\.ts\n/, "changed tests must mutate the production they reach");
  // Pre-commit roda só a suíte normal: mutantes sobreviventes não bloqueiam o commit (ficam para o CI).
  const testsOnly = runGate(["--staged", "--tests-only"]);
  assert.equal(testsOnly.status, 0, "pre-commit runs only the normal suite");
  assert.match(testsOnly.stdout, /mutação não roda no commit/);
  assert.doesNotMatch(testsOnly.stdout + testsOnly.stderr, /Escopo de mutação|Mutation gate reprovado/);
  git("reset", "--hard", "-q", "HEAD");
  writeFileSync(join(temp, "web-search.tests/unrelated.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("unrelated", () => { assert.equal(2 + 2, 4); });\n');
  git("add", "web-search.tests/unrelated.test.mjs");
  const unrelatedRun = runGate();
  assert.equal(unrelatedRun.status, 0, "tests that reach no production code only need the normal suite");
  assert.match(unrelatedRun.stdout, /Nenhuma linha TypeScript de produção para mutar/);
  git("reset", "--hard", "-q", "HEAD");
  const manifest = JSON.parse(readFileSync(join(temp, "package.json"), "utf8"));
  writeFileSync(join(temp, "package.json"), JSON.stringify({ ...manifest, version: "99.0.0" }, null, 2) + "\n");
  git("add", "package.json");
  const releaseRun = runGate();
  assert.equal(releaseRun.status, 0, "metadata-only manifest changes run the normal suite without full mutation");
  assert.match(releaseRun.stdout, /Nenhuma linha TypeScript de produção para mutar/);
  git("reset", "--hard", "-q", "HEAD");
  writeFileSync(join(temp, "vitest.config.mjs"), readFileSync(join(temp, "vitest.config.mjs"), "utf8") + "// infra\n");
  git("add", "vitest.config.mjs");
  const infraTestsOnly = runGate(["--staged", "--tests-only"]);
  assert.equal(infraTestsOnly.status, 0, "pre-commit skips full mutation on infrastructure changes");
  assert.doesNotMatch(infraTestsOnly.stdout, /Escopo de mutação/);
  git("reset", "--hard", "-q", "HEAD");
  writeFileSync(join(temp, "README.md"), "# Documentação pura\n");
  git("add", "README.md");
  const docRun = runGate();
  assert.equal(docRun.status, 0, "commits exclusivamente de documentação devem dispensar testes e mutação");
  assert.match(docRun.stdout, /dispensados/i);
  git("reset", "--hard", "-q", "HEAD");
  writeFileSync(source, "// Apenas um comentário adicionado\n" + readFileSync(source, "utf8"));
  git("add", "fixture.ts");
  const commentRun = runGate();
  assert.equal(commentRun.status, 0, "alterações exclusivas de comentários devem dispensar testes e mutação");
  assert.match(commentRun.stdout, /dispensados/i);
  git("reset", "--hard", "-q", "HEAD");
  writeFileSync(source, "export const positive = (value: number) => false;\n");
  git("add", "fixture.ts");
  assert.notEqual(runGate().status, 0, "failing normal tests must block the gate");
  assert.notEqual(runGate(["--staged", "--tests-only"]).status, 0, "failing normal tests must block the commit");
  console.log("Mutation smoke: staged isolation, per-test coverage, CI diff, impact scope, tests-only pre-commit, approval and rejection validated.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
