// Readiness E6: og.cruzemaps.com rendered a PNG for any ?title= with no rate
// limit. These tests hold the request logic (handler.ts) to its contract:
// renders are rate limited per IP and in total, a cached card is always
// served, the card text is capped and cleaned, and only the capped card makes
// the cache key, so extra parameters or long text cannot force new renders.
// Runs in Node from the root Vitest suite; the renderer, cache and limiters
// are fakes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  DEFAULT_SUBTITLE,
  DEFAULT_TITLE,
  MAX_SUBTITLE,
  MAX_TITLE,
  PNG_CACHE_CONTROL,
  RETRY_AFTER_SECONDS,
  cacheKey,
  cardHtml,
  cleanText,
  handle,
  parseCard,
  type Deps,
  type Env,
  type RateLimit,
} from "./handler";

const ORIGIN = "https://og.cruzemaps.com";
const IP_A = "203.0.113.7";
const IP_B = "198.51.100.20";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

/** Allows `max` calls per key, like a Cloudflare limiter within one period. */
function limiter(max: number): RateLimit & { keys: string[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= max };
    },
  };
}

function memoryCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async match(request: Request) {
      return store.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      store.set(request.url, response);
    },
  };
}

function setup({ perIp = 10, global = 60, png = PNG }: { perIp?: number; global?: number; png?: ArrayBuffer } = {}) {
  const cache = memoryCache();
  const rendered: string[] = [];
  const pending: Promise<unknown>[] = [];
  const perIpLimiter = limiter(perIp);
  const globalLimiter = limiter(global);
  const env: Env = { RL_PER_IP: perIpLimiter, RL_GLOBAL: globalLimiter };
  const deps: Deps = {
    cache,
    render: async (html) => {
      rendered.push(html);
      return png;
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  /** GET `${ORIGIN}${path}` from `ip` (null: no CF-Connecting-IP header). */
  const get = async (path: string, ip: string | null = IP_A, init: RequestInit = {}, withEnv: Env = env) => {
    const headers = ip === null ? {} : { "CF-Connecting-IP": ip };
    const response = await handle(new Request(`${ORIGIN}${path}`, { headers, ...init }), withEnv, deps);
    await Promise.all(pending);
    return response;
  };
  return { cache, rendered, perIpLimiter, globalLimiter, get };
}

describe("which requests render", () => {
  it("answers only GET / and does no work for anything else", async () => {
    const { get, rendered, perIpLimiter, cache } = setup();
    expect((await get("/.env")).status).toBe(404);
    expect((await get("/info.php?title=x")).status).toBe(404);
    expect((await get("/?title=x", IP_A, { method: "POST" })).status).toBe(404);
    expect(rendered).toHaveLength(0);
    expect(perIpLimiter.keys).toHaveLength(0);
    expect(cache.store.size).toBe(0);
  });

  it("renders a PNG with the 24-hour cache headers and stores it under the card's key", async () => {
    const { get, cache } = setup();
    const response = await get("/?title=Hello&kind=case-study");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(PNG_CACHE_CONTROL);
    expect(PNG_CACHE_CONTROL).toBe("public, max-age=86400, s-maxage=86400, immutable");
    expect((await response.arrayBuffer()).byteLength).toBe(PNG.byteLength);

    const key = cacheKey(ORIGIN, { title: "Hello", subtitle: DEFAULT_SUBTITLE, kind: "case-study" });
    expect([...cache.store.keys()]).toEqual([key]);
    expect(cache.store.get(key)?.headers.get("cache-control")).toBe(PNG_CACHE_CONTROL);
  });

  it("serves a cached card without asking the rate limiters", async () => {
    const { get, rendered, perIpLimiter, globalLimiter } = setup();
    await get("/?title=Hello");
    const again = await get("/?title=Hello");

    expect(again.status).toBe(200);
    expect(again.headers.get("cache-control")).toBe(PNG_CACHE_CONTROL);
    expect(rendered).toHaveLength(1);
    expect(perIpLimiter.keys).toHaveLength(1);
    expect(globalLimiter.keys).toHaveLength(1);
  });

  it("does not cache an empty render", async () => {
    const { get, cache } = setup({ png: new ArrayBuffer(0) });
    expect((await get("/?title=Hello")).status).toBe(500);
    expect(cache.store.size).toBe(0);
  });
});

describe("rate limits", () => {
  it("answers 429 with Retry-After once an IP passes its limit, and renders nothing", async () => {
    const { get, rendered, cache } = setup({ perIp: 2 });
    expect((await get("/?title=one")).status).toBe(200);
    expect((await get("/?title=two")).status).toBe(200);

    const limited = await get("/?title=three");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("content-type")).not.toBe("image/png");
    expect(rendered).toHaveLength(2);
    expect(cache.store.size).toBe(2);
  });

  it("keys the per-IP limit by CF-Connecting-IP, so another IP still renders", async () => {
    const { get, perIpLimiter } = setup({ perIp: 1 });
    expect((await get("/?title=one", IP_A)).status).toBe(200);
    expect((await get("/?title=two", IP_A)).status).toBe(429);
    expect((await get("/?title=two", IP_B)).status).toBe(200);
    expect(perIpLimiter.keys).toEqual([IP_A, IP_A, IP_B]);
  });

  it("counts requests with no client IP together", async () => {
    const { get, perIpLimiter } = setup({ perIp: 1 });
    expect((await get("/?title=one", null)).status).toBe(200);
    expect((await get("/?title=two", null)).status).toBe(429);
    expect(perIpLimiter.keys).toEqual(["unknown", "unknown"]);
  });

  it("answers 429 when the global limit is spent, whatever the IP", async () => {
    const { get } = setup({ global: 1 });
    expect((await get("/?title=one", IP_A)).status).toBe(200);
    expect((await get("/?title=two", IP_B)).status).toBe(429);
  });

  it("does not let a blocked IP spend the global budget", async () => {
    const { get, globalLimiter } = setup({ perIp: 1, global: 2 });
    expect((await get("/?title=a1", IP_A)).status).toBe(200);
    for (const title of ["a2", "a3", "a4", "a5"]) {
      expect((await get(`/?title=${title}`, IP_A)).status).toBe(429);
    }
    expect((await get("/?title=b1", IP_B)).status).toBe(200);
    expect(globalLimiter.keys).toEqual(["global", "global"]);
  });

  it("still serves an IP past its limit the cards that are already cached", async () => {
    const { get } = setup({ perIp: 1 });
    expect((await get("/?title=cached", IP_A)).status).toBe(200);
    expect((await get("/?title=new", IP_A)).status).toBe(429);
    expect((await get("/?title=cached", IP_A)).status).toBe(200);
  });

  it("refuses to render without the limiter bindings, but serves cached cards", async () => {
    const { get, rendered } = setup();
    await get("/?title=cached");
    await expect(get("/?title=new", IP_A, {}, {})).rejects.toThrow(/RL_PER_IP and RL_GLOBAL/);
    expect(rendered).toHaveLength(1);
    expect((await get("/?title=cached", IP_A, {}, {})).status).toBe(200);
  });
});

describe("the card text and the cache key", () => {
  it("caps the title, so text past the cap cannot force a new render", async () => {
    const { get, rendered } = setup();
    const capped = "A".repeat(MAX_TITLE);
    expect((await get(`/?title=${capped}tail-one`)).status).toBe(200);
    expect((await get(`/?title=${capped}tail-two`)).status).toBe(200);

    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain(`>${capped}<`);
    expect(rendered[0]).not.toContain("tail");
  });

  it("caps the subtitle the same way", async () => {
    const { get, rendered } = setup();
    const capped = "b".repeat(MAX_SUBTITLE);
    await get(`/?subtitle=${capped}x`);
    await get(`/?subtitle=${capped}y`);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain(`>${capped}<`);
  });

  it("ignores other parameters, so they cannot force a new render", async () => {
    const { get, rendered } = setup();
    await get("/?title=Hello&utm_source=x");
    await get("/?utm_source=y&title=Hello&cb=123");
    await get("/?title=Hello&kind=not-a-kind");
    expect(rendered).toHaveLength(1);
  });

  it("gives every default card one key", () => {
    const keys = ["/", "/?title=", "/?title=%20%20", `/?title=${DEFAULT_TITLE}&kind=nope`].map((path) =>
      cacheKey(ORIGIN, parseCard(new URL(`${ORIGIN}${path}`))),
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("cuts at a code point, so an emoji at the cap is never split", () => {
    const head = "a".repeat(MAX_TITLE - 1);
    const title = cleanText(`${head}😀😀`, MAX_TITLE, DEFAULT_TITLE);
    expect(title).toBe(`${head}😀`);
    expect(Array.from(title)).toHaveLength(MAX_TITLE);
  });

  it("drops < and >, and folds control characters and whitespace into one space", () => {
    expect(cleanText("<img src=x>Hi", MAX_TITLE, DEFAULT_TITLE)).toBe("img src=xHi");
    expect(cleanText("  a\u0000\u0007b \n\t c  ", MAX_TITLE, DEFAULT_TITLE)).toBe("a b c");
    expect(cleanText("<>", MAX_TITLE, DEFAULT_TITLE)).toBe(DEFAULT_TITLE);
    expect(cleanText(null, MAX_SUBTITLE, DEFAULT_SUBTITLE)).toBe(DEFAULT_SUBTITLE);
  });

  it("puts no request text into the markup as a tag", async () => {
    const { get, rendered } = setup();
    await get(`/?title=${encodeURIComponent("<img src=x onerror=1>Hi")}&subtitle=${encodeURIComponent("</div><div>")}`);
    expect(rendered[0]).not.toContain("<img");
    expect(rendered[0]).toContain(">img src=x onerror=1Hi<");
  });

  it("knows only the listed kinds, so a prototype name is the default kind", () => {
    const kindOf = (kind: string) => parseCard(new URL(`${ORIGIN}/?kind=${kind}`)).kind;
    expect(kindOf("fleet")).toBe("fleet");
    expect(kindOf("case-study")).toBe("case-study");
    expect(kindOf("toString")).toBe("default");
    expect(kindOf("__proto__")).toBe("default");

    const fleet = cardHtml({ title: "t", subtitle: "s", kind: "fleet" });
    expect(fleet).toContain(">For Fleets<");
    expect(fleet).toContain("#FF8C00");
    expect(cardHtml({ title: "t", subtitle: "s", kind: "default" })).toContain(">Cruze<");
  });
});

describe("wrangler.jsonc", () => {
  const read = (worker: string) => {
    const path = new URL(`../../${worker}/wrangler.jsonc`, import.meta.url);
    const { config, error } = ts.parseConfigFileTextToJson(path.pathname, readFileSync(path, "utf8"));
    expect(error).toBeUndefined();
    return config;
  };

  it("binds both limiters with a 60-second period, matching Retry-After", () => {
    const limits = read("og-image").ratelimits as { name: string; simple: { limit: number; period: number } }[];
    expect(limits.map((l) => l.name).sort()).toEqual(["RL_GLOBAL", "RL_PER_IP"]);
    for (const l of limits) {
      expect(l.simple.period).toBe(RETRY_AFTER_SECONDS);
      expect(l.simple.limit).toBeGreaterThan(0);
    }
  });

  it("uses namespace ids no other Worker in this repo uses", () => {
    const ids = (config: { ratelimits?: { namespace_id: string }[]; unsafe?: { bindings?: { type: string; namespace_id: string }[] } }) => [
      ...(config.ratelimits ?? []).map((b) => b.namespace_id),
      ...(config.unsafe?.bindings ?? []).filter((b) => b.type === "ratelimit").map((b) => b.namespace_id),
    ];
    const ours = ids(read("og-image"));
    const others = ids(read("frame-analyze"));
    expect(ours).toHaveLength(2);
    expect(new Set(ours).size).toBe(2);
    expect(ours.filter((id) => others.includes(id))).toEqual([]);
  });
});
