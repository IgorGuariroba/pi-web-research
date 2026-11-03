import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hasRelevantChanges, isProductionSource, mutationPlan, mutationRanges } from "./mutation-scope.mjs";

const USAGE = "Uso: node scripts/mutation.mjs --staged [--tests-only] | --base <commit> | --full";
const args = process.argv.slice(2);
const staged = args[0] === "--staged" && (args.length === 1 || (args.length === 2 && args[1] === "--tests-only"));
// Pre-commit: só a suíte normal sobre o snapshot staged; a mutação fica para o CI (e execução manual).
const testsOnly = staged && args[1] === "--tests-only";
const full = args.length === 1 && args[0] === "--full";
const base = args.length === 2 && args[0] === "--base" ? args[1] : undefined;
if (!staged && !full && !base) {
  console.error(USAGE);
  process.exit(1);
}
const git = (...params) => execFileSync("git", params, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const root = git("rev-parse", "--show-toplevel").trim();
process.chdir(root);
// write-tree snapshots the index without creating a commit or changing staged files.
const tree = git(staged ? "write-tree" : "rev-parse", ...(staged ? [] : ["HEAD^{tree}"])).trim();
const diffArgs = staged ? ["--cached"] : base ? [base, "HEAD"] : [];
const files = full ? [] : git("diff", ...diffArgs, "--name-only", "-z", "--no-renames").split("\0").filter(Boolean);

if (!full && !hasRelevantChanges(files)) {
  console.log("Nenhuma alteração em código de produção, testes ou configurações; testes e mutação dispensados.");
  process.exit(0);
}

const snapshot = (rev) => {
  let listed = [];
  try {
    listed = execFileSync("git", ["ls-tree", "-r", "-z", "--name-only", rev], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 })
      .split("\0").filter(Boolean);
  } catch {
    // Sem revisão anterior (primeiro commit): nada a comparar.
  }
  const cache = new Map();
  return {
    files: new Set(listed),
    read(file) {
      if (!cache.has(file)) {
        let content;
        try {
          content = execFileSync("git", ["show", `${rev}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
        } catch {
          content = undefined;
        }
        cache.set(file, content);
      }
      return cache.get(file);
    },
  };
};

const after = snapshot(tree);
const plan = full
  ? { full: true, smoke: true, wholeFiles: [], runTests: true }
  : mutationPlan(files, { before: snapshot(staged ? "HEAD" : base), after });
const runFull = plan.full;
const ranges = runFull ? [] : files
  .filter((file) => isProductionSource(file) && !plan.wholeFiles.includes(file))
  .flatMap((file) => mutationRanges(file, git("diff", ...diffArgs, "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", "--", file)))
  .filter((range) => after.files.has(range.replace(/:\d+-\d+$/, "")));

if (!plan.full && !plan.smoke && !plan.runTests && !plan.wholeFiles.length && !ranges.length) {
  console.log("Nenhuma alteração de código real nos arquivos TypeScript; testes e mutação dispensados.");
  process.exit(0);
}

const temp = mkdtempSync(join(tmpdir(), "pi-web-research-mutation-"));
let status = 1;
try {
  // Only tracked snapshot contents are used, never unstaged/untracked source or tests.
  const archive = execFileSync("git", ["archive", tree], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", temp], { input: archive });
  symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), "dir");
  const run = (command, params) => {
    const result = spawnSync(command, params, { cwd: temp, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} falhou (status ${result.status}, sinal ${result.signal ?? "nenhum"})`);
  };
  // Fail closed if installed dependencies do not match the snapshot lockfile.
  for (const file of ["package.json", "package-lock.json"]) {
    if (readFileSync(join(temp, file), "utf8") !== readFileSync(join(root, file), "utf8")) {
      throw new Error(`${file} difere do snapshot. Alinhe o manifesto/lockfile e rode npm ci antes de validar.`);
    }
  }
  run("npm", ["test"]);
  if (testsOnly) {
    console.log("Suíte normal aprovada; mutação não roda no commit (CI ou npm run test:mutation).");
  } else {
    if (plan.smoke) run(process.execPath, ["scripts/mutation-smoke.mjs"]);
    const configPath = join(temp, "stryker.config.mjs");
    const { default: config } = await import(pathToFileURL(configPath).href);
    const mutate = runFull ? config.mutate : [...plan.wholeFiles, ...ranges];
    if (!mutate.length) {
      console.log("Nenhuma linha TypeScript de produção para mutar; testes normais aprovados.");
    } else {
      console.log("Escopo de mutação:", mutate.join(", "));
      writeFileSync(join(temp, "mutation.config.json"), JSON.stringify({ ...config, mutate }));
      try {
        run(process.execPath, [join(root, "node_modules/@stryker-mutator/core/bin/stryker.js"), "run", "mutation.config.json"]);
      } finally {
        const reports = join(temp, "reports/mutation");
        if (existsSync(reports)) {
          mkdirSync(join(root, "reports"), { recursive: true });
          rmSync(join(root, "reports/mutation"), { recursive: true, force: true });
          cpSync(reports, join(root, "reports/mutation"), { recursive: true });
          console.log("Relatório: reports/mutation/index.html");
        }
      }
    }
  }
  status = 0;
} catch (error) {
  console.error(`Mutation gate reprovado: ${error.message}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.exitCode = status;
