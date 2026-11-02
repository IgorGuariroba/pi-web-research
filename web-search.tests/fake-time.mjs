import { test as nativeTest } from "node:test";
import FakeTimers from "@sinonjs/fake-timers";

// Advance the actual production timers; do not stub backoff or provider logic.
// runAllAsync flushes promise continuations between scheduled timers.
export function testWithFakeTime(name, fn) {
  nativeTest(name, async (context) => {
    const clock = FakeTimers.install({ now: Date.UTC(2026, 0, 1), toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      let failure;
      const task = Promise.resolve().then(() => fn(context)).catch((error) => { failure = error; });
      await clock.runAllAsync();
      await task;
      if (failure) throw failure;
    } finally {
      clock.uninstall();
    }
  });
}
