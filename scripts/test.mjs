// Testes de integração reais (raw-*) são opt-in e nunca rodam no CI.
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const files = readdirSync(new URL("web-search.tests/", root))
  .filter((file) => file.endsWith(".test.mjs") && !file.startsWith("raw-"))
  .sort()
  .map((file) => `web-search.tests/${file}`);
if (!files.length) throw new Error("Nenhum teste encontrado");
const home = mkdtempSync(join(tmpdir(), "pi-web-research-tests-"));
try {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, HOME: home, EXA_API_KEY: "", TAVILY_API_KEY: "" },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
