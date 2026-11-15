// Route matching and request handling for the site Worker (worker/index.ts).
//
// wrangler.jsonc serves dist/ first, so this code only runs for a request that
// matched no built file. A real client-side route (/dashboard, /invite/<token>)
// gets the SPA shell with 200, as before; anything else (/.env, /wp-login.php,
// /no-such-page) gets the same shell with 404, so a browser still renders the
// app's own NotFound page while crawlers and scanners see a real 404.
//
// Kept free of Workers-runtime imports so the root Vitest suite can test it.

export type RouteManifest = {
  /** Lowercased paths without a trailing slash, e.g. "/dashboard". */
  static: string[];
  /** Lowercased patterns where ":name" matches one path segment, e.g. "/invite/:token". */
  patterns: string[];
};

export interface AssetsBinding {
  fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
}

export interface Env {
  ASSETS: AssetsBinding;
}

/** Same normalization as scripts/route-manifest.mjs: lowercase, no trailing slash. */
export function normalizePath(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (trimmed || "/").toLowerCase();
}

// React Router matches the decoded path, so /d%61shboard renders /dashboard.
// Decode each segment the same way React Router does (an encoded "/" stays
// "%2f" inside its segment); a malformed escape is not a route, so null.
function decodeSegments(path: string): string[] | null {
  const segments = path.split("/");
  if (!path.includes("%")) return segments;
  try {
    return segments.map((segment) => decodeURIComponent(segment).replace(/\//g, "%2f").toLowerCase());
  } catch {
    return null;
  }
}

export function createRouteMatcher(manifest: RouteManifest): (pathname: string) => boolean {
  const statics = new Set(manifest.static);
  const patterns = manifest.patterns.map((p) => p.split("/"));
  return (pathname) => {
    const path = normalizePath(pathname);
    if (statics.has(path)) return true;
    const segments = decodeSegments(path);
    if (!segments) return false;
    if (path.includes("%") && statics.has(segments.join("/"))) return true;
    return patterns.some(
      (pattern) =>
        pattern.length === segments.length &&
        pattern.every((part, i) => (part.startsWith(":") ? segments[i] !== "" : part === segments[i])),
    );
  };
}

export function createHandler(manifest: RouteManifest) {
  const isKnownRoute = createRouteMatcher(manifest);
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const shellUrl = new URL("/", url);

      if (isKnownRoute(url.pathname)) {
        // Pass the original request through (method, conditional headers) so
        // HEAD and If-None-Match behave exactly like a direct asset hit.
        return env.ASSETS.fetch(new Request(shellUrl, request));
      }

      // Unknown path: the shell, unconditionally, with status 404.
      const shell = await env.ASSETS.fetch(shellUrl);
      if (!shell.ok) {
        return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      const headers = new Headers(shell.headers);
      headers.delete("ETag");
      return new Response(request.method === "HEAD" ? null : shell.body, { status: 404, headers });
    },
  };
}
