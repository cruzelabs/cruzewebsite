// Unit tests for send-pilot-email request handling. No network, no database:
// the handler gets fake dependencies. Run from the repo root:
//
//   deno test --no-lock supabase/functions/send-pilot-email/
//
// CI runs this in the "edge functions" job of .github/workflows/test.yml.

import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { type Deps, type Email, handle, ledgerKey, type Row, sameAddress, serviceKey } from "./handler.ts";
import { CLIENT_PORTAL_URL, renderPilotStatusEmail, renderPilotSubmittedEmail } from "./template.ts";

const NOW = new Date("2026-10-22T12:00:00Z");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const USER = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const STAFF = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const ENV: Record<string, string> = { RESEND_API_KEY: "re_test" };

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

// A pilot application as the database has it: submitted 1 minute ago, never
// reviewed.
const pilotRow = (over: Row = {}): Row => ({
  id: ID,
  user_id: USER,
  company_name: "Acme Freight",
  contact_email: "dana@acme.example",
  status: "pending",
  fleet_visible_message: null,
  created_at: minutesAgo(1),
  reviewed_at: null,
  ...over,
});

// The LOI /apply inserts after the pilot row: same application, same user.
const loiRow = (over: Row = {}): Row => ({ pilot_application_id: ID, user_id: USER, ...over });

type Fake = Deps & {
  rows: Map<string, Row>;
  // loi_signatures, as far as the function looks at it.
  lois: Row[];
  sent: Email[];
  ledger: Set<string>;
  loads: string[];
  lookups: string[];
  loiLookups: { applicationId: string; userId: string }[];
};

function fake(opts: {
  rows?: Row[];
  lois?: Row[];
  env?: Record<string, string>;
  profileEmail?: string | null;
  loadError?: string;
  lookupError?: string;
  lookupThrows?: boolean;
  claimError?: boolean;
  loiError?: string;
  loiThrows?: boolean;
  resendStatus?: number;
} = {}): Fake {
  const env = opts.env ?? ENV;
  const d: Fake = {
    rows: new Map((opts.rows ?? []).map((r) => [r.id, r])),
    lois: opts.lois ?? [],
    sent: [],
    ledger: new Set(),
    loads: [],
    lookups: [],
    loiLookups: [],
    env: (name) => env[name],
    now: () => NOW,
    loadRow(id) {
      d.loads.push(id);
      if (opts.loadError) return Promise.resolve({ row: null, error: opts.loadError });
      return Promise.resolve({ row: d.rows.get(id) ?? null });
    },
    lookupEmail(userId) {
      d.lookups.push(userId);
      if (opts.lookupThrows) return Promise.reject(new Error("connection reset"));
      if (opts.lookupError) return Promise.resolve({ email: null, error: opts.lookupError });
      return Promise.resolve({ email: opts.profileEmail ?? null });
    },
    claim(key) {
      if (opts.claimError) return Promise.resolve("error");
      if (d.ledger.has(key)) return Promise.resolve("duplicate");
      d.ledger.add(key);
      return Promise.resolve("claimed");
    },
    hasSignedLoi(applicationId, userId) {
      d.loiLookups.push({ applicationId, userId });
      if (opts.loiThrows) return Promise.reject(new Error("connection reset"));
      // The query index.ts runs: this application, signed by this user.
      const signed = d.lois.some((l) => l.pilot_application_id === applicationId && l.user_id === userId);
      // An answer that comes with an error is not to be believed.
      if (opts.loiError) return Promise.resolve({ signed, error: opts.loiError });
      return Promise.resolve({ signed });
    },
    sendEmail(_apiKey, email) {
      const status = opts.resendStatus ?? 200;
      if (status >= 300) return Promise.resolve({ ok: false, status, text: "upstream said no" });
      d.sent.push(email);
      return Promise.resolve({ ok: true, status, id: `email-${d.sent.length}`, text: "" });
    },
  };
  return d;
}

function post(body: unknown): Request {
  return new Request("https://fn.invalid/send-pilot-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function call(d: Fake, payload: unknown) {
  const res = await handle(post(payload), d);
  return { status: res.status, body: await res.json() };
}

// What the database webhook sends: the whole row, and old_record on UPDATE.
const insertPayload = (record: Row = { id: ID }) => ({
  type: "INSERT",
  table: "pilot_applications",
  schema: "public",
  record,
  old_record: null,
});
const updatePayload = (record: Row = { id: ID }, old_record: Row | null = { id: ID }) => ({
  type: "UPDATE",
  table: "pilot_applications",
  schema: "public",
  record,
  old_record,
});

// The admin portal changes the status and sets reviewed_at to now.
function review(d: Fake, status: string, minutes = 0) {
  d.rows.set(ID, { ...d.rows.get(ID), status, reviewed_at: minutesAgo(minutes) });
}

Deno.test("rejects non-POST and bad JSON", async () => {
  const d = fake({ rows: [pilotRow()] });
  const res = await handle(new Request("https://fn.invalid/x", { method: "GET" }), d);
  assertEquals(res.status, 405);
  assertEquals((await call(d, "{not json")).status, 400);
  assertEquals((await call(d, "null")).status, 400);
  assertEquals(d.sent.length, 0);
});

Deno.test("only INSERT and UPDATE on pilot_applications, with a uuid id", async () => {
  const d = fake({ rows: [pilotRow()] });
  assertEquals((await call(d, { ...insertPayload(), type: "DELETE" })).body, { skipped: "not an insert or update" });
  assertEquals((await call(d, { ...insertPayload(), table: "profiles" })).body, { skipped: "unknown table" });
  assertEquals((await call(d, insertPayload({ id: "x' or 1=1" }))).status, 400);
  assertEquals((await call(d, insertPayload({}))).status, 400);
  assertEquals((await call(d, { type: "INSERT", table: "pilot_applications" })).status, 400);
  assertEquals(d.sent.length, 0);
  assertEquals(d.loads.length, 0);
});

Deno.test("a genuine insert sends the confirmation once, built from the database row", async () => {
  const d = fake({ rows: [pilotRow()] });
  const { status, body } = await call(d, insertPayload(pilotRow()));
  assertEquals(status, 200);
  assertEquals(body, { ok: true, id: "email-1", event: "INSERT" });
  assertEquals(d.loads, [ID]);
  assertEquals(d.sent.length, 1);
  const mail = d.sent[0];
  assertEquals(mail.to, ["dana@acme.example"]);
  assertEquals(mail.from, "Cruzemaps <hello@cruzemaps.com>");
  assertEquals(mail.subject, "We received your Cruze pilot application");
  assert(mail.html.includes("(Acme Freight)"));
  assert(mail.html.includes("https://cruzemaps.com/fleet-dashboard"));
  assert(mail.text.includes("View fleet dashboard: https://cruzemaps.com/fleet-dashboard"));
  assertEquals([...d.ledger], [ledgerKey(ID, "pending")]);
});

Deno.test("a replayed insert sends nothing", async () => {
  const d = fake({ rows: [pilotRow()] });
  assertEquals((await call(d, insertPayload())).body.ok, true);
  assertEquals((await call(d, insertPayload())).body, { skipped: "already emailed" });
  assertEquals((await call(d, insertPayload(pilotRow()))).body, { skipped: "already emailed" });
  assertEquals(d.sent.length, 1);
});

Deno.test("spoofed payload fields cannot change who gets an email or what it says", async () => {
  const d = fake({ rows: [pilotRow()] });
  const forged = {
    id: ID,
    contact_email: "victim@evil.example",
    user_id: "00000000-0000-0000-0000-000000000000",
    company_name: "Reset your password at https://evil.example",
    status: "approved",
    fleet_visible_message: "Pay the deposit at https://evil.example",
    created_at: NOW.toISOString(),
    reviewed_at: NOW.toISOString(),
  };
  await call(d, insertPayload(forged));
  assertEquals(d.sent.length, 1);
  const mail = d.sent[0];
  assertEquals(mail.to, ["dana@acme.example"]);
  assertEquals(mail.subject, "We received your Cruze pilot application");
  assert(!JSON.stringify(mail).includes("evil.example"));
  assertEquals(d.lookups.length, 0);

  // An UPDATE with a forged record and old_record: the stored row has not
  // been reviewed, so there is nothing to send.
  const res = await call(d, updatePayload(forged, { ...forged, status: "pending" }));
  assertEquals(res.body, { skipped: "no recent status change" });
  assertEquals(d.sent.length, 1);

  // After a genuine review, the email follows the stored status and message,
  // not the payload's.
  d.rows.set(ID, { ...d.rows.get(ID), status: "in_review", fleet_visible_message: "We will call you Tuesday.", reviewed_at: minutesAgo(0), reviewed_by: STAFF });
  await call(d, updatePayload(forged, { ...forged, status: "denied" }));
  assertEquals(d.sent.length, 2);
  const status = d.sent[1];
  assertEquals(status.to, ["dana@acme.example"]);
  assertEquals(status.subject, "Your Cruze pilot application is under review");
  assert(status.html.includes("We will call you Tuesday."));
  assert(!JSON.stringify(status).includes("evil.example"));
});

Deno.test("a message no staff member saved is never sent as Message from Cruze", async () => {
  // The applicant typed fleet_visible_message at apply time (possible before
  // migration 025); a bulk status change sets reviewed_at but not reviewed_by.
  const d = fake({ rows: [pilotRow({ fleet_visible_message: "Wire the deposit to https://evil.example" })] });
  review(d, "approved");
  assertEquals((await call(d, updatePayload())).body.ok, true);
  assertEquals(d.sent.length, 1);
  assert(!JSON.stringify(d.sent[0]).includes("evil.example"));
  assert(!d.sent[0].html.includes("Message from Cruze"));
  assert(!d.sent[0].text.includes("Message from Cruze"));

  // Once a staff member saves the row, its message goes out.
  d.rows.set(ID, { ...d.rows.get(ID), status: "onboarding", fleet_visible_message: "Kickoff on Monday.", reviewed_at: minutesAgo(0), reviewed_by: STAFF });
  assertEquals((await call(d, updatePayload())).body.ok, true);
  assert(d.sent[1].html.includes("Message from Cruze"));
  assert(d.sent[1].text.includes("Message from Cruze:\nKickoff on Monday."));
  assert(d.sent[1].html.includes("Kickoff on Monday."));
});

Deno.test("an id with no row sends nothing", async () => {
  const d = fake({ rows: [] });
  assertEquals((await call(d, insertPayload())).body, { skipped: "row not found" });
  assertEquals((await call(d, updatePayload())).body, { skipped: "row not found" });
  assertEquals(d.sent.length, 0);
  assertEquals(d.ledger.size, 0);
});

Deno.test("an old or future-dated row gets no confirmation", async () => {
  for (const created_at of [minutesAgo(11), minutesAgo(60 * 24 * 30), minutesAgo(-5), null, "not a date"]) {
    const d = fake({ rows: [pilotRow({ created_at })] });
    assertEquals((await call(d, insertPayload())).body, { skipped: "row is not new" }, String(created_at));
    assertEquals(d.sent.length, 0);
    assertEquals(d.ledger.size, 0);
  }
  const edge = fake({ rows: [pilotRow({ created_at: minutesAgo(10) })] });
  assertEquals((await call(edge, insertPayload())).body.ok, true);
});

Deno.test("a status change sends once per status", async () => {
  const d = fake({ rows: [pilotRow()] });
  await call(d, insertPayload());

  review(d, "approved");
  assertEquals((await call(d, updatePayload())).body, { ok: true, id: "email-2", event: "UPDATE" });
  assertEquals(d.sent[1].subject, "Your Cruze pilot application was approved");
  // The webhook fires again for the same change, or the payload is replayed.
  assertEquals((await call(d, updatePayload())).body, { skipped: "already emailed" });

  // An edit that keeps the status (notes, message) sends nothing.
  d.rows.set(ID, { ...d.rows.get(ID), fleet_visible_message: "New note", reviewed_at: minutesAgo(0) });
  assertEquals((await call(d, updatePayload())).body, { skipped: "already emailed" });

  review(d, "active");
  assertEquals((await call(d, updatePayload())).body.ok, true);
  assertEquals(d.sent[2].subject, "Your Cruze pilot is now active");

  // Back to a status that was already emailed: nothing new.
  review(d, "approved");
  assertEquals((await call(d, updatePayload())).body, { skipped: "already emailed" });
  // Pending was emailed as the confirmation.
  review(d, "pending");
  assertEquals((await call(d, updatePayload())).body, { skipped: "already emailed" });

  assertEquals(d.sent.length, 3);
  assertEquals([...d.ledger].sort(), [ledgerKey(ID, "active"), ledgerKey(ID, "approved"), ledgerKey(ID, "pending")]);
});

Deno.test("an update is only emailed when the row was reviewed in the last 10 minutes", async () => {
  for (const reviewed_at of [null, minutesAgo(11), minutesAgo(60 * 24), minutesAgo(-11), "not a date"]) {
    const d = fake({ rows: [pilotRow({ status: "approved", created_at: minutesAgo(60 * 24 * 30), reviewed_at })] });
    assertEquals((await call(d, updatePayload())).body, { skipped: "no recent status change" }, String(reviewed_at));
    assertEquals(d.sent.length, 0);
    assertEquals(d.ledger.size, 0);
  }
  // The admin's browser sets reviewed_at, so a clock a few minutes fast counts.
  for (const reviewed_at of [minutesAgo(10), minutesAgo(-5)]) {
    const d = fake({ rows: [pilotRow({ status: "approved", reviewed_at })] });
    assertEquals((await call(d, updatePayload())).body.ok, true, String(reviewed_at));
  }
});

Deno.test("a forged UPDATE right after an insert sends nothing new", async () => {
  const d = fake({ rows: [pilotRow({ reviewed_at: minutesAgo(0) })] });
  await call(d, insertPayload());
  assertEquals((await call(d, updatePayload({ id: ID, status: "approved" }, { id: ID, status: "pending" }))).body, {
    skipped: "already emailed",
  });
  assertEquals(d.sent.length, 1);
});

Deno.test("recipient: contact_email, else the applicant's account email, else nothing", async () => {
  const a = fake({ rows: [pilotRow({ contact_email: "  dana@acme.example  " })] });
  await call(a, insertPayload());
  assertEquals(a.sent[0].to, ["dana@acme.example"]);
  assertEquals(a.lookups.length, 0);

  const b = fake({ rows: [pilotRow({ contact_email: " " })], profileEmail: "owner@acme.example" });
  await call(b, insertPayload());
  assertEquals(b.lookups, [USER]);
  assertEquals(b.sent[0].to, ["owner@acme.example"]);

  const c = fake({ rows: [pilotRow({ contact_email: null })], profileEmail: null });
  assertEquals((await call(c, insertPayload())).body, { skipped: "no recipient email" });
  assertEquals(c.sent.length, 0);
  assertEquals(c.ledger.size, 0);
});

Deno.test("fails closed when the database cannot be read or the email cannot be recorded", async () => {
  const a = fake({ loadError: "boom" });
  assertEquals((await call(a, insertPayload())).status, 500);
  const b = fake({ rows: [pilotRow()], claimError: true });
  assertEquals((await call(b, insertPayload())).status, 500);
  const c = fake({ rows: [pilotRow({ contact_email: null })], lookupError: "boom" });
  assertEquals((await call(c, insertPayload())).status, 500);
  assertEquals(a.sent.length + b.sent.length + c.sent.length, 0);
  assertEquals(c.ledger.size, 0);
});

Deno.test("no RESEND_API_KEY is a 200 skip before any database read", async () => {
  const d = fake({ env: {}, rows: [pilotRow()] });
  const { status, body } = await call(d, insertPayload());
  assertEquals(status, 200);
  assertEquals(body, { skipped: "RESEND_API_KEY not configured" });
  assertEquals(d.loads.length, 0);
});

Deno.test("Resend failure is a 500 that does not echo Resend's reply", async () => {
  const d = fake({ rows: [pilotRow()], resendStatus: 422 });
  const { status, body } = await call(d, insertPayload());
  assertEquals(status, 500);
  assertEquals(body, { error: "Resend 422" });
});

Deno.test("PILOT_FROM_ADDRESS and SITE_BASE_URL still apply", async () => {
  const d = fake({
    rows: [pilotRow()],
    env: { ...ENV, PILOT_FROM_ADDRESS: "Pilots <pilots@cruzemaps.com>", SITE_BASE_URL: "https://staging.cruzemaps.com" },
  });
  await call(d, insertPayload());
  assertEquals(d.sent[0].from, "Pilots <pilots@cruzemaps.com>");
  assert(d.sent[0].text.includes("https://staging.cruzemaps.com/fleet-dashboard"));
});

Deno.test("serviceKey prefers a secret key over the legacy service_role key", () => {
  const env = (vars: Record<string, string>) => (name: string) => vars[name];
  assertEquals(serviceKey(env({ SUPABASE_SECRET_KEY: "a", SUPABASE_SECRET_KEYS: '{"default":"b"}', SUPABASE_SERVICE_ROLE_KEY: "c" })), "a");
  assertEquals(serviceKey(env({ SUPABASE_SECRET_KEYS: '{"default":"b"}', SUPABASE_SERVICE_ROLE_KEY: "c" })), "b");
  assertEquals(serviceKey(env({ SUPABASE_SECRET_KEYS: "not json", SUPABASE_SERVICE_ROLE_KEY: "c" })), "c");
  assertEquals(serviceKey(env({ SUPABASE_SECRET_KEYS: '{"other":"b"}', SUPABASE_SERVICE_ROLE_KEY: "c" })), "c");
  assertEquals(serviceKey(env({ SUPABASE_SERVICE_ROLE_KEY: "c" })), "c");
  assertEquals(serviceKey(env({})), undefined);
});

// The approval email's sign-in line when it goes to the email of the account
// that applied, and when it does not (or that cannot be told).
const ACCOUNT_LINE = "where you will sign in with the account you used to apply.";
const OTHER_LINE =
  "where you will sign in with the account that applied for the pilot. If that account is not yours, ask the person who applied to invite you.";
const APPROVED_TO_ACCOUNT =
  `Welcome aboard. Next, our team sets up your fleet's portal at ${CLIENT_PORTAL_URL}, ${ACCOUNT_LINE} Check your fleet dashboard for kickoff details and next steps from our team.`;
const APPROVED_TO_OTHER =
  `Welcome aboard. Next, our team sets up your fleet's portal at ${CLIENT_PORTAL_URL}, ${OTHER_LINE} Check your fleet dashboard for kickoff details and next steps from our team.`;
// The status copy in the plain-text email: the line after the headline.
const bodyText = (mail: { text: string }) => mail.text.split("\n")[2];

Deno.test("the approval email to the account that applied says where to sign in, as a link and in plain text", async () => {
  // The Work email on /apply starts as the account's email.
  const d = fake({ rows: [pilotRow()], profileEmail: "dana@acme.example" });
  await call(d, insertPayload());
  review(d, "approved");
  assertEquals((await call(d, updatePayload())).body.ok, true);
  const mail = d.sent[1];
  assertEquals(mail.to, ["dana@acme.example"]);
  assertEquals(d.lookups, [USER]);
  assertEquals(CLIENT_PORTAL_URL, "https://client.cruzemaps.com");
  assert(mail.html.includes(`sets up your fleet's portal at <a href="${CLIENT_PORTAL_URL}"`));
  assert(mail.html.includes("where you will sign in with the account you used to apply"));
  // Word for word what every approval email said before.
  assertEquals(bodyText(mail), APPROVED_TO_ACCOUNT);
  assert(!mail.html.includes(OTHER_LINE));
  assert(!mail.text.includes("<a"));
  // The fleet dashboard button stays.
  assert(mail.html.includes('href="https://cruzemaps.com/fleet-dashboard"'));
  // The confirmation sent at apply time does not point at the portal yet.
  assert(!JSON.stringify(d.sent[0]).includes("client.cruzemaps.com"));
});

Deno.test("an approval email to a Work email that is not the account's says to sign in with the account that applied or ask for an invite, and names no address", async () => {
  // owner@acme.example applied and typed ops@acme.example as the Work email.
  const d = fake({ rows: [pilotRow({ contact_email: "ops@acme.example" })], profileEmail: "owner@acme.example" });
  await call(d, insertPayload());
  review(d, "approved");
  // The payload cannot make the recipient the account's email.
  assertEquals((await call(d, updatePayload({ id: ID, contact_email: "owner@acme.example" }))).body.ok, true);
  const mail = d.sent[1];
  assertEquals(mail.to, ["ops@acme.example"]);
  assertEquals(mail.subject, "Your Cruze pilot application was approved");
  assertEquals(d.lookups, [USER]);
  assertEquals(bodyText(mail), APPROVED_TO_OTHER);
  assert(mail.html.includes(`sets up your fleet's portal at <a href="${CLIENT_PORTAL_URL}"`));
  assert(mail.html.includes(OTHER_LINE));
  assert(!mail.html.includes("you used to apply"));
  assert(!mail.text.includes("you used to apply"));
  // The account's email is not on the application row, so it is not printed.
  assert(!JSON.stringify(mail).includes("owner@acme.example"));
  assert(!bodyText(mail).includes("@"));
});

Deno.test("without the account's email to compare, the approval email falls back to wording that names no address", async () => {
  const cases: [string, Parameters<typeof fake>[0], number][] = [
    ["no account email", { profileEmail: null }, 1],
    ["a blank account email", { profileEmail: "   " }, 1],
    ["a failed lookup", { lookupError: "permission denied" }, 1],
    ["a lookup that throws", { lookupThrows: true }, 1],
    // No applicant account on the row: nothing to look up.
    ["no user_id", { rows: [pilotRow({ user_id: null })], profileEmail: "dana@acme.example" }, 0],
  ];
  for (const [name, opts, reads] of cases) {
    const d = fake({ rows: [pilotRow()], ...opts });
    review(d, "approved");
    const { status, body } = await call(d, updatePayload());
    assertEquals(status, 200, name);
    assertEquals(body, { ok: true, id: "email-1", event: "UPDATE" }, name);
    assertEquals(d.lookups.length, reads, name);
    const mail = d.sent[0];
    assertEquals(mail.to, ["dana@acme.example"], name);
    assertEquals(bodyText(mail), APPROVED_TO_OTHER, name);
    assert(mail.html.includes(OTHER_LINE), name);
    assert(!mail.html.includes("you used to apply"), name);
    assert(!bodyText(mail).includes("@"), name);
    assertEquals([...d.ledger], [ledgerKey(ID, "approved")], name);
  }
});

Deno.test("the Work email is the account's email whatever its case or surrounding spaces", async () => {
  const d = fake({ rows: [pilotRow({ contact_email: "  Dana@ACME.example " })], profileEmail: " dana@acme.example" });
  review(d, "approved");
  assertEquals((await call(d, updatePayload())).body.ok, true);
  assertEquals(d.sent[0].to, ["Dana@ACME.example"]);
  assertEquals(bodyText(d.sent[0]), APPROVED_TO_ACCOUNT);
});

Deno.test("sameAddress ignores case and surrounding spaces, and a blank address matches nothing", () => {
  assert(sameAddress("Dana@Acme.example", " dana@acme.EXAMPLE "));
  assert(!sameAddress("dana@acme.example", "ops@acme.example"));
  assert(!sameAddress("dana+pilot@acme.example", "dana@acme.example"));
  for (const blank of ["", "  ", null, undefined, 42]) {
    assert(!sameAddress(blank, blank), String(blank));
    assert(!sameAddress(blank, "dana@acme.example"), String(blank));
    assert(!sameAddress("dana@acme.example", blank), String(blank));
  }
});

Deno.test("with no Work email the approval email goes to the account's email and says so, with one lookup", async () => {
  const d = fake({ rows: [pilotRow({ contact_email: null })], profileEmail: "owner@acme.example" });
  review(d, "approved");
  assertEquals((await call(d, updatePayload())).body.ok, true);
  assertEquals(d.sent[0].to, ["owner@acme.example"]);
  assertEquals(bodyText(d.sent[0]), APPROVED_TO_ACCOUNT);
  // The recipient already is the account's email: nothing more to read.
  assertEquals(d.lookups, [USER]);
});

Deno.test("the account's email is read only for an approval email that is due", async () => {
  const d = fake({ rows: [pilotRow()], profileEmail: "dana@acme.example" });
  await call(d, insertPayload());
  for (const status of ["in_review", "onboarding", "active", "denied", "archived"]) {
    review(d, status);
    assertEquals((await call(d, updatePayload())).body.ok, true, status);
  }
  assertEquals(d.lookups.length, 0);
  // A review older than 10 minutes sends nothing and reads nothing.
  review(d, "approved", 11);
  assertEquals((await call(d, updatePayload())).body, { skipped: "no recent status change" });
  assertEquals(d.lookups.length, 0);
  review(d, "approved");
  assertEquals((await call(d, updatePayload())).body.ok, true);
  assertEquals(d.lookups, [USER]);
  // A replay reads again, since the read comes before the claim, and sends nothing.
  assertEquals((await call(d, updatePayload())).body, { skipped: "already emailed" });
  assertEquals(d.lookups, [USER, USER]);
  assertEquals(d.sent.length, 7);
});

Deno.test("the account's email is read before the email is recorded, so a read that hangs records nothing", async () => {
  const d = fake({ rows: [pilotRow()] });
  review(d, "approved");
  let release: (found: { email: string | null }) => void = () => {};
  d.lookupEmail = (userId) => {
    d.lookups.push(userId);
    return new Promise((resolve) => (release = resolve));
  };
  const pending = call(d, updatePayload());
  for (let i = 0; i < 50 && d.lookups.length === 0; i++) await new Promise((r) => setTimeout(r, 0));
  assertEquals(d.lookups, [USER]);
  // Were the function to die here, nothing is recorded, so a later webhook can still send.
  assertEquals(d.ledger.size, 0);
  assertEquals(d.sent.length, 0);
  release({ email: "dana@acme.example" });
  assertEquals((await pending).body.ok, true);
  assertEquals([...d.ledger], [ledgerKey(ID, "approved")]);
  assertEquals(bodyText(d.sent[0]), APPROVED_TO_ACCOUNT);
});

Deno.test("no email says the reader applied unless the caller says it goes to the account's email", () => {
  const vars = { email: "ops@acme.example", companyName: "Acme Freight", dashboardUrl: "https://cruzemaps.com/fleet-dashboard" };
  const statuses = ["pending", "in_review", "approved", "onboarding", "active", "denied", "archived", "something_new"];
  // toAccountEmail left out (a caller from before the field), false, or not a boolean.
  for (const toAccountEmail of [undefined, false, null, "yes", 1] as unknown as (boolean | undefined)[]) {
    for (const status of statuses) {
      const mail = renderPilotStatusEmail({ ...vars, status, toAccountEmail });
      assert(!mail.html.includes("you used to apply"), `${status} ${toAccountEmail}`);
      assert(!mail.text.includes("you used to apply"), `${status} ${toAccountEmail}`);
    }
    assertEquals(bodyText(renderPilotStatusEmail({ ...vars, status: "approved", toAccountEmail })), APPROVED_TO_OTHER);
  }
  // Set, it changes the approval email's sign-in line and nothing else.
  for (const status of statuses) {
    const plain = renderPilotStatusEmail({ ...vars, status });
    const toAccount = renderPilotStatusEmail({ ...vars, status, toAccountEmail: true });
    if (status !== "approved") assertEquals(toAccount, plain, status);
  }
  const approved = renderPilotStatusEmail({ ...vars, status: "approved", toAccountEmail: true });
  assertEquals(bodyText(approved), APPROVED_TO_ACCOUNT);
  assert(approved.html.includes(`<a href="${CLIENT_PORTAL_URL}"`));
  // The approval copy names no LOI, whoever it goes to.
  for (const toAccountEmail of [true, false]) {
    assert(!namesLoi(renderPilotStatusEmail({ ...vars, status: "approved", toAccountEmail, loiSigned: true })));
  }
});

Deno.test("only the approval email points at the Client Portal", () => {
  const vars = { email: "dana@acme.example", companyName: "Acme Freight", dashboardUrl: "https://cruzemaps.com/fleet-dashboard" };
  for (const status of ["in_review", "onboarding", "active", "denied", "archived", "something_new"]) {
    const mail = renderPilotStatusEmail({ ...vars, status });
    assert(!mail.html.includes("client.cruzemaps.com"), status);
    assert(!mail.text.includes("client.cruzemaps.com"), status);
  }
  const approved = renderPilotStatusEmail({ ...vars, status: "approved" });
  assertEquals(approved.subject, "Your Cruze pilot application was approved");
  assert(approved.text.includes(CLIENT_PORTAL_URL));
});

const NO_LOI_LINE = "Our team will review your application within two business days.";
const LOI_LINE = "Our team will review your application and signed LOI within two business days.";
const namesLoi = (mail: { html: string; text: string }) => /LOI/i.test(mail.html) || /LOI/i.test(mail.text);

Deno.test("the confirmation names the signed LOI when one is on file for the application", async () => {
  const d = fake({ rows: [pilotRow()], lois: [loiRow()] });
  assertEquals((await call(d, insertPayload())).body, { ok: true, id: "email-1", event: "INSERT" });
  // Looked up for the stored row's application and applicant, once, after the claim.
  assertEquals(d.loiLookups, [{ applicationId: ID, userId: USER }]);
  const mail = d.sent[0];
  assertEquals(mail.subject, "We received your Cruze pilot application");
  assert(mail.html.includes(`${LOI_LINE} You can track status anytime on your fleet dashboard. (Acme Freight)`));
  assert(mail.text.includes(`${LOI_LINE} You can track status anytime on your fleet dashboard. (Acme Freight)`));
  assert(!mail.text.includes(NO_LOI_LINE));
});

Deno.test("with no LOI on file the confirmation says your application and nothing about an LOI", async () => {
  // /apply inserts the LOI in a second request, so the insert webhook can run
  // first; and an applicant can insert a pilot row with no LOI at all.
  const d = fake({ rows: [pilotRow()] });
  assertEquals((await call(d, insertPayload())).body, { ok: true, id: "email-1", event: "INSERT" });
  assertEquals(d.loiLookups, [{ applicationId: ID, userId: USER }]);
  const mail = d.sent[0];
  assertEquals(mail.subject, "We received your Cruze pilot application");
  assert(mail.html.includes("Application received"));
  assert(mail.html.includes(`Thanks for applying. ${NO_LOI_LINE} You can track status anytime on your fleet dashboard. (Acme Freight)`));
  assert(mail.text.includes(`Thanks for applying. ${NO_LOI_LINE} You can track status anytime on your fleet dashboard. (Acme Freight)`));
  assert(!namesLoi(mail), mail.text);

  // The LOI lands a moment later. The confirmation went out once and is not
  // sent again, so what it said stays true.
  d.lois.push(loiRow());
  assertEquals((await call(d, insertPayload())).body, { skipped: "already emailed" });
  assertEquals(d.sent.length, 1);
  assertEquals(d.loiLookups.length, 1);
});

Deno.test("an LOI for another application, or signed by another account, is not this applicant's signed LOI", async () => {
  const other = "9c5b94b1-35ad-49bb-b118-8e8fc24abf80";
  for (const lois of [[loiRow({ pilot_application_id: other })], [loiRow({ user_id: STAFF })], [loiRow({ pilot_application_id: null })]]) {
    const d = fake({ rows: [pilotRow()], lois });
    assertEquals((await call(d, insertPayload())).body.ok, true);
    assert(!namesLoi(d.sent[0]), JSON.stringify(lois));
  }
});

Deno.test("a failed LOI lookup still sends the confirmation, without the LOI line", async () => {
  for (const opts of [{ loiError: "permission denied" }, { loiThrows: true }]) {
    const d = fake({ rows: [pilotRow()], lois: [loiRow()], ...opts });
    const { status, body } = await call(d, insertPayload());
    assertEquals(status, 200, JSON.stringify(opts));
    assertEquals(body, { ok: true, id: "email-1", event: "INSERT" });
    assertEquals(d.sent.length, 1);
    assert(d.sent[0].text.includes(NO_LOI_LINE));
    assert(!namesLoi(d.sent[0]));
    assertEquals([...d.ledger], [ledgerKey(ID, "pending")]);
  }
  // A row with no applicant account cannot have a signed LOI: nothing is looked up.
  const d = fake({ rows: [pilotRow({ user_id: null })], lois: [loiRow()] });
  assertEquals((await call(d, insertPayload())).body.ok, true);
  assertEquals(d.loiLookups.length, 0);
  assert(!namesLoi(d.sent[0]));
});

Deno.test("no LOI is looked up for an email that is not sent, or whose copy never names one", async () => {
  const stale = fake({ rows: [pilotRow({ created_at: minutesAgo(11) })], lois: [loiRow()] });
  await call(stale, insertPayload());
  const noRecipient = fake({ rows: [pilotRow({ contact_email: null })], lois: [loiRow()], profileEmail: null });
  await call(noRecipient, insertPayload());
  const replay = fake({ rows: [pilotRow()], lois: [loiRow()] });
  await call(replay, insertPayload());
  await call(replay, insertPayload());
  assertEquals([stale.loiLookups.length, noRecipient.loiLookups.length, replay.loiLookups.length], [0, 0, 1]);

  // Status emails: only "active" has copy about the LOI.
  for (const status of ["in_review", "approved", "onboarding", "denied", "archived"]) {
    review(replay, status);
    assertEquals((await call(replay, updatePayload())).body.ok, true, status);
    assert(!namesLoi(replay.sent[replay.sent.length - 1]), status);
  }
  assertEquals(replay.loiLookups.length, 1);
  review(replay, "active");
  assertEquals((await call(replay, updatePayload())).body.ok, true);
  assertEquals(replay.loiLookups.length, 2);
});

Deno.test("the active email points at the signed LOI only when one is on file", async () => {
  const withLoi = fake({ rows: [pilotRow()], lois: [loiRow()] });
  const without = fake({ rows: [pilotRow()] });
  // An LOI row under the reviewing staff member's account is not the applicant's.
  const staffOnly = fake({ rows: [pilotRow()], lois: [loiRow({ user_id: STAFF })] });
  for (const d of [withLoi, without, staffOnly]) {
    await call(d, insertPayload());
    // A reviewed row names two accounts: the applicant and the staff member.
    review(d, "active");
    d.rows.set(ID, { ...d.rows.get(ID), reviewed_by: STAFF });
    assertEquals((await call(d, updatePayload())).body.ok, true);
    assertEquals(d.sent[1].subject, "Your Cruze pilot is now active");
    // The LOI is looked up for the applicant, both times.
    assertEquals(d.loiLookups, [{ applicationId: ID, userId: USER }, { applicationId: ID, userId: USER }]);
  }
  assert(withLoi.sent[1].text.includes("Open your fleet dashboard to view pilot status and your signed LOI."));
  for (const d of [without, staffOnly]) {
    assert(d.sent[1].text.includes("Open your fleet dashboard to view pilot status.\n"));
    assert(d.sent[1].html.includes("Open your fleet dashboard to view pilot status.</p>"));
    assert(!namesLoi(d.sent[1]));
    assert(!namesLoi(d.sent[0]));
  }
});

Deno.test("no email names an LOI unless the caller says one is signed", () => {
  const vars = { email: "dana@acme.example", companyName: "Acme <Freight>", dashboardUrl: "https://cruzemaps.com/fleet-dashboard" };
  const statuses = ["pending", "in_review", "approved", "onboarding", "active", "denied", "archived", "something_new"];
  // loiSigned left out (a caller from before the field), false, or not a boolean.
  for (const loiSigned of [undefined, false, null, "yes", 1] as unknown as (boolean | undefined)[]) {
    assert(!namesLoi(renderPilotSubmittedEmail({ ...vars, loiSigned })), String(loiSigned));
    for (const status of statuses) {
      assert(!namesLoi(renderPilotStatusEmail({ ...vars, status, loiSigned })), `${status} ${loiSigned}`);
    }
  }
  // With a signed LOI, the two emails whose copy is about it name it.
  assert(renderPilotSubmittedEmail({ ...vars, loiSigned: true }).text.includes(LOI_LINE));
  const named = statuses.filter((status) => namesLoi(renderPilotStatusEmail({ ...vars, status, loiSigned: true })));
  assertEquals(named, ["pending", "active"]);

  const mail = renderPilotSubmittedEmail(vars);
  assert(mail.text.includes(NO_LOI_LINE));
  assert(mail.html.includes("(Acme &lt;Freight&gt;)"));
  // No download link unless the caller passes one.
  assert(!mail.html.includes("Download your signed LOI"));
});

Deno.test("a staff message is in the HTML and in the plain text of the status email", async () => {
  const d = fake({ rows: [pilotRow()] });
  await call(d, insertPayload());
  const message = "Kickoff is Monday at 9am CT.\nBring your <ELD> login & dispatcher.";
  d.rows.set(ID, { ...d.rows.get(ID), status: "onboarding", fleet_visible_message: message, reviewed_at: minutesAgo(0), reviewed_by: STAFF });
  assertEquals((await call(d, updatePayload())).body.ok, true);
  const mail = d.sent[1];
  assert(mail.html.includes("Message from Cruze"));
  assert(mail.html.includes("Kickoff is Monday at 9am CT.\nBring your &lt;ELD&gt; login &amp; dispatcher."));
  // Plain text: the same heading, then the message as staff typed it, between
  // the status copy and the dashboard link.
  const lines: string[] = mail.text.split("\n");
  const at = lines.indexOf("Message from Cruze:");
  assert(at > 0, mail.text);
  assertEquals(lines.slice(at, at + 4), ["Message from Cruze:", "Kickoff is Monday at 9am CT.", "Bring your <ELD> login & dispatcher.", ""]);
  assert(at > lines.indexOf("Onboarding in progress"));
  assert(at < lines.findIndex((l) => l.startsWith("Open fleet dashboard: ")));
});

Deno.test("no staff message means no Message from Cruze in either format", () => {
  const vars = { email: "dana@acme.example", companyName: "Acme Freight", dashboardUrl: "https://cruzemaps.com/fleet-dashboard" };
  for (const fleetMessage of [undefined, null, ""]) {
    const mail = renderPilotStatusEmail({ ...vars, status: "in_review", fleetMessage });
    assert(!mail.html.includes("Message from Cruze"));
    assert(!mail.text.includes("Message from Cruze"));
  }
  const withMessage = renderPilotStatusEmail({ ...vars, status: "in_review", fleetMessage: "We will call you Tuesday." });
  assert(withMessage.html.includes("We will call you Tuesday."));
  assert(withMessage.text.includes("Message from Cruze:\nWe will call you Tuesday.\n"));
});

Deno.test("the LOI download link, when given, is in the plain text as well", () => {
  const vars = { email: "dana@acme.example", companyName: "Acme Freight", dashboardUrl: "https://cruzemaps.com/fleet-dashboard" };
  const mail = renderPilotSubmittedEmail({ ...vars, loiUrl: "https://cruzemaps.com/loi/abc" });
  assert(mail.html.includes('href="https://cruzemaps.com/loi/abc"'));
  assert(mail.text.includes("Download your signed LOI: https://cruzemaps.com/loi/abc"));
  assert(!renderPilotSubmittedEmail(vars).text.includes("Download your signed LOI"));
});
