/**
 * http-search-provider.ts — base compartilhada para providers HTTP-based.
 *
 * Tavily e Exa compartilham retry/backoff/timeout idênticos:
 *   - 401/403 → throw imediato
 *   - 429/5xx → retry com backoff + jitter (respeitando Retry-After)
 *   - Erro de rede → retry
 *   - MAX_RETRIES=3, teto de delay
 *   - Nunca results:[] silencioso
 *
 * GooseBuiltinProvider NÃO herda desta base (usa exec via CLI, não HTTP fetch).
 */

// --------------------------------------------------------------------------- //
// Backoff (extraído do TavilyProvider)
// --------------------------------------------------------------------------- //

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 10_000;
export const MAX_RETRIES = 3;

/**
 * Espera com backoff respeitando o AbortSignal.
 * Lê Retry-After do header da resposta (segundos ou data HTTP). Se ausente ou
 * inválido, cai para exponencial com jitter.
 */
export async function backoff(response: Response | null, signal?: AbortSignal): Promise<void> {
  let delayMs = BASE_DELAY_MS;

  if (response) {
    const ra = response.headers.get("Retry-After");
    if (ra) {
      const seconds = Number(ra);
      if (Number.isFinite(seconds)) {
        delayMs = seconds * 1_000;
      } else {
        const parsed = Date.parse(ra);
        if (Number.isFinite(parsed)) delayMs = parsed - Date.now();
      }
    }
  }

  if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = BASE_DELAY_MS;
  delayMs = Math.min(delayMs, MAX_DELAY_MS);
  delayMs = Math.ceil(delayMs * (0.75 + Math.random() * 0.5));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    if (signal) {
      const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

export function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

export function isAbort(err: unknown): boolean {
  return (err instanceof DOMException && err.name === "AbortError") || (err as any)?.name === "TimeoutError";
}

export { BASE_DELAY_MS, MAX_DELAY_MS };
