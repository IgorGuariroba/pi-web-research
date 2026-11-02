import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Setup files run inside each isolated test-file worker, before test imports.
const original = { HOME: process.env.HOME, EXA_API_KEY: process.env.EXA_API_KEY, TAVILY_API_KEY: process.env.TAVILY_API_KEY };
const home = mkdtempSync(join(tmpdir(), "pi-vitest-"));
process.env.HOME = home;
process.env.EXA_API_KEY = "";
process.env.TAVILY_API_KEY = "";
afterAll(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
