export function stripCommentsAndWhitespace(code) {
  let result = "";
  let i = 0;
  const len = code.length;
  let inString = null;
  let inBlockComment = false;
  let inLineComment = false;

  while (i < len) {
    const ch = code[i];
    const next = i + 1 < len ? code[i + 1] : "";

    if (inLineComment) {
      if (ch === "\n" || ch === "\r") inLineComment = false;
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (inString !== null) {
      if (ch === "\\") {
        result += ch + next;
        i += 2;
        continue;
      }
      if (ch === inString) inString = null;
      result += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      result += ch;
      i++;
      continue;
    }

    if (!/\s/.test(ch)) result += ch;
    i++;
  }
  return result;
}

export function hasRealCode(text) {
  return stripCommentsAndWhitespace(text).length > 0;
}

// Stryker ranges use 1-based lines; omitting columns selects complete lines.
export function mutationRanges(file, diff) {
  const ranges = [];
  let hasDeletion = false;
  const hunks = diff.split(/^@@ /m).filter(Boolean);

  for (const hunk of hunks) {
    const match = hunk.match(/^-\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@[^\n]*\n?([\s\S]*)$/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const body = match[3] || "";
    const lines = body.split("\n");
    const deletedLines = lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1)).join("\n");
    const addedLines = lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n");
    const hasDiffBody = deletedLines.length > 0 || addedLines.length > 0;

    if (count === 0) {
      if (!hasDiffBody || hasRealCode(deletedLines)) {
        hasDeletion = true;
      }
    } else {
      if (!hasDiffBody || hasRealCode(addedLines)) {
        ranges.push(`${file}:${start}-${start + count - 1}`);
      }
    }
  }

  // A deletion has no new line to mutate. Check the remaining file instead.
  return hasDeletion ? [file] : ranges;
}

export function isRelevantFile(file) {
  if (file.endsWith(".ts") && !file.endsWith(".d.ts")) return true;
  return /^(web-search\.tests\/|scripts\/|package(?:-lock)?\.json$|(?:stryker|vitest)\.config\.mjs$|tsconfig\.json$)/.test(file);
}

export function hasRelevantChanges(files) {
  return files.some(isRelevantFile);
}


// --- Escopo por impacto: evita mutar a base inteira quando só testes, gate ou metadados mudam.

const TEST_DIR = "web-search.tests/";
// Arquivos que mudam como os testes executam: qualquer alteração exige base completa.
const FULL_INFRA = /^(?:(?:stryker|vitest)\.config\.mjs|tsconfig\.json)$/;
// O próprio gate é validado pelos testes unitários e pelo smoke, não pela mutação de produção.
const GATE_SCRIPT = /^scripts\/mutation(?:-scope|-smoke)?\.mjs$/;
// Dependências que alteram a execução dos testes ou da mutação.
const MUTATION_INFRA_PACKAGE = /^(?:@stryker-mutator\/.+|vitest|@vitest\/.+|vite|tinypool|@sinonjs\/fake-timers)$/;
// Campos de package.json que não influenciam execução de testes nem mutação.
const PACKAGE_METADATA = ["name", "version", "description", "keywords", "author", "license", "repository", "homepage", "bugs", "files", "publishConfig", "pi"];
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export const isProductionSource = (file) => /^[^/]+\.ts$/.test(file) && !file.endsWith(".d.ts");
export const isTestFile = (file) => /^web-search\.tests\/(?!raw-)[^/]+\.test\.mjs$/.test(file);
export const isGateScript = (file) => GATE_SCRIPT.test(file);

function parseJson(text) {
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function infraDependencies(deps) {
  return Object.fromEntries(Object.entries(deps).filter(([name]) => MUTATION_INFRA_PACKAGE.test(name)));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function manifestRequiresFull(oldText, newText) {
  const [before, after] = [parseJson(oldText), parseJson(newText)];
  if (!before || !after) return true;
  const normalize = (manifest) => {
    const copy = { ...manifest };
    for (const key of PACKAGE_METADATA) delete copy[key];
    for (const field of DEPENDENCY_FIELDS) if (copy[field]) copy[field] = infraDependencies(copy[field]);
    return JSON.stringify(stable(copy));
  };
  return normalize(before) !== normalize(after);
}

export function lockfileRequiresFull(oldText, newText) {
  const [before, after] = [parseJson(oldText), parseJson(newText)];
  if (!before?.packages || !after?.packages) return true;
  const infraVersions = (lock) => JSON.stringify(Object.entries(lock.packages)
    .filter(([path]) => MUTATION_INFRA_PACKAGE.test(path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)))
    .map(([path, entry]) => [path, entry.version, entry.integrity])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return infraVersions(before) !== infraVersions(after);
}

// Conservador: qualquer literal que pareça caminho de módulo vira aresta, inclusive imports
// dinâmicos, constantes com caminhos e arquivos executados por subprocesso.
export function referencedFiles(file, code, exists) {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const found = new Set();
  for (const match of code.matchAll(/(["'`])([^"'`\s]+\.(?:ts|mjs|js))\1/g)) {
    const spec = match[2];
    const candidates = spec.startsWith("./") || spec.startsWith("../")
      ? [normalizePath(dir + spec)]
      : [normalizePath(spec), normalizePath(TEST_DIR + spec)];
    for (const candidate of candidates) if (candidate && exists(candidate)) found.add(candidate);
  }
  return [...found];
}

function normalizePath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export function reachableFiles(start, read, exists) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    const code = read(file);
    if (code === undefined) continue;
    for (const next of referencedFiles(file, code, exists)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

// Arquivos de produção cujos mutantes podem ser mortos por testes que alcançam algum arquivo
// alterado em web-search.tests/. Usa as duas versões para cobrir testes removidos ou enfraquecidos.
export function productionFilesAffectedByTests(changedTestDirFiles, snapshots) {
  const changed = new Set(changedTestDirFiles);
  const affected = new Set();
  if (!changed.size) return [];
  for (const { files, read } of snapshots) {
    const exists = (file) => files.has(file);
    for (const test of [...files].filter(isTestFile)) {
      const reach = reachableFiles(test, read, exists);
      if ([...reach].some((file) => changed.has(file))) {
        for (const file of reach) if (isProductionSource(file)) affected.add(file);
      }
    }
  }
  return [...affected].sort();
}

/**
 * Decide o escopo da validação a partir dos arquivos alterados.
 * - full: infraestrutura de execução mudou; só a base completa é confiável.
 * - smoke: o gate mudou; o smoke end-to-end precisa provar aprovação e rejeição.
 * - wholeFiles: produção alcançada por testes alterados.
 * - runTests: há mudança que exige a suíte normal mesmo sem mutantes.
 */
export function mutationPlan(files, { before, after }) {
  const full = files.some((file) =>
    FULL_INFRA.test(file)
    || (file.startsWith("scripts/") && !isGateScript(file))
    || (file === "package.json" && manifestRequiresFull(before.read(file), after.read(file)))
    || (file === "package-lock.json" && lockfileRequiresFull(before.read(file), after.read(file)))
  );
  const smoke = files.some(isGateScript);
  const testDirFiles = files.filter((file) => file.startsWith(TEST_DIR));
  const wholeFiles = productionFilesAffectedByTests(testDirFiles, [before, after]).filter((file) => after.files.has(file));
  const runTests = files.some((file) => isRelevantFile(file) && !isProductionSource(file));
  return { full, smoke, wholeFiles, runTests };
}
