// Guards the site Worker's 404 logic (worker/routes.ts) and the build-time
// manifest it runs on (scripts/route-manifest.mjs). The key check: every
// <Route> in src/App.tsx that exists in production must match, so adding a
// route can never turn a real page into a 404. Routes are found here with a
// plain regex, independent of the manifest script's TypeScript AST walk.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script, no type declarations
import { buildRouteManifest, CONTENT_ROUTES, extractAppRoutes, MANIFEST_PATH } from "../scripts/route-manifest.mjs";
// @ts-expect-error plain .mjs build script, no type declarations
import { loadModuleArray, loadRoutes } from "../scripts/prerender.mjs";
import { createHandler, createRouteMatcher, type RouteManifest } from "./routes";

const ROOT = path.resolve(__dirname, "..");
const APP_SOURCE = readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");

// Every path="..." on a <Route ...> element, found textually.
const regexRoutePaths = [...APP_SOURCE.matchAll(/<Route\b[^>]*?\bpath=["']([^"']+)["']/g)].map((m) => m[1]);

let manifest: RouteManifest;
let isKnown: (p: string) => boolean;
const appRoutes: { path: string; devOnly: boolean }[] = extractAppRoutes(APP_SOURCE);

beforeAll(async () => {
  manifest = await buildRouteManifest();
  isKnown = createRouteMatcher(manifest);
});

function sampleFor(routePath: string): Promise<string> | string {
  const content = CONTENT_ROUTES[routePath];
  if (content) {
    return loadModuleArray(content.file, content.exportName).then(
      (items: { slug: string }[]) => routePath.replace(/:[^/]+/, items[0].slug),
    );
  }
  return routePath.replace(/:[^/]+/g, "sample-1234");
}

// A second, unrelated value for each open param, so a manifest that listed one
// literal sample instead of a pattern would still fail.
const OTHER_PARAM = "7d4c2e1a-aaaa-4bbb-8ccc-0123456789ab";

describe("route manifest vs src/App.tsx", () => {
  it("the AST walk sees exactly the routes a text search finds", () => {
    expect(regexRoutePaths.length).toBeGreaterThan(30);
    expect(appRoutes.map((r) => r.path).sort()).toEqual([...regexRoutePaths].sort());
  });

  it("every production route in App.tsx is a known route", async () => {
    const missing: string[] = [];
    for (const { path: p, devOnly } of appRoutes) {
      if (devOnly || p === "*") continue;
      const sample = await sampleFor(p);
      const variants = [sample, `${sample}/`, sample.toUpperCase()];
      if (p.includes(":") && !CONTENT_ROUTES[p]) variants.push(p.replace(/:[^/]+/g, OTHER_PARAM));
      for (const variant of variants) {
        if (!isKnown(variant)) missing.push(variant);
      }
    }
    expect(missing).toEqual([]);
  });

  it("dev-only routes are flagged and answer 404 in production", () => {
    const devOnly = appRoutes.filter((r) => r.devOnly).map((r) => r.path).sort();
    expect(devOnly).toEqual(["/demo", "/diag", "/impersonate"]);
    // /demo also exists in production (a redirect to /login); the other two do not.
    expect(isKnown("/demo")).toBe(true);
    expect(isKnown("/impersonate")).toBe(false);
    expect(isKnown("/diag")).toBe(false);
  });

  it("every prerendered page in seo.ts ROUTES is a known route", async () => {
    const { ROUTES } = await loadRoutes();
    const missing = ROUTES.map((r: { path: string }) => r.path).filter((p: string) => !isKnown(p));
    expect(missing).toEqual([]);
  });

  it("every content-store slug is known and an unknown slug is not", async () => {
    for (const [routePath, { file, exportName }] of Object.entries(
      CONTENT_ROUTES as Record<string, { file: string; exportName: string }>,
    )) {
      const items: { slug: string }[] = await loadModuleArray(file, exportName);
      expect(items.length).toBeGreaterThan(0);
      for (const { slug } of items) expect(isKnown(routePath.replace(":slug", slug))).toBe(true);
      expect(isKnown(routePath.replace(":slug", "no-such-slug-xyz"))).toBe(false);
    }
  });

  it("the built worker/route-manifest.json matches the sources, when present", async () => {
    if (!existsSync(MANIFEST_PATH)) return; // only written by `npm run build`
    expect(JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))).toEqual(manifest);
  });

  it("a non-literal <Route path> fails loudly instead of being skipped", () => {
    expect(() => extractAppRoutes(`const x = <Route path={dynamic} element={<A />} />;`)).toThrow(/string literal/);
  });

  it("flags routes inside an import.meta.env.DEV branch", () => {
    const src = `
      const a = <Routes>
        <Route path="/a" element={<A />} />
        {import.meta.env.DEV ? <Route path="/dev" element={<D />} /> : <Route path="/prod" element={<P />} />}
        {import.meta.env.DEV && <Route path="/dev2" element={<D />} />}
      </Routes>;`;
    expect(extractAppRoutes(src)).toEqual([
      { path: "/a", devOnly: false },
      { path: "/dev", devOnly: true },
      { path: "/prod", devOnly: false },
      { path: "/dev2", devOnly: true },
    ]);
  });
});

describe("createRouteMatcher", () => {
  const match = createRouteMatcher({ static: ["/", "/faq", "/insights/known"], patterns: ["/invite/:token"] });

  it.each([
    "/",
    "/faq",
    "/faq/",
    "/FAQ",
    "/f%61q",
    "/insights/known",
    "/invite/abc",
    "/invite/abc/",
    "/invite/a%2Fb",
  ])("knows %s", (p) => {
    expect(match(p)).toBe(true);
  });

  it.each([
    "/.env",
    "/wp-login.php",
    "/no-such-page",
    "/.git/config",
    "/faq/extra",
    "/insights/unknown",
    "/invite",
    "/invite/",
    "/invite/a/b",
    "/assets/missing-abc123.js",
    "/f%61q%",
    "/insights%2Fknown",
    "/%E0%A4%A",
  ])("rejects %s", (p) => {
    expect(match(p)).toBe(false);
  });
});

describe("createHandler", () => {
  const SHELL = "<!doctype html><title>Cruze</title><div id=root></div>";
  const calls: Request[] = [];
  const env = {
    ASSETS: {
      async fetch(input: Request | URL | string) {
        const req = input instanceof Request ? input : new Request(input);
        calls.push(req);
        if (new URL(req.url).pathname !== "/") return new Response("nope", { status: 404 });
        return new Response(req.method === "HEAD" ? null : SHELL, {
          status: 200,
          headers: { "Content-Type": "text/html", ETag: '"abc"', "X-Frame-Options": "DENY" },
        });
      },
    },
  };
  const handler = createHandler({ static: ["/dashboard"], patterns: ["/loi/:id"] });

  it("serves the shell with 200 for a client-side route, keeping query and headers", async () => {
    calls.length = 0;
    const res = await handler.fetch(new Request("https://cruzemaps.com/dashboard?tab=map", { headers: { "If-None-Match": '"x"' } }), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SHELL);
    expect(new URL(calls[0].url).pathname).toBe("/");
    expect(calls[0].headers.get("If-None-Match")).toBe('"x"');
  });

  it("serves a param route with 200", async () => {
    const res = await handler.fetch(new Request("https://cruzemaps.com/loi/42"), env);
    expect(res.status).toBe(200);
  });

  it.each(["/.env", "/wp-login.php", "/no-such-page"])("answers %s with the shell and 404", async (p) => {
    const res = await handler.fetch(new Request(`https://cruzemaps.com${p}`), env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(SHELL);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("ETag")).toBeNull();
  });

  it("drops the body of a 404 for HEAD", async () => {
    const res = await handler.fetch(new Request("https://cruzemaps.com/.env", { method: "HEAD" }), env);
    expect(res.status).toBe(404);
    expect(res.body).toBeNull();
  });

  it("still answers 404 when the shell itself cannot be read", async () => {
    const broken = { ASSETS: { fetch: async () => new Response("err", { status: 500 }) } };
    const res = await handler.fetch(new Request("https://cruzemaps.com/.env"), broken);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });
});
