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

export function requiresFullMutation(files) {
  return files.some((file) => /^(web-search\.tests\/|scripts\/|package(?:-lock)?\.json$|(?:stryker|vitest)\.config\.mjs$)/.test(file));
}
