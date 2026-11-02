import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalHost } from "../canonical-url.ts";

test("canonicalHost: remove espaços, normaliza caixa e remove somente www inicial", () => {
  assert.equal(canonicalHost("  WWW.Example.COM  "), "example.com");
  assert.equal(canonicalHost("a.www.example.com"), "a.www.example.com");
  assert.equal(canonicalHost("www.example.com"), "example.com");
  assert.equal(canonicalHost("example.com"), "example.com");
});
