// Request handling for the notify-discord edge function, kept free of network
// and Supabase imports so it can be unit tested with `deno test` (see
// handler.test.ts). index.ts wires in the real database and webhook calls.
//
// The notice goes to Discord, to Slack, or to both, depending on which webhook
// secrets are set. The function keeps its name because the database triggers
// call it by URL.
//
// The function is called by database webhook triggers with no auth header, so
// anyone on the internet can POST to it. It therefore trusts only `type`,
// `table` and `record.id` from the payload. Everything that is posted is
// read back from the database by id with the service role, and:
//   - only INSERTs on pilot_applications, loi_signatures and contact_messages
//   - only rows created in the last 10 minutes (and not dated in the future)
//   - each row is posted at most once (public.discord_notifications_sent,
//     migration 020), so a captured payload cannot be replayed
//   - more than 10 contact messages in 10 minutes posts one summary note per
//     10-minute window instead of one embed per message
//   - allowed_mentions is empty, so text like @everyone never pings, and user
//     text is markdown-escaped so it cannot form masked links, headings or
//     lists. Applicant text that looks like a URL (a scheme, www., or a host
//     with a path) is put in inline code, where Discord does not link it, so
//     the only link Discord shows is the embed's own url, which is ours
//   - the Discord embed is kept under Discord's 6000-character total by
//     shortening row text, notes first
//   - the Slack copy is Block Kit. Every text object that holds row text is
//     mrkdwn with verbatim: true, which per Slack's docs turns off its
//     automatic linking of URLs, bare domains, emails and channel names, and
//     the row text is escaped (&, < and >) so it cannot write a <link> or a
//     <!channel> mention by hand. Row text cannot start a line or turn bold on
//     its own, so it cannot pose as a field
//   - a Slack notification shows only our text. The first block is ours alone
//     (the notice kind, our description and the admin link, an explicit
//     <url|text> link) and is the only block with a top-level text field,
//     which is what Slack's desktop notification reads. Row text follows in
//     context blocks, which have no such field. The plain `text` fallback
//     (what Slack's mobile notification reads) holds only our title and the
//     link. See slackMessage()

export const TABLES = ["pilot_applications", "loi_signatures", "contact_messages"] as const;
export type Table = (typeof TABLES)[number];

// Columns read back for each table. Nothing else from the row is used.
export const COLUMNS: Record<Table, string> = {
  pilot_applications:
    "id, company_name, truck_size, fleet_size, notes, contact_name, contact_email, contact_phone, contact_title, " +
    "application_notes, fms_provider, website, created_at",
  loi_signatures:
    "id, participant_name, participant_company, participant_title, fleet_size, initials, signed_at, created_at",
  contact_messages: "id, name, email, organization, message, created_at",
};

export const FRESH_MS = 10 * 60 * 1000;
export const FUTURE_SKEW_MS = 60 * 1000;
export const CONTACT_FLOOD_WINDOW_MS = 10 * 60 * 1000;
export const CONTACT_FLOOD_LIMIT = 10;
export const CONTACT_PREVIEW_CHARS = 500;
export const SLACK_MAX_CHARS = 3000;
// Discord's limits: 1024 characters per field value, and 6000 for the title,
// description, field names, field values and footer of one embed together.
export const DISCORD_FIELD_MAX_CHARS = 1024;
export const DISCORD_EMBED_MAX_CHARS = 6000;
// When a notice is too long, multi-line text is cut first but keeps this much.
export const BLOCK_KEEP_CHARS = 200;
// Cap for row text shown in a notice's description (the LOI signer's name).
export const SUBJECT_CHARS = 200;
// Caps for the applicant's own text on a pilot application, in characters
// after escaping.
export const PILOT_PHONE_CHARS = 64;
export const PILOT_TITLE_CHARS = 128;
export const PILOT_APPLICANT_NOTES_CHARS = 1000;

export const SITE_URL = "https://cruzemaps.com";
export const ADMIN_MESSAGES_URL = `${SITE_URL}/admin?tab=messages`;

// Discord embed colors (decimal-encoded hex)
const COLOR_PILOT = 0xff8c00; // brand orange
const COLOR_LOI = 0x00b4c0; // brand cyan-teal
const COLOR_CONTACT = 0xe8590c; // brand-orange from the site palette

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

export type ClaimResult = "claimed" | "duplicate" | "error";

export interface PostResult {
  ok: boolean;
  status: number;
  text: string;
}

export interface Deps {
  env(name: string): string | undefined;
  now(): Date;
  // Re-read one row by id with the service role. `error` is set on a query
  // failure; `row` is null when no row has that id.
  loadRow(table: Table, id: string): Promise<{ row: Row | null; error?: string }>;
  // Record that `key` was posted. "duplicate" when it already was.
  claim(key: string): Promise<ClaimResult>;
  // Contact messages created at or after `sinceIso`, or null on a query error.
  countContactsSince(sinceIso: string): Promise<number | null>;
  // POST a JSON body to a Discord or Slack webhook URL.
  postWebhook(url: string, body: unknown): Promise<PostResult>;
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

  if (payload.type !== "INSERT") return json({ skipped: "not an insert" });

  const table = payload.table;
  if (!(TABLES as readonly string[]).includes(table)) {
    return json({ skipped: "unknown table" });
  }

  const id = payload.record?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return json({ error: "record.id must be a uuid" }, 400);
  }

  const discordUrl = webhookFor(table as Table, deps.env);
  const slackUrl = deps.env("SLACK_WEBHOOK_URL") || undefined;
  if (!discordUrl && !slackUrl) {
    // Opting out of both is not an error; return 200 so callers do not retry.
    return json({ skipped: `no webhook URL configured for ${table}` });
  }

  const { row, error } = await deps.loadRow(table as Table, id);
  if (error) {
    console.error(`notify-discord: could not read ${table} ${id}: ${error}`);
    return json({ error: "could not read the row" }, 500);
  }
  if (!row) return json({ skipped: "row not found" });

  const now = deps.now();
  if (!isFresh(row.created_at, now)) return json({ skipped: "row is not new" });

  const claim = await deps.claim(`${table}:${row.id}`);
  if (claim === "duplicate") return json({ skipped: "already notified" });
  if (claim === "error") return json({ error: "could not record the notification" }, 500);

  let notice: Notice;
  if (table === "contact_messages") {
    const since = new Date(now.getTime() - CONTACT_FLOOD_WINDOW_MS).toISOString();
    const recent = await deps.countContactsSince(since);
    if (recent === null) {
      // The row itself is verified, so a failed count still posts it.
      console.error("notify-discord: contact message count failed, posting the single message");
    }
    if (recent !== null && recent > CONTACT_FLOOD_LIMIT) {
      const bucket = Math.floor(now.getTime() / CONTACT_FLOOD_WINDOW_MS);
      const flood = await deps.claim(`contact_messages:flood:${bucket}`);
      if (flood !== "claimed") return json({ skipped: "flood guard" });
      notice = contactFloodNotice(recent);
    } else {
      notice = contactNotice(row);
    }
  } else if (table === "pilot_applications") {
    notice = pilotNotice(row);
  } else {
    notice = loiNotice(row);
  }

  const sends: [string, string, Row][] = [];
  if (discordUrl) sends.push(["Discord", discordUrl, discordMessage(notice)]);
  if (slackUrl) sends.push(["Slack", slackUrl, slackMessage(notice)]);

  const failed: string[] = [];
  for (const [name, url, payload] of sends) {
    const res = await deps.postWebhook(url, payload);
    if (!res.ok) {
      console.error(`notify-discord: ${name} ${res.status}: ${res.text}`);
      failed.push(`${name} ${res.status}`);
    }
  }
  if (failed.length) return json({ error: failed.join(", ") }, 500);
  return json({ ok: true, table });
}

export function webhookFor(table: Table, env: (name: string) => string | undefined): string | undefined {
  const fallback = env("DISCORD_WEBHOOK_URL") || undefined;
  if (table === "pilot_applications") return env("DISCORD_WEBHOOK_PILOTS") || fallback;
  if (table === "loi_signatures") return env("DISCORD_WEBHOOK_LOIS") || fallback;
  return env("DISCORD_WEBHOOK_CONTACT") || fallback;
}

export function isFresh(createdAt: unknown, now: Date): boolean {
  if (typeof createdAt !== "string" || !createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  const age = now.getTime() - t;
  return age <= FRESH_MS && age >= -FUTURE_SKEW_MS;
}

// A notice before it is rendered for Discord or Slack. Both copies are built
// from this, so they cannot drift apart, and each one escapes the raw text in
// its own way.
export interface NoticeField {
  name: string;
  // Raw text from the row, or our own text when `trusted` is set.
  value: unknown;
  // Shown when the value is null or blank. Default "(none)".
  empty?: string;
  // Multi-line text (notes, a message). Every other value is put on one line.
  block?: boolean;
  // Our own text (the admin link). Not escaped and never shortened.
  trusted?: boolean;
  // Cap for the escaped value. Default DISCORD_FIELD_MAX_CHARS.
  max?: number;
  inline?: boolean;
}

export interface Notice {
  title: string;
  // Raw text from the row shown in bold before the description.
  subject?: unknown;
  description: string;
  // The link staff should follow. Always ours, never from the row.
  link: { label: string; url: string };
  color: number;
  fields: NoticeField[];
  footer?: string;
  timestamp?: string;
}

// Line breaks of every kind, so none of them can start a new line in a notice.
const LINE_BREAKS = /\r\n?|[\n\v\f\u0085\u2028\u2029]/g;

// Text columns have no length limit. No notice shows more than a field's
// 1024 characters, so the rest is dropped before any escaping work is done.
// The cap can fall inside a surrogate pair (an emoji), and when what is left
// is short (the rest was whitespace, which collapses) no later cut drops the
// half, so it is dropped here.
export const RAW_MAX_CHARS = 8192;
const raw = (value: unknown) => (value == null ? "" : dropHalfPair(String(value).slice(0, RAW_MAX_CHARS)));

// Raw row text as one line.
function oneLine(value: unknown): string {
  const s = raw(value);
  return s.replace(LINE_BREAKS, " ").replace(/\s+/g, " ").trim();
}

// Raw row text that may span lines: \n is the only line break and blank lines
// do not pile up.
function manyLines(value: unknown): string {
  const s = raw(value);
  return s.replace(LINE_BREAKS, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function rawText(f: NoticeField): string {
  return f.block ? manyLines(f.value) : oneLine(f.value);
}

// Escape Discord markdown so user text shows as typed: no masked links, bold,
// code blocks, headings, quotes, lists or mention syntax. allowed_mentions
// already stops pings; this stops formatting. It does not stop Discord from
// linking a raw URL; discordText() does that.
export function plain(value: unknown): string {
  return escapeLineStarts(escapeInline(value == null ? "" : String(value)));
}

const escapeInline = (s: string) => s.replace(/[\\`*_~|<>[\]()]/g, "\\$&");
// A heading (#), a bullet or subtext (-) and a numbered item ("1. ") start a
// line in Discord markdown.
const escapeLineStarts = (s: string) =>
  s.replace(/^(\s*)([#-])/gm, "$1\\$2").replace(/^(\s*)(\d+)\.(?=\s|$)/gm, "$1$2\\.");

// A run of text with no whitespace that Discord could link, or that reads as
// a web address: a scheme (https://, discord://, any other), a www. host, or a
// host name with a path (evil.example/admin). Discord links only the first
// kind; the other two are wrapped as well so no address in applicant text
// looks like a link next to ours. Emails are left as they are: Discord does
// not link them.
const URL_LIKE = /:\/\/|(?:^|[^a-z0-9-])www\.|[a-z0-9-]\.[a-z][a-z0-9-]*\//i;

// Row text for a Discord embed: escaped like plain(), and every URL-like run
// in inline code, where Discord shows it as text, not as a link. Markdown
// escapes do not work inside inline code, so a backtick there becomes a
// look-alike (it would close the code early) and so does a backslash (so a
// backtick that opens or closes code is always one with an even number of
// backslashes before it, which cutDiscord relies on).
export function discordText(value: unknown): string {
  const s = value == null ? "" : String(value);
  const inline = s.split(/(\s+)/).map((part) =>
    URL_LIKE.test(part) ? "`" + part.replace(/`/g, "\u02cb").replace(/\\/g, "\u29f5") + "`" : escapeInline(part)
  ).join("");
  return escapeLineStarts(inline);
}

// Where the backticks that open and close inline code are in discordText()
// output: the ones not escaped by an odd run of backslashes.
function codeTicks(s: string): number[] {
  const at: number[] = [];
  for (const m of s.matchAll(/(\\*)`/g)) if (m[1].length % 2 === 0) at.push(m.index! + m[1].length);
  return at;
}

// Row text made safe for Slack mrkdwn. &, < and > are escaped the way Slack
// asks, so the text cannot form a <link> or a <!channel> mention by hand.
// Slack has no escape for its formatting characters, so *, ~ and ` become
// look-alike characters, and so does a _ at the edge of a word (a_b stays as
// typed, which keeps email addresses intact). URL schemes are dropped as well.
// This alone does not stop Slack from linking what is left (acme.example,
// www.evil.example, ceo@evil.example): slackMessage() puts the text in
// verbatim text objects for that. (The scheme pattern is bounded so a long
// run of letters stays cheap.)
export function slackPlain(value: unknown): string {
  let s = value == null ? "" : String(value);
  let before: string;
  do {
    before = s;
    s = s.replace(/[a-z][a-z0-9+.-]{0,31}:\/\//gi, "");
  } while (s !== before);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*/g, "\u2217")
    .replace(/~/g, "\u223c")
    .replace(/`/g, "\u02cb")
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g, "\uff3f");
}

// Cut escaped text to `max` characters, ending in an ellipsis. `tidy` drops
// an escape the cut left broken; half a surrogate pair is dropped too.
function cut(s: string, max: number, tidy: (head: string) => string): string {
  if (s.length <= max) return s;
  return dropHalfPair(tidy(s.slice(0, Math.max(max - 1, 0)))) + "…";
}

function dropHalfPair(s: string): string {
  return /[\ud800-\udbff]$/.test(s) ? s.slice(0, -1) : s;
}

// An odd run of backslashes at the end means the last one escaped a character
// that was cut off. An odd number of code backticks means the cut fell inside
// inline code: Discord would show the opening backtick as text and link the
// URL after it, so the cut-off code is dropped whole.
const cutDiscord = (s: string, max: number) =>
  cut(s, max, (head) => {
    let h = (/\\+$/.exec(head)?.[0].length ?? 0) % 2 ? head.slice(0, -1) : head;
    const ticks = codeTicks(h);
    if (ticks.length % 2) h = h.slice(0, ticks[ticks.length - 1]);
    return h;
  });
// Half an entity such as "&am" at the end.
const cutSlack = (s: string, max: number) => cut(s, max, (head) => head.replace(/&[a-z]{0,3}$/, ""));

interface Sized {
  text: string;
  block: boolean;
}

// Shorten row text until it adds up to at most `budget` characters. Multi-line
// values (notes, a message) give way first, down to BLOCK_KEEP_CHARS each,
// then the longest values of any kind. Values already short are left alone.
export function fitValues(
  values: Sized[],
  budget: number,
  cutTo: (s: string, max: number) => string,
): void {
  const level = (group: Sized[], floor: number) => {
    const total = values.reduce((n, v) => n + v.text.length, 0);
    if (total <= budget || !group.length) return;
    const groupTotal = group.reduce((n, v) => n + v.text.length, 0);
    const target = groupTotal - (total - budget);
    // The largest cap, at or above `floor`, that brings the group to `target`.
    let lo = floor;
    let hi = Math.max(floor, ...group.map((v) => v.text.length));
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (group.reduce((n, v) => n + Math.min(v.text.length, mid), 0) <= target) lo = mid;
      else hi = mid - 1;
    }
    for (const v of group) v.text = cutTo(v.text, lo);
  };
  level(values.filter((v) => v.block), BLOCK_KEEP_CHARS);
  level(values, 1);
}

// The notice as a Discord webhook body. Discord rejects an embed whose title,
// description, field names, field values and footer add up to more than 6000
// characters, and the row is already claimed by then, so the row text is
// shortened to fit.
export function discordMessage(n: Notice): Row {
  const subject = oneLine(n.subject);
  const description = subject
    ? `**${cutDiscord(discordText(subject), SUBJECT_CHARS)}** ${n.description}`
    : n.description;

  const sized: (Sized | null)[] = n.fields.map((f) => {
    if (f.trusted) return null;
    const text = rawText(f);
    if (!text) return null;
    return { text: cutDiscord(discordText(text), f.max ?? DISCORD_FIELD_MAX_CHARS), block: !!f.block };
  });
  const fixed = n.title.length + description.length + (n.footer?.length ?? 0) +
    n.fields.reduce((sum, f, i) => sum + f.name.length + (sized[i] ? 0 : fixedValue(f).length), 0);
  fitValues(sized.filter((v) => v !== null) as Sized[], DISCORD_EMBED_MAX_CHARS - fixed, cutDiscord);

  const embed: Row = {
    title: n.title,
    description,
    url: n.link.url,
    color: n.color,
    fields: n.fields.map((f, i) => ({
      name: f.name,
      value: sized[i]?.text ?? fixedValue(f),
      inline: !!f.inline,
    })),
  };
  if (n.footer) embed.footer = { text: n.footer, icon_url: `${SITE_URL}/logo.png` };
  if (n.timestamp) embed.timestamp = n.timestamp;
  return {
    username: "Cruzemaps",
    avatar_url: `${SITE_URL}/logo.png`,
    allowed_mentions: { parse: [] },
    embeds: [embed],
  };
}

// What a field shows when it holds our own text or nothing at all.
function fixedValue(f: NoticeField): string {
  return f.trusted ? String(f.value) : f.empty ?? "(none)";
}

// The same notice as a Slack incoming-webhook message, in Block Kit.
//
// What a Slack notification shows. Since 2026-07-13 the desktop client takes
// the text from the blocks, not from `text`:
//   "When displaying desktop notifications, Slack will extract text from the
//   top-level text field of blocks first. If no text can be extracted, the
//   message.text value will be used for the notification. Mobile
//   notifications exclusively use message.text."
//   https://docs.slack.dev/messaging/formatting-message-text/ (under "Adding
//   your blocks array"). The change was announced in
//   https://docs.slack.dev/changelog/2026/07/13/notification-changes/:
//   "Slack desktop client notifications now pull text from blocks first,
//   falling back to the top-level text field only if no text can be extracted
//   from blocks. Mobile notifications continue to exclusively use
//   message.text."
// Neither page names the block that feeds the notification or says that only
// the first one is read (both read 2026-11-13). So no block may hold row text
// in its top-level text field. A section and a header have one; a context
// block's fields are `type`, `elements` and `block_id`, with no `text`
// (https://docs.slack.dev/reference/block-kit/blocks/section-block/ and
// https://docs.slack.dev/reference/block-kit/blocks/context-block/). Hence:
//
//   - blocks[0] is a section whose text is ours alone: the title (the notice
//     kind), our description and the admin link, an explicit <url|text> link.
//     It comes first and it is the only block with a top-level text field, so
//     it is the desktop notification however many blocks Slack reads. No row
//     text and no cut can reach it
//   - everything from the row follows in context blocks, one per field, and
//     for an LOI the line with the signer's name. Each holds one mrkdwn text
//     object with verbatim: true: Slack's docs say that skips its automatic
//     linking of URLs, bare domains, emails and channel names, while an
//     explicit link written by hand would still work, which slackPlain()
//     rules out by escaping < and >. So the only link in the blocks is ours
//   - row text cannot start a line or turn bold on its own, so it cannot pose
//     as a field: every one of those blocks opens with bold of ours (a field's
//     label, or for an LOI the signer's name inside bold it cannot close), a
//     one-line value has its line breaks collapsed, a multi-line value is
//     quoted, every line behind "> ", and slackPlain() swaps the formatting
//     characters for look-alikes
//   - text: what the mobile notification shows, and what Slack shows where
//     blocks are not. It is mrkdwn that Slack links on its own, so it carries
//     only our title and the admin link, never row text
//   - row text is shortened first when the blocks together would pass 3000
//     characters
//
// Not promised by Slack's docs: that text nested in a block (`elements`) is
// never read for a notification. If a client did read it, row text could only
// follow our first block there, never come before it.
export function slackMessage(n: Notice): Row {
  const subject = oneLine(n.subject);
  const link = `*${n.link.label}:* <${n.link.url}|${n.link.url.replace(/^https:\/\//, "")}>`;
  // Our own text. A description that continues the subject ("<name> just
  // signed ...") is row text's sentence, so it goes below with the subject.
  const head = [`*${n.title}*`, ...(subject ? [] : [n.description]), link].join("\n");
  const intro = subject ? `*${cutSlack(slackPlain(subject), SUBJECT_CHARS)}* ${n.description}` : "";

  // The link is in the first block; a field that repeats it is dropped.
  const fields = n.fields.filter((f) => !(f.trusted && f.value === n.link.url));
  const sized: (Sized | null)[] = fields.map((f) => {
    if (f.trusted) return null;
    const text = rawText(f);
    if (!text) return null;
    return { text: cutSlack(slackPlain(text), f.max ?? DISCORD_FIELD_MAX_CHARS), block: !!f.block };
  });
  // A quoted line costs its "> " on top of the text; count it before fitting.
  const quote = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");
  const line = (f: NoticeField, i: number, text?: string) => {
    const v = sized[i];
    if (!v) return `*${f.name}:* ${fixedValue(f)}`;
    return v.block ? `*${f.name}:*\n${quote(text ?? v.text)}` : `*${f.name}:* ${text ?? v.text}`;
  };
  const overhead = head.length + intro.length +
    fields.reduce((sum, f, i) => sum + line(f, i, "").length, 0) +
    sized.reduce((sum, v) => sum + (v?.block ? 2 * (v.text.split("\n").length - 1) : 0), 0);
  fitValues(sized.filter((v) => v !== null) as Sized[], SLACK_MAX_CHARS - overhead, cutSlack);

  return {
    text: `${n.title}: <${n.link.url}|${n.link.label}>`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: head } },
      ...(intro ? [slackRowText(intro)] : []),
      ...fields.map((f, i) => slackRowText(line(f, i))),
    ],
  };
}

// A block that holds row text. It is a context block, whose text sits in
// `elements` and not in a top-level text field, so it is not what Slack's
// desktop notification reads; and the text object is verbatim, so Slack links
// nothing in it.
const slackRowText = (text: string): Row => ({
  type: "context",
  elements: [{ type: "mrkdwn", text, verbatim: true }],
});

const footer = (label: string, row: Row, at: unknown) =>
  `${label} ${String(row.id).slice(0, 8)} · ${new Date(at as string).toLocaleString("en-US")}`;

export function pilotNotice(row: Row): Notice {
  const fields: NoticeField[] = [
    { name: "Company", value: row.company_name, empty: "(unspecified)", inline: true },
    { name: "Fleet size", value: row.fleet_size, empty: "(unspecified)", inline: true },
    { name: "Truck class", value: row.truck_size, empty: "(unspecified)", inline: true },
  ];
  // Null, missing and blank columns add no field.
  const add = (name: string, value: unknown, more: Partial<NoticeField> = {}) => {
    if (value != null && String(value).trim() !== "") fields.push({ name, value, inline: !more.block, ...more });
  };
  add("Contact", row.contact_name);
  add("Title", row.contact_title, { max: PILOT_TITLE_CHARS });
  add("Email", row.contact_email);
  add("Phone", row.contact_phone, { max: PILOT_PHONE_CHARS });
  add("FMS", row.fms_provider);
  add("Website", row.website, { inline: false });
  // application_notes is what the applicant typed on /apply; notes is the
  // staff-only column.
  add("Applicant notes", row.application_notes, { block: true, max: PILOT_APPLICANT_NOTES_CHARS });
  add("Admin notes", row.notes, { block: true });

  return {
    title: "🚛 New pilot application",
    description: "A new fleet just submitted a pilot application.",
    link: { label: "Admin portal", url: `${SITE_URL}/admin` },
    color: COLOR_PILOT,
    fields,
    footer: footer("Application ID", row, row.created_at),
    timestamp: row.created_at,
  };
}

export function loiNotice(row: Row): Notice {
  const fields: NoticeField[] = [
    { name: "Participant", value: row.participant_name, inline: true },
    { name: "Initials", value: row.initials, inline: true },
    { name: "Company", value: row.participant_company },
    { name: "Fleet size", value: row.fleet_size, inline: true },
  ];
  if (row.participant_title) fields.push({ name: "Title", value: row.participant_title, inline: true });

  return {
    title: "✍️ LOI signed",
    subject: oneLine(row.participant_name) || "(none)",
    description: "just signed the Letter of Intent.",
    // handle() only gets here with a uuid id.
    link: { label: "Signed LOI", url: `${SITE_URL}/loi/${row.id}` },
    color: COLOR_LOI,
    fields,
    footer: footer("Signature ID", row, row.signed_at),
    timestamp: row.signed_at,
  };
}

export function contactNotice(row: Row): Notice {
  const text = manyLines(row.message);
  const preview = text.length > CONTACT_PREVIEW_CHARS
    ? dropHalfPair(text.slice(0, CONTACT_PREVIEW_CHARS)) + "…"
    : text;
  return {
    title: "New contact message",
    description: "Someone wrote in through the contact form. Reply by email and mark it handled in the admin tab.",
    link: { label: "Admin tab", url: ADMIN_MESSAGES_URL },
    color: COLOR_CONTACT,
    fields: [
      { name: "Name", value: row.name, inline: true },
      { name: "Organization", value: row.organization, inline: true },
      { name: "Email", value: row.email },
      { name: "Message", value: preview, block: true },
      { name: "Admin tab", value: ADMIN_MESSAGES_URL, trusted: true },
    ],
    footer: footer("Message ID", row, row.created_at),
    timestamp: row.created_at,
  };
}

export function contactFloodNotice(count: number): Notice {
  return {
    title: "Contact form flood guard",
    description:
      `${count} contact messages arrived in the last 10 minutes. ` +
      "New ones are not posted here one by one until the rate drops. Read them in the admin tab.",
    link: { label: "Admin tab", url: ADMIN_MESSAGES_URL },
    color: COLOR_CONTACT,
    fields: [{ name: "Admin tab", value: ADMIN_MESSAGES_URL, trusted: true }],
  };
}

// The Discord bodies, for callers and tests that want one table's embed.
export const pilotEmbed = (row: Row): Row => discordMessage(pilotNotice(row));
export const loiEmbed = (row: Row): Row => discordMessage(loiNotice(row));
export const contactEmbed = (row: Row): Row => discordMessage(contactNotice(row));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
