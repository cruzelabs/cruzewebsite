// Request handling for og.cruzemaps.com. It has no Workers-runtime imports, so
// the root Vitest suite runs it in Node (handler.test.ts), the same way it runs
// the watchdog's apiProbe.ts. index.ts passes in the real parts: the workers-og
// renderer, the edge cache and the two rate limiters from wrangler.jsonc.
//
// A render costs about 90 ms of CPU (renders were behind the October 2026
// CPU-limit emails), so the checks run in this order:
//   1. Only GET / is a real OG request. Anything else is a 404 before any work.
//   2. The query is cut down to the three values that change the picture
//      (title, subtitle, kind), each cleaned and capped, and only those values
//      make the cache key. An extra parameter, or text past a cap, gets the
//      cached PNG instead of a new render.
//   3. A cached PNG is served without asking the rate limiters, so a crawler
//      never gets a 429 for an image that is already rendered.
//   4. A render needs the per-IP limiter (keyed by CF-Connecting-IP) and then
//      the global one to agree, or the answer is a 429. The global limiter is
//      asked only after the IP passes, so one noisy IP cannot spend the budget
//      of everyone else. Cloudflare counts both per location, not worldwide.

/** The native Cloudflare rate-limit binding (`ratelimits` in wrangler.jsonc). */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  RL_PER_IP?: RateLimit;
  RL_GLOBAL?: RateLimit;
}

/** The part of the Workers Cache API (caches.default) this Worker uses. */
export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Deps {
  cache: EdgeCache;
  /** Turns the card HTML into PNG bytes (workers-og in production). */
  render(html: string): Promise<ArrayBuffer>;
  waitUntil(promise: Promise<unknown>): void;
}

/** Caps in characters (code points). The longest real page title is under 100. */
export const MAX_TITLE = 140;
export const MAX_SUBTITLE = 200;
export const DEFAULT_TITLE = "Cruze";
export const DEFAULT_SUBTITLE = "Dissolve traffic, not just avoid it";

/** Matches the limiters' period in wrangler.jsonc (60 seconds). */
export const RETRY_AFTER_SECONDS = 60;
export const PNG_CACHE_CONTROL = "public, max-age=86400, s-maxage=86400, immutable";

const BRAND = {
  cyan: "#00F2FF",
  orange: "#FF8C00",
  charcoal: "#0B0E14",
};

// A Map, not an object, so a kind like "toString" is not found on a prototype.
const KIND_LABELS = new Map<string, string>([
  ["case-study", "Case Study"],
  ["insight", "Insight"],
  ["fleet", "For Fleets"],
  ["city", "For Cities"],
  ["investor", "Investors"],
]);

export interface Card {
  title: string;
  subtitle: string;
  /** One of the KIND_LABELS keys, or "default". */
  kind: string;
}

/**
 * Text that is safe to drop into the card HTML. Drops < and > (workers-og does
 * not decode entities, so escaping would print `&lt;`), turns control
 * characters and runs of whitespace into one space, and keeps at most `max`
 * code points, so an emoji is never cut in half. Empty text gets `fallback`.
 */
export function cleanText(raw: string | null, max: number, fallback: string): string {
  const text = (raw ?? "").replace(/[<>]/g, "").replace(/[\p{Cc}\s]+/gu, " ").trim();
  return Array.from(text).slice(0, max).join("").trim() || fallback;
}

export function parseCard(url: URL): Card {
  const kind = url.searchParams.get("kind");
  return {
    title: cleanText(url.searchParams.get("title"), MAX_TITLE, DEFAULT_TITLE),
    subtitle: cleanText(url.searchParams.get("subtitle"), MAX_SUBTITLE, DEFAULT_SUBTITLE),
    kind: kind !== null && KIND_LABELS.has(kind) ? kind : "default",
  };
}

/** The cache key for a card: the same card always gets the same key. */
export function cacheKey(origin: string, card: Card): string {
  const query = new URLSearchParams({ title: card.title, subtitle: card.subtitle, kind: card.kind });
  return `${origin}/?${query}`;
}

export function cardHtml(card: Card): string {
  const accent = card.kind === "fleet" ? BRAND.orange : BRAND.cyan;
  const tag = KIND_LABELS.get(card.kind) ?? "Cruze";
  // In workers-og every <div> that holds text needs display: flex.
  return `
      <div style="
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        width: 1200px;
        height: 630px;
        background: linear-gradient(135deg, ${BRAND.charcoal} 0%, #050810 100%);
        color: white;
        padding: 80px;
        font-family: 'Inter', sans-serif;
      ">
        <div style="display: flex; align-items: center; gap: 16px;">
          <div style="
            width: 48px;
            height: 48px;
            border-radius: 12px;
            background: ${accent};
            display: flex;
            align-items: center;
            justify-content: center;
            color: ${BRAND.charcoal};
            font-weight: 800;
            font-size: 28px;
          ">C</div>
          <span style="font-size: 28px; font-weight: 800; letter-spacing: 0.05em;">CRUZE</span>
          <span style="
            margin-left: auto;
            font-size: 16px;
            color: ${accent};
            text-transform: uppercase;
            letter-spacing: 0.2em;
            border: 1px solid ${accent}55;
            padding: 6px 14px;
            border-radius: 999px;
          ">${tag}</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 16px;">
          <div style="
            display: flex;
            font-size: 64px;
            font-weight: 700;
            line-height: 1.1;
            letter-spacing: -0.02em;
            max-width: 1000px;
          ">${card.title}</div>
          <div style="
            display: flex;
            font-size: 28px;
            color: rgba(255,255,255,0.6);
            line-height: 1.4;
            max-width: 1000px;
          ">${card.subtitle}</div>
        </div>

        <div style="
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 18px;
          color: rgba(255,255,255,0.5);
        ">
          <span>cruzemaps.com</span>
          <span style="color: ${accent};">Swarm intelligence · Physics-informed AI</span>
        </div>
      </div>
    `.replace(/>\s+</g, "><"); // whitespace between tags becomes stray flex items
}

function tooManyRequests(): Response {
  return new Response("Too many requests\n", {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(RETRY_AFTER_SECONDS),
    },
  });
}

/**
 * Asks the limiters whether this IP may start a render. Throws when a binding
 * is missing, so a config mistake shows up as an exception (which the
 * watchdog reports) and never as renders with no limit.
 */
async function mayRender(env: Env, ip: string): Promise<boolean> {
  if (!env.RL_PER_IP || !env.RL_GLOBAL) {
    throw new Error("og-image: the RL_PER_IP and RL_GLOBAL rate limit bindings are missing (see wrangler.jsonc)");
  }
  if (!(await env.RL_PER_IP.limit({ key: ip })).success) return false;
  return (await env.RL_GLOBAL.limit({ key: "global" })).success;
}

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  // Scanners probe paths like /.env and /info.php all day. Only the root path
  // is a real OG request, so bail before touching the cache or the renderer.
  if (request.method !== "GET" || url.pathname !== "/") {
    return new Response("Not found", { status: 404 });
  }

  const card = parseCard(url);
  const key = new Request(cacheKey(url.origin, card));
  const cached = await deps.cache.match(key);
  if (cached) return cached;

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await mayRender(env, ip))) return tooManyRequests();

  const png = await deps.render(cardHtml(card));
  // Buffered, so a failed render is a 500 here instead of a 200 with an empty
  // body (workers-og streams, so its errors land after the headers).
  if (!png.byteLength) return new Response("render failed", { status: 500 });

  const response = new Response(png, {
    headers: {
      "content-type": "image/png",
      "cache-control": PNG_CACHE_CONTROL,
    },
  });
  deps.waitUntil(deps.cache.put(key, response.clone()));
  return response;
}
