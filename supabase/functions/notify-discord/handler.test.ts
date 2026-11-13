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
  discordText,
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
  // A numbered item at a line start is a list in Discord; a number inside text is not.
  assertEquals(plain("1. one\n  2. two\n3.5 trucks\n10.\nRoom 4. B"), "1\\. one\n  2\\. two\n3.5 trucks\n10\\.\nRoom 4. B");
});

// Applicant text outside inline code, as Discord reads it: a backtick opens or
// closes code unless an odd run of backslashes escapes it.
function outsideCode(s: string): { text: string; open: boolean } {
  let text = "";
  let open = false;
  let run = 0;
  for (const ch of s) {
    if (ch === "`" && run % 2 === 0) {
      open = !open;
      run = 0;
      continue;
    }
    run = ch === "\\" ? run + 1 : 0;
    if (!open) text += ch;
  }
  return { text, open };
}
// What Discord links in embed text: a URL with a scheme. www. and host/path
// are checked too, since discordText() promises to wrap them.
const DISCORD_LINKABLE = /:\/\/|www\.|[a-z0-9-]\.[a-z][a-z0-9-]*\//i;
function assertNoDiscordLink(value: string, what: string) {
  const { text, open } = outsideCode(value);
  assert(!open, `${what}: unclosed inline code in ${value}`);
  assert(!DISCORD_LINKABLE.test(text), `${what}: ${value}`);
}

const URLISH = [
  "https://evil.example/a?b=1", "HTTP://X.EXAMPLE", "discord://-/channels/1", "<https://evil.example>",
  "[Reset](https://evil.example)", "www.cruzemaps-admin.com", "cruzemaps.com.evil.io/admin", "hthttps://tps://x.example",
];

Deno.test("discordText() puts URL-like text in inline code and escapes the rest", () => {
  assertEquals(discordText("see https://evil.example/a now"), "see `https://evil.example/a` now");
  assertEquals(discordText("[Reset](https://evil.example) *now*"), "`[Reset](https://evil.example)` \\*now\\*");
  // Inside code nothing can be escaped, so a backtick and a backslash become look-alikes.
  assertEquals(discordText("https://e`vil.example\\x`"), "`https://e\u02cbvil.example\u29f5x\u02cb`");
  assertEquals(discordText("www.evil.io and evil.io/admin"), "`www.evil.io` and `evil.io/admin`");
  // Not URL-like: plain text, numbers, emails (Discord does not link an email).
  assertEquals(discordText("1.5/day, ceo@evil.io, I-35/I-10"), "1.5/day, ceo@evil.io, I-35/I-10");
  assertEquals(discordText("1. https://x.example\n# h"), "1\\. `https://x.example`\n\\# h");
});

Deno.test("Discord: no applicant text is a link, only the embed url and the admin tab field, which are ours", () => {
  for (const u of URLISH) {
    const bad = `Acme ${u} (${u})\n${u}`;
    const pilot = pilotRow({
      company_name: bad, fleet_size: bad, truck_size: bad, contact_name: bad, contact_title: bad, contact_email: bad,
      contact_phone: bad, fms_provider: bad, website: u, application_notes: bad, notes: bad,
    });
    const embeds = [
      pilotEmbed(pilot).embeds[0],
      discordMessage(loiNotice(loiRow({ participant_name: bad, participant_company: bad, participant_title: bad, fleet_size: bad, initials: bad }))).embeds[0],
      discordMessage(contactNotice(contactRow({ name: bad, email: bad, organization: bad, message: bad }))).embeds[0],
    ];
    for (const embed of embeds) {
      assertNoDiscordLink(embed.description, `${u} description`);
      for (const f of embed.fields) {
        if (f.name === "Admin tab") assertEquals(f.value, ADMIN_MESSAGES_URL);
        else assertNoDiscordLink(f.value, `${u} ${f.name}`);
      }
      assert(embed.url.startsWith("https://cruzemaps.com/"));
    }
    // A URL on its own, as the website column usually is, is shown whole.
    assertEquals(pilotEmbed(pilot).embeds[0].fields.find((f: Row) => f.name === "Website").value, "`" + u + "`");
  }
});

Deno.test("Discord: a cut never leaves inline code open, so no cut-off URL turns into a link", () => {
  for (const ch of ["https://evil.example/", "https://evil.example/ ", "x https://e.example/aa", "`https://e.example` "]) {
    for (const notice of [
      pilotNotice(hugeRow(ch, 3000)),
      contactNotice(contactRow({ name: ch.repeat(900), email: ch.repeat(900), organization: ch.repeat(900), message: ch.repeat(900) })),
      loiNotice(loiRow({ participant_name: ch.repeat(900) })),
    ]) {
      const embed = discordMessage(notice).embeds[0];
      assert(embedChars(embed) <= DISCORD_EMBED_MAX_CHARS);
      assertNoDiscordLink(embed.description, `${JSON.stringify(ch)} description`);
      for (const f of embed.fields) {
        assert(f.value.length >= 1 && f.value.length <= 1024, f.name);
        if (f.name !== "Admin tab") assertNoDiscordLink(f.value, `${JSON.stringify(ch)} ${f.name}`);
      }
    }
  }
  // Every cap, not just the large ones: a title cut at each length.
  for (let n = 1; n < 40; n++) {
    const embed = pilotEmbed(pilotRow({ contact_title: "VP " + "https://e.example/".repeat(n) + " ok" })).embeds[0];
    assertNoDiscordLink(embed.fields.find((f: Row) => f.name === "Title").value, `title ${n}`);
  }
});

const SLACK_ENV = { SLACK_WEBHOOK_URL: "https://slack.invalid/hook" };

// The texts of a Slack message's blocks, in order, and all of them as lines.
const slackTexts = (msg: Row): string[] => msg.blocks.map((b: Row) => b.text.text);
const slackBody = (msg: Row) => slackTexts(msg).join("\n");
// Our link as slackMessage() writes it, and the block that holds it.
const slackLink = (url: string) => `<${url}|${url.replace(/^https:\/\//, "")}>`;
const linkLine = (label: string, url: string) => `*${label}:* ${slackLink(url)}`;

// What every Slack message must look like for Slack to link nothing but ours:
// a plain_text header, then mrkdwn sections. The third holds only our link;
// every other one is verbatim, which turns off Slack's automatic linking of
// URLs, bare domains, emails and channel names. The notification text names
// only our title and link.
function assertSlackSafe(msg: Row) {
  const [header, ...sections] = msg.blocks;
  assertEquals(header.type, "header");
  assertEquals(header.text.type, "plain_text");
  assert(header.text.text.length <= 150);
  assert(msg.blocks.length <= 50);
  sections.forEach((b: Row, i: number) => {
    assertEquals(b.type, "section");
    assertEquals(b.text.type, "mrkdwn");
    assert(b.text.text.length >= 1 && b.text.text.length <= 3000);
    if (i === 1) assert(/^\*[^*<>]+:\* <https:\/\/cruzemaps\.com\/[^\s<>|]*\|[^<>]+>$/.test(b.text.text), b.text.text);
    else assertEquals(b.text.verbatim, true, b.text.text);
  });
  const link = sections[1].text.text.match(/<([^|>]+)\|/)![1];
  assertEquals(msg.text, `${header.text.text}: <${link}|${sections[1].text.text.match(/^\*([^*]+):\*/)![1]}>`);
}

// Text Slack links on its own when it is not verbatim: bare domains, www.
// hosts, emails, a URL whose scheme slackPlain() dropped, channel names.
const SLACK_AUTOLINKED = [
  "www.cruzemaps-admin.com", "cruzemaps.com.evil.io/admin", "ceo@evil.io", "https://acme.example",
  "mailto:ceo@evil.io", "#general", "@here", "tel:+15125550100",
];

Deno.test("Slack: bare domains, www., emails and channel names in row text are only ever in verbatim text", () => {
  const bad = SLACK_AUTOLINKED.join(" ");
  const notices: Notice[] = [
    pilotNotice(pilotRow({
      company_name: bad, fleet_size: bad, truck_size: bad, contact_name: bad, contact_title: bad, contact_email: bad,
      contact_phone: bad, fms_provider: bad, website: bad, application_notes: `${bad}\n${bad}`, notes: bad,
    })),
    loiNotice(loiRow({ participant_name: bad, participant_company: bad, participant_title: bad, fleet_size: bad, initials: bad })),
    contactNotice(contactRow({ name: bad, email: bad, organization: bad, message: `${bad}\n${bad}` })),
  ];
  for (const notice of notices) {
    const msg = slackMessage(notice);
    assertSlackSafe(msg);
    // The notification text and the link block hold none of the row text.
    for (const ours of [msg.text, msg.blocks[0].text.text, msg.blocks[2].text.text]) {
      for (const word of ["evil", "acme", "general", "@here", "tel:", "mailto"]) assert(!ours.includes(word), ours);
    }
    // The row text is there, scheme dropped, and only in verbatim sections.
    const rowBlocks = msg.blocks.filter((b: Row) => /www\.|evil|acme/.test(b.text.text));
    assert(rowBlocks.length >= 3, notice.title);
    for (const b of rowBlocks) assertEquals(b.text.verbatim, true, b.text.text);
    assert(rowBlocks.some((b: Row) => b.text.text.includes("www.cruzemaps-admin.com cruzemaps.com.evil.io/admin ceo@evil.io acme.example")));
    assertEquals(slackLinks(slackBody(msg)), [slackLink(notice.link.url)]);
  }
});

Deno.test("SLACK_WEBHOOK_URL alone posts the notice to Slack as escaped text", async () => {
  const row = contactRow({ name: "<!channel> & co", message: "[Reset](https://evil.example) *hi*" });
  const d = fake({ env: SLACK_ENV, rows: { contact_messages: row } });
  const { status, body } = await call(d, { type: "INSERT", table: "contact_messages", record: { id: ID } });
  assertEquals(status, 200);
  assertEquals(body, { ok: true, table: "contact_messages" });
  assertEquals(d.posts.map((p) => p.url), ["https://slack.invalid/hook"]);
  const msg = d.posts[0].body;
  assertEquals(Object.keys(msg), ["text", "blocks"]);
  // The notification text is ours alone.
  assertEquals(msg.text, `New contact message: <${ADMIN_MESSAGES_URL}|Admin tab>`);
  assertSlackSafe(msg);
  const lines = slackBody(msg).split("\n");
  assertEquals(lines[0], "New contact message");
  assert(lines.includes("*Name:* &lt;!channel&gt; &amp; co"));
  // Our link is the third block, above everything the sender typed.
  assertEquals(lines[2], linkLine("Admin tab", ADMIN_MESSAGES_URL));
  // The message is quoted, its URL lost its scheme, and its asterisks are
  // look-alikes that Slack does not read as bold.
  assertEquals(lines.slice(-2), ["*Message:*", "> [Reset](evil.example) \u2217hi\u2217"]);
  assertEquals(slackLinks(slackBody(msg)), [slackLink(ADMIN_MESSAGES_URL)]);
});

Deno.test("with both webhooks set the notice goes to Discord and Slack", async () => {
  const d = fake({ env: { ...ENV, ...SLACK_ENV }, rows: { loi_signatures: loiRow() } });
  const { body } = await call(d, { type: "INSERT", table: "loi_signatures", record: { id: ID } });
  assertEquals(body, { ok: true, table: "loi_signatures" });
  assertEquals(d.posts.map((p) => p.url), ["https://discord.invalid/default", "https://slack.invalid/hook"]);
  assertEquals(d.posts[0].body.embeds[0].title, "✍️ LOI signed");
  assertSlackSafe(d.posts[1].body);
  assertEquals(d.posts[1].body.text, `✍️ LOI signed: <https://cruzemaps.com/loi/${ID}|Signed LOI>`);
  const lines = slackBody(d.posts[1].body).split("\n");
  assertEquals(lines[0], "✍️ LOI signed");
  assertEquals(lines[1], "*Dana Lee* just signed the Letter of Intent.");
  assertEquals(lines[2], linkLine("Signed LOI", `https://cruzemaps.com/loi/${ID}`));
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
  // The masked link is in inline code, so Discord shows it as text.
  assertEquals(value("Applicant notes"), "`[Reset](https://evil.example)`\n\\# 40 trucks on I-35 & I-10");
  assertEquals(d.posts[0].body.allowed_mentions, { parse: [] });

  assertSlackSafe(d.posts[1].body);
  const slack = slackBody(d.posts[1].body);
  const lines = slack.split("\n");
  assert(lines.includes("*Phone:* +1 (512) 555-0100"));
  assert(lines.includes("*Title:* VP \u2217Ops\u2217 &lt;!channel&gt;"));
  assert(slack.includes("*Applicant notes:*\n> [Reset](evil.example)\n> # 40 trucks on I-35 &amp; I-10\n"));
  assertEquals(slackLinks(slack), [slackLink("https://cruzemaps.com/admin")]);
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
// A URL with a scheme. Slack also links bare domains, www. hosts and emails
// on its own; assertSlackSafe() checks that it is told not to.
const BARE_URL = /[a-z][a-z0-9+.-]*:\/\//i;

const FORGED = "\n*Admin tab:* https://evil.example\r\n> *Admin portal:* <https://evil.example|Open> *Email:* ceo@evil.example";

Deno.test("Slack: applicant text cannot forge a field or a link on a pilot application", () => {
  const cols = [
    "company_name", "fleet_size", "truck_size", "contact_name", "contact_title", "contact_email",
    "contact_phone", "fms_provider", "website", "application_notes", "notes",
  ];
  const expected = [
    "*Admin portal:*", "*Company:*", "*Fleet size:*", "*Truck class:*", "*Contact:*",
    "*Title:*", "*Email:*", "*Phone:*", "*FMS:*", "*Website:*", "*Applicant notes:*", "*Admin notes:*",
  ];
  // The forged text in one column at a time, then in all of them at once.
  const rows = [
    ...cols.map((col) => pilotRow({ contact_title: "VP", contact_phone: "555", application_notes: "Hi", notes: "x", [col]: `Acme${FORGED}` })),
    pilotRow(Object.fromEntries(cols.map((col) => [col, `Acme${FORGED}`]))),
  ];
  for (const row of rows) {
    const msg = slackMessage(pilotNotice(row));
    assertSlackSafe(msg);
    const text = slackBody(msg);
    const lines = text.split("\n");
    assertEquals(slackLabels(text), expected);
    assertEquals(lines[2], linkLine("Admin portal", "https://cruzemaps.com/admin"));
    assertEquals(slackLinks(text), [slackLink("https://cruzemaps.com/admin")]);
    // No URL with a scheme is left; what is left is in verbatim text (assertSlackSafe).
    assert(!BARE_URL.test(text.replace(slackLink("https://cruzemaps.com/admin"), "")));
    // Each field is a block of its own, which starts with its label.
    assertEquals(slackTexts(msg).slice(3).map((t) => t.match(/^\*[^*]*\*/)?.[0]), expected.slice(1));
    // Past our three blocks, a line is a field of ours or a quoted line of notes.
    for (const l of lines.slice(3)) assert(/^(\*[A-Za-z ]+:\*( |$)|> |>$)/.test(l), l);
  }
  // A one-line value stays on its field's line.
  const one = slackBody(slackMessage(pilotNotice(pilotRow({ contact_title: `VP${FORGED}` }))));
  assert(one.split("\n").some((l) => l.startsWith("*Title:* VP ∗Admin tab:∗ evil.example &gt; ")), one);
});

Deno.test("Slack: contact and LOI text cannot forge a field or a link either", () => {
  const contactMsg = slackMessage(contactNotice(contactRow({
    name: `Dana${FORGED}`, email: `d@x.example${FORGED}`, organization: `Acme${FORGED}`, message: `Hello${FORGED}`,
  })));
  assertSlackSafe(contactMsg);
  const contact = slackBody(contactMsg);
  assertEquals(slackLabels(contact), ["*Admin tab:*", "*Name:*", "*Organization:*", "*Email:*", "*Message:*"]);
  assertEquals(slackLinks(contact), [slackLink(ADMIN_MESSAGES_URL)]);
  assert(!BARE_URL.test(contact.replace(slackLink(ADMIN_MESSAGES_URL), "")));

  const loiMsg = slackMessage(loiNotice(loiRow({
    participant_name: `Dana${FORGED}`, participant_company: `Acme${FORGED}`, participant_title: `COO${FORGED}`,
    fleet_size: `40${FORGED}`, initials: `DL${FORGED}`,
  })));
  assertSlackSafe(loiMsg);
  const loi = slackBody(loiMsg);
  const link = slackLink(`https://cruzemaps.com/loi/${ID}`);
  // The signer's name is in bold on line two; nothing in it closes the bold.
  assertEquals(slackLabels(loi), [
    loi.split("\n")[1].match(/^\*[^*]*\*/)![0], "*Signed LOI:*",
    "*Participant:*", "*Initials:*", "*Company:*", "*Fleet size:*", "*Title:*",
  ]);
  assert(loi.split("\n")[1].endsWith("* just signed the Letter of Intent."));
  assertEquals(loi.split("\n").length, 8);
  assertEquals(loiMsg.blocks.length, 8);
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
      const msg = slackMessage(notice);
      assertSlackSafe(msg);
      const text = slackBody(msg);
      const total = slackTexts(msg).join("").length;
      assert(total <= SLACK_MAX_CHARS, `${JSON.stringify(ch)} ${total}`);
      assertEquals(slackTexts(msg)[2], linkLine(notice.link.label, notice.link.url));
      assertEquals(slackLinks(text), [slackLink(notice.link.url)]);
      // Nothing was cut blind: every field is still there, the last one included.
      const last = notice.fields.filter((f) => !f.trusted).at(-1)!.name;
      assert(text.includes(`\n*${last}:*`), JSON.stringify(ch));
    }
  }
  // A long signer name cannot push the LOI link out either.
  const loi = slackMessage(loiNotice(loiRow({ participant_name: "&".repeat(9000), participant_company: "<".repeat(9000) })));
  assert(slackTexts(loi).join("").length <= SLACK_MAX_CHARS);
  assertEquals(slackTexts(loi)[2], linkLine("Signed LOI", `https://cruzemaps.com/loi/${ID}`));
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
