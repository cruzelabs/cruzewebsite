// Supabase Edge Function: sends the Client Portal's email (invites, confirmations, signature requests,
// reminders, export links) through Resend, so the Resend key stays in this project's secrets.
//
// The portal calls it with the header x-portal-email-secret; there is no user JWT, so deploy with
// --no-verify-jwt. Rules live in handler.ts; tests in handler.test.ts.
//
// The portal's Idempotency-Key header (email-log-<id>) goes to Resend unchanged, which keeps a key for
// 24 hours, so a retry of a send that was cut off does not send a second email. The request to Resend is
// built in handler.ts (resendSender), where the tests can see it.
//
// Secrets (Edge Function Secrets):
//   - PORTAL_EMAIL_SECRET   shared with the portal (Vercel cruze-client CRUZE_EMAIL_FUNCTION_SECRET); unset = closed
//   - RESEND_API_KEY        already set for the website's email functions
//   - PORTAL_FROM_ADDRESS   optional; default Cruze <no-reply@cruzemaps.com>
//
// Deploy from the repo root:
//   supabase functions deploy send-portal-email --project-ref zodrljxcwqkjiipobrhs --no-verify-jwt --use-api

// @ts-nocheck: Deno runtime, not Node. The repo's tsconfig doesn't load this file.

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { timingSafeEqual } from "https://deno.land/std@0.192.0/crypto/timing_safe_equal.ts";
import { handle, resendSender } from "./handler.ts";

serve((req) =>
  handle(req, {
    env: (name) => Deno.env.get(name),

    secretMatches(provided, expected) {
      const enc = new TextEncoder();
      const a = enc.encode(provided);
      const b = enc.encode(expected);
      if (a.byteLength !== b.byteLength) return false;
      return timingSafeEqual(a, b);
    },

    sendEmail: resendSender(fetch),
  })
);
