import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const PRIVATE_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function isPrivateIp(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!isIP(normalized)) return false;
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4) return false;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

export function validateFetchUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("fetch_url requer uma URL HTTP(S) válida."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("fetch_url aceita apenas HTTP(S).");
  if (url.username || url.password) throw new Error("fetch_url não aceita credenciais na URL.");
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(host) || host.endsWith(".localhost") || isPrivateIp(host)) {
    throw new Error("fetch_url bloqueou host local ou IP privado.");
  }
  return url;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => {
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return HTML_ENTITIES[entity.toLowerCase()] ?? `&${entity};`;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Limpa a página com Readability (sem menu/rodapé/navegação); se falhar, conversão simples. */
export function readableText(html: string): string {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as unknown as Document).parse();
    const text = article?.content ? htmlToText(article.content) : "";
    if (text) return article?.title && !text.startsWith(article.title) ? `${article.title}\n${text}` : text;
  } catch {
    // cai na conversão simples
  }
  return htmlToText(html);
}

export function truncatePage(text: string, maxChars = 50_000): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[conteúdo truncado]`;
}

/** Leitura recusada por ser PDF (não consome o orçamento de leituras). */
export class UnsupportedPdfError extends Error {
  constructor() { super("fetch_url: PDF não suportado; tente outra fonte (HTML, texto ou JSON)."); this.name = "UnsupportedPdfError"; }
}

const isPdfUrl = (url: URL) => /\.pdf$/i.test(url.pathname);

/** Porta de HTTP injetável (assinatura do fetch global). */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 5;
/** Teto do texto limpo antes da Extração focada. */
const MAX_PAGE_CHARS = 500_000;

export async function fetchPage(rawUrl: string, signal?: AbortSignal, httpFetch: HttpFetch = fetch): Promise<{ url: string; text: string }> {
  let url = validateFetchUrl(rawUrl);
  if (isPdfUrl(url)) throw new UnsupportedPdfError();
  const timeout = AbortSignal.timeout(20_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  for (let hops = 0; ; hops++) {
    response = await httpFetch(url.href, {
      signal: combined,
      redirect: "manual",
      headers: { "user-agent": "pi-research-agent/1.0", accept: "text/html,text/plain,application/json" },
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) break;
    await response.body?.cancel();
    if (hops >= MAX_REDIRECTS) throw new Error(`fetch_url: mais de ${MAX_REDIRECTS} redirects.`);
    // Cada salto é revalidado contra host local e IP privado (SSRF).
    url = validateFetchUrl(new URL(location, url).href);
    if (isPdfUrl(url)) throw new UnsupportedPdfError();
  }
  if (!response.ok) throw new Error(`fetch_url: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (/pdf/i.test(contentType)) { await response.body?.cancel(); throw new UnsupportedPdfError(); }
  const body = await response.text();
  if (body.startsWith("%PDF-")) throw new UnsupportedPdfError();
  return { url: url.href, text: truncatePage(contentType.includes("html") ? readableText(body) : body, MAX_PAGE_CHARS) };
}
