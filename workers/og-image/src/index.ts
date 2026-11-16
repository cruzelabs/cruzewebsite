// Cloudflare Worker that generates Open Graph share images on the fly.
// Hits: GET /?title=...&subtitle=...&kind=case-study|insight|fleet|city|investor
// Returns: 1200x630 PNG, edge-cached for 24h. A render past the per-IP or
// global rate limit (wrangler.jsonc) gets a 429 with Retry-After instead.
//
// Uses workers-og (satori + resvg-wasm). No Node deps, runs on the Cloudflare
// edge globally. Deploy via the Wrangler config alongside this worker.
//
// The request logic lives in handler.ts, which the root Vitest suite tests.
// This file only wires in the renderer, the edge cache and the bindings.

import { ImageResponse } from "workers-og";
import { handle, type Env } from "./handler";

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, {
      cache: caches.default,
      render: (html) => new ImageResponse(html, { width: 1200, height: 630 }).arrayBuffer(),
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  },
} satisfies ExportedHandler<Env>;
