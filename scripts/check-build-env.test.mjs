// Unit tests for scripts/check-build-env.mjs. Run from the repo root:
//
//   node --test scripts/check-build-env.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isProductionBuild, missingBuildEnv, REQUIRED } from "./check-build-env.mjs";

const SCRIPT = fileURLToPath(new URL("./check-build-env.mjs", import.meta.url));
const FULL = {
  VITE_SUPABASE_URL: "https://example.invalid",
  VITE_SUPABASE_ANON_KEY: "placeholder-for-test",
  VITE_POSTHOG_KEY: "placeholder-for-test",
};

// Runs the script with exactly `env` (plus PATH), so the machine's own
// variables cannot change the result.
function run(env) {
  return spawnSync(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
}

test("only a Cloudflare build of the production branch counts as production", () => {
  assert.equal(isProductionBuild({}), false);
  assert.equal(isProductionBuild({ CI: "true" }), false);
  assert.equal(isProductionBuild({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" }), true);
  assert.equal(isProductionBuild({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "refs/heads/main" }), true);
  assert.equal(isProductionBuild({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "feat/lead-inbox-slack" }), false);
  assert.equal(isProductionBuild({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "maintenance" }), false);
});

test("a Cloudflare build with no branch is treated as production", () => {
  assert.equal(isProductionBuild({ WORKERS_CI: "1" }), true);
  assert.equal(isProductionBuild({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "  " }), true);
});

test("missingBuildEnv names what is unset or blank", () => {
  assert.deepEqual(missingBuildEnv(FULL), []);
  assert.deepEqual(missingBuildEnv({}), REQUIRED);
  assert.deepEqual(missingBuildEnv({ ...FULL, VITE_SUPABASE_ANON_KEY: "  " }), ["VITE_SUPABASE_ANON_KEY"]);
  assert.deepEqual(missingBuildEnv({ ...FULL, VITE_POSTHOG_KEY: undefined }), ["VITE_POSTHOG_KEY"]);
});

test("the script fails a production build that lacks a variable and names it", () => {
  const r = run({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", VITE_SUPABASE_URL: FULL.VITE_SUPABASE_URL });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VITE_SUPABASE_ANON_KEY, VITE_POSTHOG_KEY/);
  assert.doesNotMatch(r.stderr, /VITE_SUPABASE_URL/);
});

test("the script passes production with everything set, and skips everywhere else", () => {
  assert.equal(run({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "main", ...FULL }).status, 0);
  assert.equal(run({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "feat/x" }).status, 0);
  assert.equal(run({}).status, 0);
});
