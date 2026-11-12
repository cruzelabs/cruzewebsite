// Unit tests for notify-discord request handling. No network, no database:
// the handler gets fake dependencies. Run from the repo root:
//
//   deno test supabase/functions/notify-discord/
//
// CI runs this in the "edge functions" job of .github/workflows/test.yml.

import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import {
  ADMIN_MESSAGES_URL,
  type Deps,
  handle,
  plain,
  type Row,
  shareBudget,
  SLACK_MAX_CHARS,
  slackText,
  type Table,
} from "./handler.ts";

const NOW = new Date("2026-10-18T12:00:00Z");
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ENV: Record<string, string> = { DISCORD_WEBHOOK_URL: "https://discord.invalid/default" };

type Fake = Deps & {
  posts: { url: string; body: Row }[];
  claims: Set<string>;
  loads: { table: Table; id: string }[];
};

function fake(opts: {
  rows?: Partial<Record<Table, Row>>;
  env?: Record<string, string>;
  recentContacts?: number | null;
  loadError?: string;
  claimError?: boolean;
  discordStatus?: number;
  slackStatus?: number;
} = {}): Fake {
  const env = opts.env ?? ENV;
  const d: Fake = {
    posts: [],
    claims: new Set(),
    loads: [],
    env: (name) => env[name],
    now: () => NOW,
    loadRow(table, id) {
      d.loads.push({ table, id });
      if (opts.loadError) return Promise.resolve({ row: null, error: opts.loadError });
      const row = opts.rows?.[table];
      return Promise.resolve({ row: row && row.id === id ? row : null });
    },
    claim(key) {
      if (opts.claimError) return Promise.resolve("error");
      if (d.claims.has(key)) return Promise.resolve("duplicate");
      d.claims.add(key);
      return Promise.resolve("claimed");
    },
    countContactsSince() {
      return Promise.resolve(opts.recentContacts === undefined ? 1 : opts.recentContacts);
    },
    postWebhook(url, body) {
      d.posts.push({ url, body: body as Row });
      const status = (url.startsWith("https://slack.") ? opts.slackStatus : opts.discordStatus) ?? 204;
      return Promise.resolve({ ok: status < 300, status, text: status < 300 ? "" : "nope" });
    },
  };
  return d;
}

function post(body: unknown): Request {
  return new Request("https://fn.invalid/notify-discord", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const contactRow = (over: Row = {}): Row => ({
  id: ID,
  name: "Dana Lee",
  email: "dana@example.com",
  organization: "Acme Freight",
  message: "Hello\nWe run 40 trucks.",
  created_at: minutesAgo(1),
  ...over,
});

const pilotRow = (over: Row = {}): Row => ({
  id: ID,
  company_name: "Acme Freight",
  truck_size: "Class 8",
  fleet_size: "40",
  truck_count: 40,
  notes: null,
  contact_name: "Dana Lee",
  contact_email: "dana@example.com",
  fms_provider: "Samsara",
  fms_other: null,
  primary_lanes: "Laredo yard; I-35 Laredo to Dallas",
  data_authorizer_name: null,
  data_authorizer_email: null,
  safety_contact_name: null,
  safety_contact_email: null,
  tablet_model: null,
  tablet_count: null,
  tablet_management: null,
  website: "https://acme.example",
  created_at: minutesAgo(1),
  ...over,
});

const loiRow = (over: Row = {}): Row => ({
  id: ID,
  participant_name: "Dana Lee",
  participant_company: "Acme Freight",
  participant_title: "COO",
  fleet_size: "40",
  initials: "DL",
  signed_at: minutesAgo(1),
  created_at: minutesAgo(1),
  ...over,
});

async function call(d: Fake, payload: unknown) {
  const res = await handle(post(payload), d);
  return { status: res.status, body: await res.json() };
}

Deno.test("rejects non-POST and bad JSON", async () => {
  const d = fake();
  const res = await handle(new Request("https://fn.invalid/x", { method: "GET" }), d);
  assertEquals(res.status, 405);
  assertEquals((await call(d, "{not json")).status, 400);
  assertEquals(d.posts.length, 0);
});

Deno.test("only INSERTs on the three tables, with a uuid id", async () => {
  const d = fake({ rows: { contact_messages: contactRow() } });
  assertEquals((await call(d, { type: "UPDATE", table: "contact_messages", record: { id: ID } })).body, {
    skipped: "not an insert",
  });
  assertEquals((await call(d, { type: "INSERT", table: "profiles", record: { id: ID } })).body, {
    skipped: "unknown table",
  });
  assertEquals((await call(d, { type: "INSERT", table: "contact_messages", record: { id: "x' or 1=1" } })).status, 400);
  assertEquals((await call(d, { type: "INSERT", table: "contact_messages", record: {} })).status, 400);
  assertEquals(d.posts.length, 0);
  assertEquals(d.loads.length, 0);
});

Deno.test("builds the embed from the database row, not the posted record", async () => {
  const d = fake({ rows: { contact_messages: contactRow() } });
  const forged = { id: ID, name: "@everyone", message: "[Reset your password](https://evil.example)" };
  const { status, body } = await call(d, { type: "INSERT", table: "contact_messages", schema: "public", record: forged });
  assertEquals(status, 200);
  assertEquals(body, { ok: true, table: "contact_messages" });
  assertEquals(d.loads, [{ table: "contact_messages", id: ID }]);
  assertEquals(d.posts.length, 1);
  const sent = JSON.stringify(d.posts[0].body);
  assert(!sent.includes("evil.example"));
  assert(!sent.includes("@everyone"));
  const embed = d.posts[0].body.embeds[0];
  const field = (name: string) => embed.fields.find((f: Row) => f.name === name)?.value;
  assertEquals(field("Name"), "Dana Lee");
  assertEquals(field("Organization"), "Acme Freight");
  assertEquals(field("Email"), "dana@example.com");
  assertEquals(field("Message"), "Hello\nWe run 40 trucks.");
  assertEquals(embed.url, ADMIN_MESSAGES_URL);
  assertEquals(d.posts[0].body.allowed_mentions, { parse: [] });
});

Deno.test("an id with no row posts nothing", async () => {
  const d = fake({ rows: {} });
  const { body } = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(body, { skipped: "row not found" });
  assertEquals(d.posts.length, 0);
});

Deno.test("old and future-dated rows are not posted", async () => {
  for (const created_at of [minutesAgo(11), minutesAgo(-5), null, "not a date"]) {
    const d = fake({ rows: { contact_messages: contactRow({ created_at }) } });
    const { body } = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
    assertEquals(body, { skipped: "row is not new" }, String(created_at));
    assertEquals(d.posts.length, 0);
  }
});

Deno.test("a replayed payload posts once", async () => {
  const d = fake({ rows: { contact_messages: contactRow() } });
  const payload = { type: "INSERT", table: "contact_messages", record: { id: ID } };
  assertEquals((await call(d, payload)).body.ok, true);
  assertEquals((await call(d, payload)).body, { skipped: "already notified" });
  assertEquals(d.posts.length, 1);
});

Deno.test("fails closed when the database cannot be read or the claim cannot be recorded", async () => {
  const payload = { type: "INSERT", table: "contact_messages", record: { id: ID } };
  const a = fake({ loadError: "boom" });
  assertEquals((await call(a, payload)).status, 500);
  const b = fake({ rows: { contact_messages: contactRow() }, claimError: true });
  assertEquals((await call(b, payload)).status, 500);
  assertEquals(a.posts.length + b.posts.length, 0);
});

Deno.test("no webhook configured is a 200 skip", async () => {
  const d = fake({ env: {}, rows: { contact_messages: contactRow() } });
  const { status, body } = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(status, 200);
  assert(body.skipped);
  assertEquals(d.loads.length, 0);
});

Deno.test("per-table webhook secrets fall back to DISCORD_WEBHOOK_URL", async () => {
  const rows = { contact_messages: contactRow(), pilot_applications: pilotRow(), loi_signatures: loiRow() };
  const split = fake({
    rows,
    env: { ...ENV, DISCORD_WEBHOOK_CONTACT: "https://discord.invalid/contact", DISCORD_WEBHOOK_PILOTS: "https://discord.invalid/pilots" },
  });
  for (const table of ["contact_messages", "pilot_applications", "loi_signatures"]) {
    await call(split, { type: "INSERT", table, record: { id: ID } });
  }
  assertEquals(split.posts.map((p) => p.url), [
    "https://discord.invalid/contact",
    "https://discord.invalid/pilots",
    "https://discord.invalid/default",
  ]);
});

Deno.test("long messages are cut to about 500 characters", async () => {
  const d = fake({ rows: { contact_messages: contactRow({ message: "a".repeat(3000) }) } });
  await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  const value = d.posts[0].body.embeds[0].fields.find((f: Row) => f.name === "Message").value;
  assertEquals(value, "a".repeat(500) + "…");
});

Deno.test("flood guard: more than 10 in 10 minutes posts one note per window", async () => {
  const d = fake({ rows: { contact_messages: contactRow() }, recentContacts: 11 });
  const first = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(first.body.ok, true);
  assertEquals(d.posts.length, 1);
  assertEquals(d.posts[0].body.embeds[0].title, "Contact form flood guard");
  assert(d.posts[0].body.embeds[0].description.startsWith("11 contact messages"));
  assert(!JSON.stringify(d.posts[0].body).includes("Dana Lee"));

  const other = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  const d2 = fake({ rows: { contact_messages: contactRow({ id: other }) }, recentContacts: 12 });
  d2.claims = d.claims; // same database
  const second = await call(d2, { type: "INSERT", table: "contact_messages", record: { id: other } });
  assertEquals(second.body, { skipped: "flood guard" });
  assertEquals(d2.posts.length, 0);
});

Deno.test("flood guard does not trigger at 10", async () => {
  const d = fake({ rows: { contact_messages: contactRow() }, recentContacts: 10 });
  await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(d.posts[0].body.embeds[0].title, "New contact message");
});

Deno.test("pilot and LOI embeds keep their shape", async () => {
  const d = fake({ rows: { pilot_applications: pilotRow({ notes: "Call Tue" }), loi_signatures: loiRow() } });
  await call(d, { type: "INSERT", table: "pilot_applications", record: { id: ID } });
  await call(d, { type: "INSERT", table: "loi_signatures", record: { id: ID } });
  const [pilot, loi] = d.posts.map((p) => p.body);
  assertEquals(pilot.embeds[0].title, "🚛 New pilot application");
  assertEquals(pilot.embeds[0].fields.map((f: Row) => f.name), [
    "Company", "Trucks", "ELD or telematics", "Sites or lanes", "Truck class", "Contact", "Email", "Website",
    "Admin notes",
  ]);
  assertEquals(pilot.embeds[0].url, "https://cruzemaps.com/admin");
  assertEquals(loi.embeds[0].title, "✍️ LOI signed");
  assertEquals(loi.embeds[0].description, "**Dana Lee** just signed the Letter of Intent.");
  assertEquals(loi.embeds[0].url, `https://cruzemaps.com/loi/${ID}`);
  assertEquals(loi.embeds[0].fields.map((f: Row) => f.name), ["Participant", "Initials", "Company", "Fleet size", "Title"]);
  for (const p of [pilot, loi]) assertEquals(p.allowed_mentions, { parse: [] });
});

Deno.test("a pilot post carries every answer from the new form, in Discord and in Slack", async () => {
  const row = pilotRow({
    truck_size: null,
    fleet_size: "1200",
    truck_count: 1200,
    fms_provider: "Other",
    fms_other: "Fleet Complete",
    data_authorizer_name: "Ira Ops",
    data_authorizer_email: "ira@acme.example",
    safety_contact_name: "Sam Safety",
    safety_contact_email: "sam@acme.example",
    tablet_model: "Galaxy Tab Active5",
    tablet_count: 120,
    tablet_management: "fleet_mdm",
  });
  const d = fake({ env: { ...ENV, SLACK_WEBHOOK_URL: "https://slack.invalid/hook" }, rows: { pilot_applications: row } });
  const { body } = await call(d, { type: "INSERT", table: "pilot_applications", record: { id: ID } });
  assertEquals(body, { ok: true, table: "pilot_applications" });
  const embed = d.posts[0].body.embeds[0];
  const field = (name: string) => embed.fields.find((f: Row) => f.name === name)?.value;
  assertEquals(field("Trucks"), "1,200");
  assertEquals(field("ELD or telematics"), "Other \\(Fleet Complete\\)");
  assertEquals(field("Sites or lanes"), "Laredo yard; I-35 Laredo to Dallas");
  assertEquals(field("Authorizes data access"), "Ira Ops, ira@acme.example");
  assertEquals(field("Safety contact"), "Sam Safety, sam@acme.example");
  assertEquals(field("Tablets"), "120 tablets, Galaxy Tab Active5, managed through the fleet's MDM");
  assertEquals(field("Truck class"), undefined);

  const lines: string[] = d.posts[1].body.text.split("\n");
  assert(lines.includes("*Trucks:* 1,200"));
  assert(lines.includes("*ELD or telematics:* Other (Fleet Complete)"));
  assert(lines.includes("*Sites or lanes:* Laredo yard; I-35 Laredo to Dallas"));
  assert(lines.includes("*Tablets:* 120 tablets, Galaxy Tab Active5, managed through the fleet's MDM"));
});

Deno.test("a pilot post from the old form says what is missing", async () => {
  const row = pilotRow({ fleet_size: "101-500", truck_count: null, fms_provider: null, primary_lanes: null });
  const d = fake({ rows: { pilot_applications: row } });
  await call(d, { type: "INSERT", table: "pilot_applications", record: { id: ID } });
  const fields: Row[] = d.posts[0].body.embeds[0].fields;
  const field = (name: string) => fields.find((f) => f.name === name)?.value;
  assertEquals(field("Trucks"), "101-500");
  assertEquals(field("ELD or telematics"), "(not given)");
  assertEquals(field("Sites or lanes"), "(not given)");
  for (const name of ["Authorizes data access", "Safety contact", "Tablets"]) assertEquals(field(name), undefined);
});

Deno.test("a pilot post with every text field at its longest stays under Discord's 6,000 characters", async () => {
  const long = (n: number) => "x".repeat(n);
  const row = pilotRow({
    company_name: long(5000),
    fleet_size: long(5000),
    truck_count: null,
    truck_size: long(5000),
    contact_name: long(5000),
    contact_email: long(5000),
    fms_provider: long(5000),
    fms_other: long(5000),
    primary_lanes: long(5000),
    data_authorizer_name: long(5000),
    data_authorizer_email: long(5000),
    safety_contact_name: long(5000),
    safety_contact_email: long(5000),
    tablet_model: long(5000),
    tablet_count: 1000000,
    tablet_management: "cruze",
    website: long(5000),
    notes: long(5000),
  });
  const d = fake({ rows: { pilot_applications: row } });
  await call(d, { type: "INSERT", table: "pilot_applications", record: { id: ID } });
  const embed = d.posts[0].body.embeds[0];
  const total = [embed.title, embed.description, embed.footer.text, ...embed.fields.flatMap((f: Row) => [f.name, f.value])]
    .join("").length;
  assert(total < 6000, `embed is ${total} characters`);
  for (const f of embed.fields) assert(f.value.length <= 1024, f.name);
});

Deno.test("the Slack copy keeps every field when each answer is as long as the form allows", async () => {
  // The /apply inputs' maxLength: names 200, emails 320, provider name 200,
  // tablet model 200, sites or lanes 1,000. Company and contact have no limit
  // on the form, so they get the length of a long real name.
  const row = pilotRow({
    company_name: "C".repeat(200),
    contact_name: "N".repeat(200),
    contact_email: "e".repeat(310) + "@example.com",
    fms_provider: "Other",
    fms_other: "P".repeat(200),
    primary_lanes: "L".repeat(1000),
    data_authorizer_name: "A".repeat(200),
    data_authorizer_email: "a".repeat(310) + "@example.com",
    safety_contact_name: "S".repeat(200),
    safety_contact_email: "s".repeat(310) + "@example.com",
    tablet_model: "M".repeat(200),
    tablet_count: 1000000,
    tablet_management: "manual",
    website: "https://" + "w".repeat(300) + ".example",
  });
  const d = fake({ env: { SLACK_WEBHOOK_URL: "https://slack.invalid/hook" }, rows: { pilot_applications: row } });
  await call(d, { type: "INSERT", table: "pilot_applications", record: { id: ID } });
  const text: string = d.posts[0].body.text;
  assert(text.length < SLACK_MAX_CHARS, `Slack text is ${text.length} characters`);
  for (const label of [
    "Company", "Trucks", "ELD or telematics", "Sites or lanes", "Truck class", "Contact", "Email",
    "Authorizes data access", "Safety contact", "Tablets", "Website",
  ]) {
    assert(text.includes(`*${label}:* `), `Slack text lost ${label}`);
  }
  assert(text.endsWith("<https://cruzemaps.com/admin>"), "Slack text lost its admin link");
});

Deno.test("the Slack copy keeps every field even when escaping for Slack makes the answers longer", async () => {
  // Every & becomes &amp; for Slack, five times its length.
  const amps = (n: number) => "&".repeat(n);
  const row = pilotRow({
    company_name: amps(200),
    contact_name: amps(200),
    contact_email: amps(320),
    fms_provider: "Other",
    fms_other: amps(200),
    primary_lanes: amps(1000),
    data_authorizer_name: amps(200),
    data_authorizer_email: amps(320),
    safety_contact_name: amps(200),
    safety_contact_email: amps(320),
    tablet_model: amps(200),
    tablet_count: 12,
    website: amps(300),
  });
  const d = fake({ env: { SLACK_WEBHOOK_URL: "https://slack.invalid/hook" }, rows: { pilot_applications: row } });
  await call(d, { type: "INSERT", table: "pilot_applications", record: { id: ID } });
  const text: string = d.posts[0].body.text;
  assert(text.length <= SLACK_MAX_CHARS, `Slack text is ${text.length} characters`);
  for (const label of [
    "Company", "Trucks", "ELD or telematics", "Sites or lanes", "Truck class", "Contact", "Email",
    "Authorizes data access", "Safety contact", "Tablets", "Website",
  ]) {
    assert(text.includes(`*${label}:* `), `Slack text lost ${label}`);
  }
  assert(text.endsWith("<https://cruzemaps.com/admin>"), "Slack text lost its admin link");
  // No entity is cut in half.
  assert(!/&(a|am|amp|l|lt|g|gt)?…/.test(text), "an entity was cut");
});

Deno.test("shareBudget keeps short values whole and shares the rest", () => {
  assertEquals(shareBudget(["aa", "bbbbbbbbbb", "cccccccccc"], 12), ["aa", "bbbb…", "cccc…"]);
  assertEquals(shareBudget(["a", "b"], 10), ["a", "b"]);
});

Deno.test("Discord failure is a 500 and does not echo Discord's reply", async () => {
  const d = fake({ rows: { contact_messages: contactRow() }, discordStatus: 400 });
  const { status, body } = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(status, 500);
  assertEquals(body, { error: "Discord 400" });
});

Deno.test("plain() escapes markdown so user text cannot form links or headings", () => {
  assertEquals(plain("[click](https://x.example)"), "\\[click\\]\\(https://x.example\\)");
  assertEquals(plain("# Big\n- item"), "\\# Big\n\\- item");
  assertEquals(plain("**bold** `code` <@123> ||spoiler||"), "\\*\\*bold\\*\\* \\`code\\` \\<@123\\> \\|\\|spoiler\\|\\|");
  assertEquals(plain("dana-lee@example.com"), "dana-lee@example.com");
});

const SLACK_ENV = { SLACK_WEBHOOK_URL: "https://slack.invalid/hook" };

Deno.test("SLACK_WEBHOOK_URL alone posts the notice to Slack as escaped text", async () => {
  const row = contactRow({ name: "<!channel> & co", message: "[Reset](https://evil.example) *hi*" });
  const d = fake({ env: SLACK_ENV, rows: { contact_messages: row } });
  const { status, body } = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(status, 200);
  assertEquals(body, { ok: true, table: "contact_messages" });
  assertEquals(d.posts.map((p) => p.url), ["https://slack.invalid/hook"]);
  assertEquals(Object.keys(d.posts[0].body), ["text"]);
  const lines: string[] = d.posts[0].body.text.split("\n");
  assertEquals(lines[0], "*New contact message*");
  assert(lines.includes("*Name:* &lt;!channel&gt; &amp; co"));
  assert(lines.includes("*Message:* [Reset](https://evil.example) *hi*"));
  assert(lines.includes(`*Admin tab:* ${ADMIN_MESSAGES_URL}`));
  assert(!d.posts[0].body.text.includes("<"));
});

Deno.test("with both webhooks set the notice goes to Discord and Slack", async () => {
  const d = fake({ env: { ...ENV, ...SLACK_ENV }, rows: { loi_signatures: loiRow() } });
  const { body } = await call(d, { type: "INSERT", table: "loi_signatures", record: { id: ID } });
  assertEquals(body, { ok: true, table: "loi_signatures" });
  assertEquals(d.posts.map((p) => p.url), ["https://discord.invalid/default", "https://slack.invalid/hook"]);
  assertEquals(d.posts[0].body.embeds[0].title, "✍️ LOI signed");
  const lines: string[] = d.posts[1].body.text.split("\n");
  assertEquals(lines[0], "*✍️ LOI signed*");
  assertEquals(lines[1], "*Dana Lee* just signed the Letter of Intent.");
  assertEquals(lines.at(-1), `<https://cruzemaps.com/loi/${ID}>`);
});

Deno.test("a Slack failure is a 500 that names Slack, and Discord still gets the notice", async () => {
  const d = fake({ env: { ...ENV, ...SLACK_ENV }, rows: { contact_messages: contactRow() }, slackStatus: 500 });
  const { status, body } = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(status, 500);
  assertEquals(body, { error: "Slack 500" });
  assertEquals(d.posts.length, 2);
});

Deno.test("slackText() undoes plain() and escapes only what Slack needs", () => {
  for (const s of ["[click](https://x.example)", "# Big\n- item", "back\\slash \\# and `code`", "a_b ~c~ ||d||"]) {
    assertEquals(slackText(plain(s)), s);
  }
  assertEquals(slackText(plain("A&B <@U123> <!here>")), "A&amp;B &lt;@U123&gt; &lt;!here&gt;");
  assertEquals(slackText(`**${plain("Dana **Lee**")}** signed`), "*Dana **Lee*** signed");
});
