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
  concurrency: 4,
  timeoutMS: 30_000,
  timeoutFactor: 2,
  // No result reuse: changing tests must never reuse an old approval.
  incremental: false,
  cleanTempDir: true,
};
