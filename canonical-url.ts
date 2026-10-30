/**
 * canonical-url.ts — URL canônica (ver CONTEXT.md).
 *
 * Forma normalizada usada para decidir se dois resultados/Fontes são a mesma
 * fonte: host minúsculo sem www., sem fragmento, sem parâmetros de rastreio,
 * sem barra final; http = https.
 */
const TRACKING_PARAM = /^(utm_.*|ref|fbclid)$/i;

export function canonicalUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return raw.trim(); }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port ? `:${url.port}` : "";
  const params = [...url.searchParams].filter(([key]) => !TRACKING_PARAM.test(key)).sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  const scheme = url.protocol === "http:" || url.protocol === "https:" ? "" : url.protocol;
  return `${scheme}//${host}${port}${path}${query}`;
}
