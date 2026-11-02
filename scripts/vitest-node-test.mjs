// Only the node:test APIs used by this suite. Aliased by Vitest, never by Node.
// Keep native `npm test` working, including subprocess isolation regressions.
import { test as it, beforeEach as before, afterEach, onTestFinished } from "vitest";

const contextFor = (context) => ({ ...context, after: onTestFinished });
export const test = (name, fn) => it(name, (context) => fn(contextFor(context)));
export const beforeEach = (fn) => before((context) => fn(contextFor(context)));
export { afterEach };
