// Regressão: runResearch deve reutilizar o ModelRuntime do agente pai.
//
// Bug original: a sessão filha do subagente (noExtensions: true) criava um
// ModelRuntime novo que não conhecia providers registrados dinamicamente por
// extensões (ex.: omniroute). Resultado: "No API key found for omniroute" e o
// tool `research` caía no fallback sem síntese.
//
// Este teste registra um provider dinâmico apontando para um servidor
// OpenAI-compatible local (fake) e verifica que runResearch consegue completar
// uma síntese. Sem o fix, falha com "No API key found for fake-dyn".

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runResearch } from "../research-runner.ts";

function startFakeOpenAIServer() {
  const server = createServer((req, res) => {
    if (!req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: "fake-1",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "Síntese fake concluída.\n\nFontes\n- https://exemplo.com" }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

test("runResearch funciona com provider registrado dinamicamente no runtime do pai", async () => {
  const { server, baseUrl } = await startFakeOpenAIServer();
  const workDir = mkdtempSync(join(tmpdir(), "research-dyn-"));
  const agentDir = mkdtempSync(join(tmpdir(), "research-agent-"));
  writeFileSync(join(agentDir, "auth.json"), "{}\n");

  try {
    const model = {
      provider: "fake-dyn",
      id: "fake-model",
      name: "fake-model",
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 32000,
    };

    // Runtime "do pai": provider dinâmico registrado, como extensões fazem.
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    runtime.registerProvider("fake-dyn", {
      name: "Fake Dyn",
      baseUrl,
      apiKey: "sk-fake",
      api: "openai-completions",
      authHeader: true,
      models: [model],
    });
    await runtime.refresh({ allowNetwork: false });
    const modelRegistry = new ModelRegistry(runtime);

    const provider = {
      name: "fake",
      async search() {
        return {
          provider: "fake",
          results: [{ title: "T", url: "https://exemplo.com", summary: "S" }],
          telemetry: { providerMeta: {} },
        };
      },
    };

    const result = await runResearch({
      goal: "teste",
      depth: "quick",
      providers: [provider],
      modelRegistry,
      modelRef: { provider: "fake-dyn", id: "fake-model" },
      cwd: workDir,
      agentDir,
    });

    assert.equal(result.details.synthesized, true);
    assert.match(result.content[0].text, /Síntese fake concluída/);
  } finally {
    server.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
