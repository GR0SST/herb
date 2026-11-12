import { readFileSync } from "node:fs";
import { join } from "node:path";
import { docsPage } from "./docs";

const ROOT = join(import.meta.dir, "..", "public");
const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/config": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
  "/og.png": { file: "og.png", type: "image/png" },
  "/privacy": { file: "privacy.html", type: "text/html; charset=utf-8" },
  "/terms": { file: "terms.html", type: "text/html; charset=utf-8" },
  "/llms.txt": { file: "llms.txt", type: "text/plain; charset=utf-8" },
  "/llms-full.txt": { file: "llms-full.txt", type: "text/plain; charset=utf-8" },
  "/fonts/geist.woff2": { file: "fonts/geist.woff2", type: "font/woff2" },
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const headers = (type: string, cache = "no-cache") => ({
  "content-type": type,
  "cache-control": cache,
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
});

let docs: string | null = null;

/** Returns null when the site has no such file. */
export function serveSite(pathname: string) {
  if (pathname === "/docs") {
    // Built once from the plain text docs, so both always say the same.
    docs ??= docsPage(readFileSync(join(ROOT, "llms-full.txt"), "utf8"));
    return new Response(docs, { headers: headers("text/html; charset=utf-8") });
  }
  const entry = FILES[pathname];
  if (!entry) return null;
  // The font address never changes, so it can be cached for a long time.
  const cache = pathname.startsWith("/fonts/") ? "public, max-age=31536000, immutable" : "no-cache";
  const response = new Response(Bun.file(join(ROOT, entry.file)), { headers: headers(entry.type, cache) });
  // The configuration page is private: keep it out of search results.
  if (pathname === "/config") response.headers.set("x-robots-tag", "noindex");
  return response;
}

export const notFoundPage = () =>
  new Response(Bun.file(join(ROOT, "404.html")), { status: 404, headers: headers("text/html; charset=utf-8") });
