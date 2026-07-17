// Categoria: duplicatas. COMPORTAMENTO ATUAL: o parser NÃO deduplica — só remove
// entradas sem url. Dedup é responsabilidade futura do Deduplicator (componente
// separado do SearchEngine). Estes testes travam o comportamento atual para que
// a futura introdução do Deduplicator seja uma mudança consciente, não acidental.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResults } from "../goose-adapter.ts";

test("duplicate: mesma url 2x → mantém as 2 (sem dedup ainda)", () => {
  const r = parseResults(
    '[{"title":"A","url":"https://a.com","summary":"s"},{"title":"A2","url":"https://a.com","summary":"s"}]',
  );
  assert.equal(r.length, 2);
});

test("duplicate: mesma url com títulos diferentes → mantém 2", () => {
  const r = parseResults(
    '[{"title":"A","url":"https://a.com","summary":"s"},{"title":"B","url":"https://a.com","summary":"s"}]',
  );
  assert.equal(r.length, 2);
});

test("duplicate: url com e sem trailing slash → tratadas como distintas (sem normalização)", () => {
  const r = parseResults(
    '[{"title":"A","url":"https://a.com","summary":"s"},{"title":"A2","url":"https://a.com/","summary":"s"}]',
  );
  assert.equal(r.length, 2);
});

test("duplicate: 3x a mesma url → 3 resultados", () => {
  const one = '{"title":"A","url":"https://a.com","summary":"s"}';
  const r = parseResults("[" + [one, one, one].join(",") + "]");
  assert.equal(r.length, 3);
});

test("duplicate: mistura de duplicatas e únicas → mantém todas com url", () => {
  const r = parseResults(
    '[{"title":"A","url":"https://a.com","summary":"s"},{"title":"B","url":"https://b.com","summary":"s"},{"title":"A2","url":"https://a.com","summary":"s"}]',
  );
  assert.equal(r.length, 3);
});
