// Fails a Cloudflare production build when the site's public configuration is
// missing.
//
// Without VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY the app still builds,
// but src/lib/supabase.ts falls back to a placeholder project: sign-in, the
// pilot application and the contact form stop working, and nothing in the
// build says so. That nearly shipped on 2026-11-11, when reconnecting the
// Worker to its moved repo dropped the build variables. Without
// VITE_POSTHOG_KEY analytics is silently off.
//
// The check applies only inside Cloudflare Workers Builds (WORKERS_CI is set
// there) and only to the production branch, so local builds, GitHub Actions
// and branch previews are not affected. A Cloudflare build whose branch is
// unknown is treated as production.
//
// Runs as the first step of `npm run build`. Unit test:
// `node --test scripts/check-build-env.test.mjs`.
import { fileURLToPath } from "node:url";

export const REQUIRED = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_POSTHOG_KEY"];
export const PRODUCTION_BRANCH = "main";

/** True when this is a Cloudflare build (strict mode: every branch counts). */
export function isProductionBuild(env) {
  return Boolean(env.WORKERS_CI);
}

/** Names of required variables that are unset or blank. */
export function missingBuildEnv(env, required = REQUIRED) {
  return required.filter((name) => !String(env[name] ?? "").trim());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!isProductionBuild(process.env)) {
    console.log("check-build-env: not a Cloudflare production build, skipping.");
  } else {
    const missing = missingBuildEnv(process.env);
    if (missing.length > 0) {
      console.error(`check-build-env: refusing to build production without ${missing.join(", ")}.`);
      console.error("Add them under the Worker's Settings, Builds, Variables and secrets, then retry the build.");
      process.exit(1);
    }
    console.log("check-build-env: production build variables are set.");
  }
}
