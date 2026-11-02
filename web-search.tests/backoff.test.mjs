import { test } from "node:test";
import assert from "node:assert/strict";
import FakeTimers from "@sinonjs/fake-timers";
import { backoff } from "../http-search-provider.ts";

for (const [name, header, expected] of [
  ["default", undefined, 1000],
  ["seconds", "2", 2000],
  ["date", "Thu, 01 Jan 2026 00:00:03 GMT", 3000],
  ["invalid", "invalid", 1000],
  ["negative", "-1", 1000],
  ["ceiling", "99999", 10000],
]) {
  test(`backoff: ${name} agenda o delay esperado sem espera real`, async () => {
    const clock = FakeTimers.install({ now: Date.UTC(2026, 0, 1), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const random = Math.random;
    Math.random = () => 0.5; // jitter factor 1, not a skipped scheduling path
    try {
      const response = header === undefined ? null : new Response(null, { headers: { "Retry-After": header } });
      let done = false;
      const pending = backoff(response).then(() => { done = true; });
      await clock.tickAsync(expected - 1);
      assert.equal(done, false, "não deve resolver antes do delay");
      await clock.tickAsync(1);
      await pending;
      assert.equal(done, true);
    } finally {
      Math.random = random;
      clock.uninstall();
    }
  });
}

test("backoff: abort rejeita e cancela o timer pendente", async () => {
  const clock = FakeTimers.install({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const controller = new AbortController();
    const pending = assert.rejects(backoff(null, controller.signal), { name: "AbortError" });
    assert.equal(clock.countTimers(), 1);
    controller.abort();
    await pending;
    assert.equal(clock.countTimers(), 0);
  } finally {
    clock.uninstall();
  }
});
