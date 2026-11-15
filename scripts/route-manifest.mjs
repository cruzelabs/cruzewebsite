#!/usr/bin/env node
// Build-time route manifest for the site Worker (worker/index.ts).
//
// The Worker only runs for requests that match no file in dist/, and it has to
// tell a real client-side route (/dashboard, /invite/<token>) from junk
// (/.env, /wp-login.php) so junk gets a 404 instead of the SPA shell with 200.
// This script derives the list of real routes from the same sources the app
// and the prerenderer use, so it cannot drift:
//   - every <Route path="..."> in src/App.tsx that exists in a production build
//     (routes inside an `import.meta.env.DEV ? ... :` branch are dev-only),
//   - every prerendered path in src/lib/seo.ts ROUTES,
//   - every slug in the content stores behind /insights/:slug, /cities/:slug
//     and /lanes/:slug (an unknown slug there is a 404).
// Any other `:param` route (/invite/:token, /loi/:id) accepts one segment.
//
// `npm run build` runs it after the prerender and writes worker/route-manifest.json
// (gitignored), which wrangler bundles into the Worker at deploy time.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { loadModuleArray, loadRoutes } from "./prerender.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
export const MANIFEST_PATH = join(ROOT, "worker", "route-manifest.json");

// Param routes whose valid values are exactly the slugs of a content store.
export const CONTENT_ROUTES = {
  "/insights/:slug": { file: "src/content/insights.ts", exportName: "INSIGHTS" },
  "/cities/:slug": { file: "src/content/cities.ts", exportName: "CITIES" },
  "/lanes/:slug": { file: "src/content/lanes.ts", exportName: "LANES" },
};

const DEV_CONDITION = "import.meta.env.DEV";

/**
 * Every <Route path="..."> in a TSX source, with whether it only exists in a
 * dev build. Throws on a path that is not a string literal, so a route the
 * manifest cannot see fails the build instead of turning into a 404.
 */
export function extractAppRoutes(source, fileName = "App.tsx") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const routes = [];

  const devOnly = (node) => {
    for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isConditionalExpression(parent) && parent.condition.getText(sf) === DEV_CONDITION) {
        if (child === parent.whenTrue) return true;
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        parent.left.getText(sf) === DEV_CONDITION &&
        child === parent.right
      ) {
        return true;
      }
    }
    return false;
  };

  const visit = (node) => {
    const tag =
      ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node) ? node : undefined;
    if (tag && tag.tagName.getText(sf) === "Route") {
      const attr = tag.attributes.properties.find(
        (p) => ts.isJsxAttribute(p) && p.name.getText(sf) === "path",
      );
      if (attr) {
        const init = attr.initializer;
        const literal =
          init && ts.isStringLiteral(init)
            ? init
            : init && ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)
              ? init.expression
              : undefined;
        if (!literal) {
          const { line } = sf.getLineAndCharacterOfPosition(attr.getStart(sf));
          throw new Error(
            `${fileName}:${line + 1}: <Route path> must be a string literal so scripts/route-manifest.mjs can read it`,
          );
        }
        routes.push({ path: literal.text, devOnly: devOnly(tag) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return routes;
}

/** Lowercase, no trailing slash ("/" stays "/"). The Worker normalizes the same way. */
export function normalizePath(path) {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return (trimmed || "/").toLowerCase();
}

export async function buildRouteManifest(root = ROOT) {
  const appSource = await readFile(join(root, "src/App.tsx"), "utf8");
  const appRoutes = extractAppRoutes(appSource);
  const { ROUTES } = await loadRoutes();

  const statics = new Set();
  const patterns = new Set();

  for (const { path, devOnly } of appRoutes) {
    if (devOnly || path === "*") continue;
    if (path.includes("*") || path.includes("?")) {
      throw new Error(
        `Route "${path}" uses a splat or optional segment; teach scripts/route-manifest.mjs and worker/routes.ts about it`,
      );
    }
    if (!path.includes(":")) {
      statics.add(normalizePath(path));
    } else if (CONTENT_ROUTES[path]) {
      const { file, exportName } = CONTENT_ROUTES[path];
      const items = await loadModuleArray(file, exportName);
      const prefix = path.slice(0, path.lastIndexOf("/") + 1);
      for (const item of items) statics.add(normalizePath(prefix + item.slug));
    } else {
      patterns.add(normalizePath(path));
    }
  }
  for (const route of ROUTES) statics.add(normalizePath(route.path));

  return {
    static: [...statics].sort(),
    patterns: [...patterns].sort(),
  };
}

async function main() {
  const manifest = await buildRouteManifest();
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `✓ wrote worker/route-manifest.json (${manifest.static.length} paths, ${manifest.patterns.length} patterns)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("✗ route manifest failed:", err);
    process.exit(1);
  });
}
