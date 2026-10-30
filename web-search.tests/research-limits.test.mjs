import { test } from "node:test";
import assert from "node:assert/strict";
import { getResearchLimits } from "../research.ts";

// Calibrado na comparação 0.1.1 × 0.2.0 (#11): deep real levou 36–52s com o orçamento cheio
// de buscas; 180s ≈ 3,5× o pior caso medido, mesma folga do quick (90s ≈ 3,6× 25s).
test("timeout do deep calibrado em 180s e do quick mantido em 90s", () => {
  assert.equal(getResearchLimits("deep").timeoutMs, 180_000);
  assert.equal(getResearchLimits("quick").timeoutMs, 90_000);
});
