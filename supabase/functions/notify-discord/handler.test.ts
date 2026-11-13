// Unit tests for notify-discord request handling. No network, no database:
// the handler gets fake dependencies. Run from the repo root:
//
//   deno test supabase/functions/notify-discord/
//
// CI runs this in the "edge functions" job of .github/workflows/test.yml.

import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import {
  ADMIN_MESSAGES_URL,
  COLUMNS,
  contactNotice,
  type Deps,
  DISCORD_EMBED_MAX_CHARS,
  discordMessage,
  handle,
  loiNotice,
  type Notice,
  PILOT_APPLICANT_NOTES_CHARS,
  PILOT_PHONE_CHARS,
  PILOT_TITLE_CHARS,
  pilotEmbed,
  pilotNotice,
  plain,
  type Row,
  SLACK_MAX_CHARS,
  slackMessage,
  slackPlain,
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
  notes: null,
  contact_name: "Dana Lee",
  contact_email: "dana@example.com",
  contact_phone: null,
  contact_title: null,
  application_notes: null,
  fms_provider: "Samsara",
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
    "Company", "Fleet size", "Truck class", "Contact", "Email", "FMS", "Website", "Admin notes",
  ]);
  assertEquals(pilot.embeds[0].url, "https://cruzemaps.com/admin");
  assertEquals(loi.embeds[0].title, "✍️ LOI signed");
  assertEquals(loi.embeds[0].description, "**Dana Lee** just signed the Letter of Intent.");
  assertEquals(loi.embeds[0].url, `https://cruzemaps.com/loi/${ID}`);
  assertEquals(loi.embeds[0].fields.map((f: Row) => f.name), ["Participant", "Initials", "Company", "Fleet size", "Title"]);
  for (const p of [pilot, loi]) assertEquals(p.allowed_mentions, { parse: [] });
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
  // Our link is the third line, above everything the sender typed.
  assertEquals(lines[2], `*Admin tab:* <${ADMIN_MESSAGES_URL}>`);
  assert(lines.includes("*Name:* &lt;!channel&gt; &amp; co"));
  // The message is quoted, its URL is not one Slack would link, and its
  // asterisks are look-alikes that Slack does not read as bold.
  assertEquals(lines.slice(-2), ["*Message:*", "> [Reset](evil.example) \u2217hi\u2217"]);
  assertEquals(d.posts[0].body.text.match(/<[^>]*>/g), [`<${ADMIN_MESSAGES_URL}>`]);
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
  assertEquals(lines[2], `*Signed LOI:* <https://cruzemaps.com/loi/${ID}>`);
});

Deno.test("a Slack failure is a 500 that names Slack, and Discord still gets the notice", async () => {
  const d = fake({ env: { ...ENV, ...SLACK_ENV }, rows: { contact_messages: contactRow() }, slackStatus: 500 });
  const { status, body } = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(status, 500);
  assertEquals(body, { error: "Slack 500" });
  assertEquals(d.posts.length, 2);
});

Deno.test("slackPlain() leaves row text with nothing Slack would format or link", () => {
  assertEquals(slackPlain("A&B <@U123> <!here>"), "A&amp;B &lt;@U123&gt; &lt;!here&gt;");
  assertEquals(slackPlain("*bold* ~gone~ `code` _it_"), "\u2217bold\u2217 \u223cgone\u223c \u02cbcode\u02cb \uff3fit\uff3f");
  // An underscore inside a word is not formatting, so addresses stay as typed.
  assertEquals(slackPlain("dana_lee@example.com +1 (512) 555-0100"), "dana_lee@example.com +1 (512) 555-0100");
  assertEquals(slackPlain("see https://evil.example/a?b=1 or HTTP://x.example"), "see evil.example/a?b=1 or x.example");
  // Dropping a scheme cannot leave another one behind.
  assertEquals(slackPlain("hthttps://tps://evil.example slack://open"), "evil.example open");
  assertEquals(slackPlain(null), "");
});

Deno.test("a pilot application keeps the contact's phone, title and the applicant's notes", async () => {
  for (const col of ["contact_phone", "contact_title", "application_notes"]) {
    assert(COLUMNS.pilot_applications.split(/,\s*/).includes(col), col);
  }
  const row = pilotRow({
    contact_phone: "+1 (512) 555-0100",
    contact_title: "VP *Ops* <!channel>",
    application_notes: "[Reset](https://evil.example)\n# 40 trucks on I-35 & I-10",
    notes: "Call Tue",
  });
  const d = fake({ env: { ...ENV, ...SLACK_ENV }, rows: { pilot_applications: row } });
  const { body } = await call(d, { type: "INSERT", table: "pilot_applications", record: { id: ID } });
  assertEquals(body, { ok: true, table: "pilot_applications" });

  const fields: Row[] = d.posts[0].body.embeds[0].fields;
  assertEquals(fields.map((f) => f.name), [
    "Company", "Fleet size", "Truck class", "Contact", "Title", "Email", "Phone", "FMS", "Website",
    "Applicant notes", "Admin notes",
  ]);
  const value = (name: string) => fields.find((f) => f.name === name)!.value;
  // Escaped like the other applicant text: no masked link, heading, bold or mention.
  assertEquals(value("Phone"), "+1 \\(512\\) 555-0100");
  assertEquals(value("Title"), "VP \\*Ops\\* \\<!channel\\>");
  assertEquals(value("Applicant notes"), "\\[Reset\\]\\(https://evil.example\\)\n\\# 40 trucks on I-35 & I-10");
  assertEquals(d.posts[0].body.allowed_mentions, { parse: [] });

  const slack: string = d.posts[1].body.text;
  const lines = slack.split("\n");
  assert(lines.includes("*Phone:* +1 (512) 555-0100"));
  assert(lines.includes("*Title:* VP \u2217Ops\u2217 &lt;!channel&gt;"));
  assert(slack.includes("*Applicant notes:*\n> [Reset](evil.example)\n> # 40 trucks on I-35 &amp; I-10\n"));
  assertEquals(slack.match(/<[^>]*>/g), ["<https://cruzemaps.com/admin>"]);
});

Deno.test("the applicant's text on a pilot application is capped", () => {
  const embed = pilotEmbed(pilotRow({
    contact_phone: "5".repeat(500),
    contact_title: "*".repeat(500),
    application_notes: "x".repeat(5000),
  })).embeds[0];
  const value = (name: string) => embed.fields.find((f: Row) => f.name === name).value;
  assertEquals(value("Phone").length, PILOT_PHONE_CHARS);
  // A cut never ends on half an escape, so this one is a character short.
  assertEquals(value("Title"), "\\*".repeat(63) + "…");
  assert(value("Title").length <= PILOT_TITLE_CHARS);
  assertEquals(value("Applicant notes").length, PILOT_APPLICANT_NOTES_CHARS);
  assert(value("Applicant notes").endsWith("…"));
});

Deno.test("missing, null and blank contact details add no fields", () => {
  const names = (row: Row) => pilotEmbed(row).embeds[0].fields.map((f: Row) => f.name);
  const base = ["Company", "Fleet size", "Truck class", "Contact", "Email", "FMS", "Website"];
  assertEquals(names(pilotRow()), base);
  assertEquals(names(pilotRow({ contact_phone: "  ", contact_title: "", application_notes: "\n" })), base);
  // A row read before the columns were selected has no such keys at all.
  const { contact_phone: _p, contact_title: _t, application_notes: _n, ...old } = pilotRow();
  assertEquals(names(old), base);
});

// Every Slack line that starts a field, and every link, in a Slack message.
const slackLabels = (text: string) => text.split("\n").filter((l) => /^\s*\*/.test(l)).map((l) => l.match(/^\s*\*[^*]*\*/)?.[0]);
const slackLinks = (text: string) => text.match(/<[^>]*>/g) ?? [];
// What Slack turns into a link on its own: a URL with a scheme.
const BARE_URL = /[a-z][a-z0-9+.-]*:\/\//i;

const FORGED = "\n*Admin tab:* https://evil.example\r\n> *Admin portal:* <https://evil.example|Open> *Email:* ceo@evil.example";

Deno.test("Slack: applicant text cannot forge a field or a link on a pilot application", () => {
  const cols = [
    "company_name", "fleet_size", "truck_size", "contact_name", "contact_title", "contact_email",
    "contact_phone", "fms_provider", "website", "application_notes", "notes",
  ];
  const expected = [
    "*🚛 New pilot application*", "*Admin portal:*", "*Company:*", "*Fleet size:*", "*Truck class:*", "*Contact:*",
    "*Title:*", "*Email:*", "*Phone:*", "*FMS:*", "*Website:*", "*Applicant notes:*", "*Admin notes:*",
  ];
  // The forged text in one column at a time, then in all of them at once.
  const rows = [
    ...cols.map((col) => pilotRow({ contact_title: "VP", contact_phone: "555", application_notes: "Hi", notes: "x", [col]: `Acme${FORGED}` })),
    pilotRow(Object.fromEntries(cols.map((col) => [col, `Acme${FORGED}`]))),
  ];
  for (const row of rows) {
    const text: string = slackMessage(pilotNotice(row)).text;
    const lines = text.split("\n");
    assertEquals(slackLabels(text), expected);
    assertEquals(lines[2], "*Admin portal:* <https://cruzemaps.com/admin>");
    assertEquals(slackLinks(text), ["<https://cruzemaps.com/admin>"]);
    // No URL but ours is one Slack would link.
    assert(!BARE_URL.test(text.replace("<https://cruzemaps.com/admin>", "")));
    // Past our three lines, a line is a field of ours or a quoted line of notes.
    for (const l of lines.slice(3)) assert(/^(\*[A-Za-z ]+:\*( |$)|> |>$)/.test(l), l);
  }
  // A one-line value stays on its field's line.
  const one: string = slackMessage(pilotNotice(pilotRow({ contact_title: `VP${FORGED}` }))).text;
  assert(one.split("\n").some((l) => l.startsWith("*Title:* VP ∗Admin tab:∗ evil.example &gt; ")), one);
});

Deno.test("Slack: contact and LOI text cannot forge a field or a link either", () => {
  const contact: string = slackMessage(contactNotice(contactRow({
    name: `Dana${FORGED}`, email: `d@x.example${FORGED}`, organization: `Acme${FORGED}`, message: `Hello${FORGED}`,
  }))).text;
  assertEquals(slackLabels(contact), ["*New contact message*", "*Admin tab:*", "*Name:*", "*Organization:*", "*Email:*", "*Message:*"]);
  assertEquals(slackLinks(contact), [`<${ADMIN_MESSAGES_URL}>`]);
  assert(!BARE_URL.test(contact.replace(`<${ADMIN_MESSAGES_URL}>`, "")));

  const loi: string = slackMessage(loiNotice(loiRow({
    participant_name: `Dana${FORGED}`, participant_company: `Acme${FORGED}`, participant_title: `COO${FORGED}`,
    fleet_size: `40${FORGED}`, initials: `DL${FORGED}`,
  }))).text;
  const link = `<https://cruzemaps.com/loi/${ID}>`;
  // The signer's name is in bold on line two; nothing in it closes the bold.
  assertEquals(slackLabels(loi), [
    "*✍️ LOI signed*", loi.split("\n")[1].match(/^\*[^*]*\*/)![0], "*Signed LOI:*",
    "*Participant:*", "*Initials:*", "*Company:*", "*Fleet size:*", "*Title:*",
  ]);
  assert(loi.split("\n")[1].endsWith("* just signed the Letter of Intent."));
  assertEquals(loi.split("\n").length, 8);
  assertEquals(slackLinks(loi), [link]);
  assert(!BARE_URL.test(loi.replace(link, "")));
});

// The longest values the notice can be handed: text columns have no length
// limit, and these characters grow the most when escaped.
const hugeRow = (ch: string, n = 20000): Row => {
  const big = ch.repeat(n);
  return pilotRow({
    company_name: big, fleet_size: big, truck_size: big, contact_name: big, contact_title: big, contact_email: big,
    contact_phone: big, fms_provider: big, website: big, application_notes: `${big}\n${big}`, notes: big,
  });
};

Deno.test("Slack: the admin link survives however long the applicant's text is", () => {
  for (const ch of ["x", "&", "<", "*", "\n", "y\n", "😀", FORGED]) {
    for (const notice of [pilotNotice(hugeRow(ch)), contactNotice(contactRow({ name: ch.repeat(9000), email: ch.repeat(9000), organization: ch.repeat(9000), message: ch.repeat(9000) }))]) {
      const text: string = slackMessage(notice).text;
      assert(text.length <= SLACK_MAX_CHARS, `${JSON.stringify(ch)} ${text.length}`);
      assertEquals(text.split("\n")[2], `*${notice.link.label}:* <${notice.link.url}>`);
      assertEquals(slackLinks(text), [`<${notice.link.url}>`]);
      // Nothing was cut blind: every field is still there, the last one included.
      const last = notice.fields.filter((f) => !f.trusted).at(-1)!.name;
      assert(text.includes(`\n*${last}:*`), JSON.stringify(ch));
    }
  }
  // A long signer name cannot push the LOI link out either.
  const loi: string = slackMessage(loiNotice(loiRow({ participant_name: "&".repeat(9000), participant_company: "<".repeat(9000) }))).text;
  assert(loi.length <= SLACK_MAX_CHARS);
  assertEquals(loi.split("\n")[2], `*Signed LOI:* <https://cruzemaps.com/loi/${ID}>`);
});

// What Discord counts toward its 6000-character limit for one embed.
function embedChars(embed: Row): number {
  return embed.title.length + embed.description.length + (embed.footer?.text.length ?? 0) +
    embed.fields.reduce((n: number, f: Row) => n + f.name.length + f.value.length, 0);
}

Deno.test("Discord: an embed with maximum-length values stays under the 6000-character limit", () => {
  const notices: Notice[] = [];
  for (const ch of ["x", "*", "😀", "y\n", FORGED]) {
    notices.push(pilotNotice(hugeRow(ch)));
    notices.push(loiNotice(loiRow({
      participant_name: ch.repeat(9000), participant_company: ch.repeat(9000), participant_title: ch.repeat(9000),
      fleet_size: ch.repeat(9000), initials: ch.repeat(9000),
    })));
    notices.push(contactNotice(contactRow({ name: ch.repeat(9000), email: ch.repeat(9000), organization: ch.repeat(9000), message: ch.repeat(9000) })));
  }
  for (const notice of notices) {
    const embed = discordMessage(notice).embeds[0];
    assert(embedChars(embed) <= DISCORD_EMBED_MAX_CHARS, `${notice.title} ${embedChars(embed)}`);
    assert(embed.description.length <= 4096);
    for (const f of embed.fields) {
      assert(f.value.length >= 1 && f.value.length <= 1024, f.name);
      // No cut ends on half an escape or half a surrogate pair.
      assert(!/(?<!\\)(\\\\)*\\…$/.test(f.value), f.name);
      assert(!/[\ud800-\udbff]…$/.test(f.value), f.name);
    }
    assertEquals(embed.url, notice.link.url);
  }
});

Deno.test("Discord: notes are shortened first, and a normal application is not shortened at all", () => {
  // The reviewer's case: every field full, which used to come to 6,399 characters.
  const embed = pilotEmbed(hugeRow("x", 1024)).embeds[0];
  const len = (name: string) => embed.fields.find((f: Row) => f.name === name).value.length;
  assert(embedChars(embed) <= DISCORD_EMBED_MAX_CHARS);
  assert(len("Applicant notes") < PILOT_APPLICANT_NOTES_CHARS);
  assert(len("Admin notes") < 1024);
  assert(len("Applicant notes") >= 200 && len("Admin notes") >= 200);
  assertEquals(len("Title"), PILOT_TITLE_CHARS);
  assertEquals(len("Phone"), PILOT_PHONE_CHARS);

  // Long notes alone fit, so nothing is cut below its own cap.
  const notes = "n".repeat(900);
  const normal = pilotEmbed(pilotRow({ application_notes: notes, notes: "Call Tue" })).embeds[0];
  assertEquals(normal.fields.find((f: Row) => f.name === "Applicant notes").value, notes);
  assertEquals(normal.fields.find((f: Row) => f.name === "Company").value, "Acme Freight");
});

Deno.test("line breaks in a one-line value are collapsed; notes keep theirs", () => {
  const embed = pilotEmbed(pilotRow({ contact_title: "VP\r\n\n Ops", application_notes: "a\r\nb\n\n\n\nc" })).embeds[0];
  const value = (name: string) => embed.fields.find((f: Row) => f.name === name).value;
  assertEquals(value("Title"), "VP Ops");
  assertEquals(value("Applicant notes"), "a\nb\n\nc");
});
