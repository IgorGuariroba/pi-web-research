import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFetchUrl, htmlToText, truncatePage } from "../fetch-url.ts";

test("fetch_url: aceita somente URLs HTTP(S) públicas", () => {
  assert.equal(validateFetchUrl("https://example.com/docs").hostname, "example.com");
  assert.throws(() => validateFetchUrl("file:///etc/passwd"), /http/i);
  assert.throws(() => validateFetchUrl("http://localhost:3000"), /privad|local/i);
  assert.throws(() => validateFetchUrl("http://127.0.0.1/x"), /privad|local/i);
  assert.throws(() => validateFetchUrl("http://10.0.0.2/x"), /privad|local/i);
  assert.throws(() => validateFetchUrl("http://169.254.169.254/x"), /privad|local/i);
  assert.throws(() => validateFetchUrl("http://[::1]/x"), /privad|local/i);
});

test("fetch_url: converte HTML em texto legível sem scripts", () => {
  const text = htmlToText("<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Título</h1><p>Olá &amp; mundo</p></body></html>");
  assert.equal(text, "Título\nOlá & mundo");
});

test("fetch_url: trunca páginas no limite informado", () => {
  assert.equal(truncatePage("abcdefgh", 5), "abcde\n\n[conteúdo truncado]");
  assert.equal(truncatePage("abc", 5), "abc");
});
