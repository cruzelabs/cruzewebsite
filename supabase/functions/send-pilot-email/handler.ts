// Request handling for the send-pilot-email edge function, kept free of
// network and Supabase imports so it can be unit tested with `deno test` (see
// handler.test.ts). index.ts wires in the real database and Resend calls.
//
// Called by two database webhook triggers on pilot_applications with no auth
// header (migration 024), so it runs with verify_jwt off and anyone on the
// internet can POST to it. It therefore trusts only `type`, `table` and
// `record.id` from the payload. `old_record` and every other field are
// ignored: the row is read back by id with the service role and the email is
// built from that row alone.
//   - INSERT sends the confirmation, only for a row created in the last 10
//     minutes (and not dated in the future).
//   - UPDATE sends the email for the row's current status, only when the row
//     was reviewed in the last 10 minutes. pilot_applications has no
//     updated_at; the admin portal sets reviewed_at on every status change,
//     and only admins and the service role can update a row.
//   - Each application gets at most one email per status, ever. The key
//     pilot_applications:<id>:<status> goes into
//     public.pilot_email_notifications_sent (migration 024) before the email
//     is sent, so a replayed or forged payload sends nothing new. The
//     confirmation is the email for "pending".
//   - The recipient is the row's contact_email, else the applicant's profile
//     or sign-in email, looked up by the row's user_id.
//   - The status email carries fleet_visible_message as "Message from Cruze"
//     only when the row has a reviewed_by, which the admin portal sets when a
//     staff member saves the message. Applicants cannot write either column
//     (migration 025), so text an applicant typed is never sent as ours.
//   - An email names a signed LOI only when one is on file for the
//     application when the email is built: a loi_signatures row with this
//     pilot_application_id and the applicant's user_id. /apply inserts the
//     LOI in a second request after the pilot row (src/pages/Apply.tsx) and
//     takes the pilot row back if signing fails, and an applicant can insert a
//     pilot row with no LOI, so the insert webhook can get here before any
//     LOI exists. Without one the confirmation says "your application" and
//     nothing about an LOI. A failed lookup counts as no LOI.
//     Not closed here: the confirmation can go out for a pilot row that /apply
//     takes back a moment later because signing failed (the applicant is told
//     on screen to try again). That email names no LOI. One way to stop it:
//     the wizard writes both rows in one transaction, so the webhook, which
//     is sent after commit, only ever sees a signed application.

import { namesSignedLoi, renderPilotStatusEmail, renderPilotSubmittedEmail } from "./template.ts";

export const TABLE = "pilot_applications";

// Columns read back. Nothing else from the row is used.
export const COLUMNS =
  "id, user_id, company_name, contact_email, status, fleet_visible_message, created_at, reviewed_at, reviewed_by";

export const FRESH_MS = 10 * 60 * 1000;
// created_at comes from the database clock; reviewed_at from the admin's
// browser, so a clock a few minutes fast must still count.
export const CREATED_FUTURE_SKEW_MS = 60 * 1000;
export const REVIEWED_FUTURE_SKEW_MS = 10 * 60 * 1000;

export const DEFAULT_FROM = "Cruzemaps <hello@cruzemaps.com>";
export const DEFAULT_SITE = "https://cruzemaps.com";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

export type ClaimResult = "claimed" | "duplicate" | "error";

export interface Email {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  status: number;
  id?: string;
  text: string;
}

export interface Deps {
  env(name: string): string | undefined;
  now(): Date;
  // Re-read the pilot application by id with the service role. `error` is set
  // on a query failure; `row` is null when no row has that id.
  loadRow(id: string): Promise<{ row: Row | null; error?: string }>;
  // The applicant's email from profiles, then from auth.users. null when
  // neither has one.
  lookupEmail(userId: string): Promise<{ email: string | null; error?: string }>;
  // Record that `key` was emailed. "duplicate" when it already was.
  claim(key: string): Promise<ClaimResult>;
  // Whether loi_signatures has a row for this application signed by this
  // user. `error` is set on a query failure.
  hasSignedLoi(applicationId: string, userId: string): Promise<{ signed: boolean; error?: string }>;
  sendEmail(apiKey: string, email: Email): Promise<SendResult>;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // deno-lint-ignore no-explicit-any
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!payload || typeof payload !== "object") return json({ error: "Invalid payload" }, 400);

  const event = payload.type;
  if (event !== "INSERT" && event !== "UPDATE") return json({ skipped: "not an insert or update" });
  if (payload.table !== TABLE) return json({ skipped: "unknown table" });

  const id = payload.record?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return json({ error: "record.id must be a uuid" }, 400);
  }

  const apiKey = deps.env("RESEND_API_KEY");
  if (!apiKey) return json({ skipped: "RESEND_API_KEY not configured" });

  const { row, error } = await deps.loadRow(id);
  if (error) {
    console.error(`send-pilot-email: could not read ${TABLE} ${id}: ${error}`);
    return json({ error: "could not read the row" }, 500);
  }
  if (!row) return json({ skipped: "row not found" });

  const now = deps.now();
  let status: string;
  if (event === "INSERT") {
    if (!within(row.created_at, now, FRESH_MS, CREATED_FUTURE_SKEW_MS)) {
      return json({ skipped: "row is not new" });
    }
    status = "pending";
  } else {
    if (!within(row.reviewed_at, now, FRESH_MS, REVIEWED_FUTURE_SKEW_MS)) {
      return json({ skipped: "no recent status change" });
    }
    if (typeof row.status !== "string" || !row.status) return json({ skipped: "row has no status" });
    status = row.status;
  }

  const recipient = await recipientFor(row, deps);
  if (recipient.error) {
    console.error(`send-pilot-email: could not look up the email for ${TABLE} ${id}: ${recipient.error}`);
    return json({ error: "could not look up the recipient" }, 500);
  }
  if (!recipient.email) return json({ skipped: "no recipient email" });

  const claim = await deps.claim(ledgerKey(row.id, status));
  if (claim === "duplicate") return json({ skipped: "already emailed" });
  if (claim === "error") return json({ error: "could not record the email" }, 500);

  // Only for an email whose copy can name the LOI, and read as late as
  // possible: on INSERT the LOI row may be only moments away.
  const loiSigned = namesSignedLoi(status) && await signedLoiOnFile(row, deps);

  const site = deps.env("SITE_BASE_URL") || DEFAULT_SITE;
  const dashboardUrl = `${site}/fleet-dashboard`;
  const companyName = row.company_name || "your fleet";
  const mail = event === "INSERT"
    ? renderPilotSubmittedEmail({ email: recipient.email, companyName, dashboardUrl, loiSigned })
    : renderPilotStatusEmail({
      email: recipient.email,
      companyName,
      status,
      dashboardUrl,
      fleetMessage: staffMessage(row),
      loiSigned,
    });

  const res = await deps.sendEmail(apiKey, {
    from: deps.env("PILOT_FROM_ADDRESS") || DEFAULT_FROM,
    to: [recipient.email],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
  if (!res.ok) {
    console.error(`send-pilot-email: Resend ${res.status}: ${res.text.slice(0, 500)}`);
    return json({ error: `Resend ${res.status}` }, 500);
  }
  return json({ ok: true, id: res.id ?? null, event });
}

// The staff-written message for the fleet, or null when no staff member has
// reviewed the row.
export function staffMessage(row: Row): string | null {
  if (typeof row.reviewed_by !== "string" || !row.reviewed_by) return null;
  const message = typeof row.fleet_visible_message === "string" ? row.fleet_visible_message.trim() : "";
  return message || null;
}

// True only when the applicant's signed LOI for this application is on file
// right now. The email is already claimed when this runs, so a lookup that
// fails or throws must not stop it: it counts as no LOI, and the email then
// says only what is true of every application.
export async function signedLoiOnFile(row: Row, deps: Deps): Promise<boolean> {
  if (typeof row.id !== "string" || typeof row.user_id !== "string" || !row.user_id) return false;
  try {
    const found = await deps.hasSignedLoi(row.id, row.user_id);
    if (found.error) {
      console.error(`send-pilot-email: could not look up the LOI for ${TABLE} ${row.id}: ${found.error}`);
      return false;
    }
    return found.signed === true;
  } catch (err) {
    console.error(`send-pilot-email: LOI lookup for ${TABLE} ${row.id} threw: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

export function ledgerKey(id: string, status: string): string {
  return `${TABLE}:${id}:${status}`;
}

// True when `ts` is at most `pastMs` old and at most `futureMs` ahead of now.
export function within(ts: unknown, now: Date, pastMs: number, futureMs: number): boolean {
  if (typeof ts !== "string" || !ts) return false;
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return false;
  const age = now.getTime() - t;
  return age <= pastMs && age >= -futureMs;
}

async function recipientFor(row: Row, deps: Deps): Promise<{ email: string | null; error?: string }> {
  const contact = typeof row.contact_email === "string" ? row.contact_email.trim() : "";
  if (contact) return { email: contact };
  if (typeof row.user_id !== "string" || !row.user_id) return { email: null };
  const found = await deps.lookupEmail(row.user_id);
  if (found.error) return found;
  const email = typeof found.email === "string" ? found.email.trim() : "";
  return { email: email || null };
}

// The key the function reads rows with: a secret key (sb_secret_...) when one
// is available, else the legacy service_role key. Supabase injects the secret
// keys as SUPABASE_SECRET_KEYS, a JSON object keyed by name; SUPABASE_SECRET_KEY
// wins when it is set.
export function serviceKey(env: (name: string) => string | undefined): string | undefined {
  const single = env("SUPABASE_SECRET_KEY");
  if (single) return single;
  const all = env("SUPABASE_SECRET_KEYS");
  if (all) {
    try {
      const parsed = JSON.parse(all);
      if (parsed && typeof parsed.default === "string" && parsed.default) return parsed.default;
    } catch {
      // Not JSON: fall through to the legacy key.
    }
  }
  return env("SUPABASE_SERVICE_ROLE_KEY") || undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
