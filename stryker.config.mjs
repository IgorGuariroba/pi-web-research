export default {
  testRunner: "vitest",
  vitest: { configFile: "vitest.config.mjs", related: false, pool: "forks" },
  coverageAnalysis: "perTest",
  mutate: ["*.ts", "!*.d.ts"],
  thresholds: { high: 90, low: 85, break: 85 },
  reporters: ["clear-text", "progress", "html", "json"],
  clearTextReporter: { logTests: false },
  htmlReporter: { fileName: "reports/mutation/index.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  // Sem concurrency fixa: o padrão do Stryker usa n-1 núcleos (n se n <= 4).
  // timeoutMS soma-se a timeoutFactor x tempo medido dos testes que cobrem o mutante;
  // 10 s ainda deixa folga para máquina carregada sem pagar 30 s por mutante que trava.
  timeoutMS: 10_000,
  timeoutFactor: 2,
  // No result reuse: changing tests must never reuse an old approval.
  incremental: false,
  cleanTempDir: true,
};
