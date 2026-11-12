// Rules for send-portal-email: the Client Portal (cruzelabs/REA, client and driver.cruzemaps.com) sends its email
// through this function, so the Resend key stays in this project's secrets and the portal never holds it.
//
// - Only a caller with the shared secret (header x-portal-email-secret, timing-safe compare against
//   PORTAL_EMAIL_SECRET) may send. While the secret is unset the function sends nothing (503).
// - The sender is fixed (PORTAL_FROM_ADDRESS, default "Cruze <no-reply@cruzemaps.com>"); the caller cannot set it.
// - Recipients, subject, text and attachments are checked for size and shape, and .invalid addresses
//   (the portal's placeholders for cruzemaps.com sign-ins) are refused.

export const DEFAULT_FROM = "Cruze <no-reply@cruzemaps.com>";
export const MAX_RECIPIENTS = 20;
export const MAX_SUBJECT = 300;
export const MAX_TEXT = 200_000;
export const MAX_ATTACHMENTS = 10;
// The portal takes PDFs up to 25 MiB; Resend takes 40 MB per email after base64 (28 MiB decoded is about 37 MB).
export const MAX_ATTACHMENT_BYTES = 28 * 1024 * 1024;
/** Whole request, checked before the body is read. */
export const MAX_REQUEST_BYTES = 40 * 1024 * 1024;

export interface Attachment {
  filename: string;
  contentBase64: string;
  mime?: string;
}

export interface Message {
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: Attachment[];
}

export interface SendResult {
  ok: boolean;
  status: number;
  id?: string;
  text?: string;
}

export interface Deps {
  env(name: string): string | undefined;
  secretMatches(provided: string, expected: string): boolean;
  sendEmail(apiKey: string, email: Record<string, unknown>): Promise<SendResult>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const EMAIL = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/;
const FILENAME = /^[^/\\\0\r\n]{1,200}$/;
const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

function addresses(v: unknown, field: string, required: boolean): string[] {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${field} is required`);
    return [];
  }
  if (!Array.isArray(v)) throw new Error(`${field} must be a list`);
  const out = v.map((a) => (typeof a === "string" ? a.trim() : ""));
  if (required && out.length === 0) throw new Error(`${field} is required`);
  for (const a of out) {
    if (!EMAIL.test(a) || a.length > 254) throw new Error(`${field} has an invalid address`);
    if (/\.invalid$/i.test(a)) throw new Error(`${field} has an undeliverable address`);
  }
  return out;
}

/** Decoded size of a base64 string, or -1 when it is not base64. */
export function base64Bytes(s: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return -1;
  return (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
}

export function parseMessage(body: unknown): Message {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
  const b = body as Record<string, unknown>;
  const to = addresses(b.to, "to", true);
  const cc = addresses(b.cc, "cc", false);
  if (to.length + cc.length > MAX_RECIPIENTS) throw new Error(`at most ${MAX_RECIPIENTS} recipients`);
  if (typeof b.subject !== "string" || !b.subject.trim()) throw new Error("subject is required");
  if (b.subject.length > MAX_SUBJECT || /[\r\n]/.test(b.subject)) throw new Error("subject is too long or has a line break");
  if (typeof b.text !== "string" || !b.text.trim()) throw new Error("text is required");
  if (b.text.length > MAX_TEXT) throw new Error("text is too long");
  const raw = b.attachments ?? [];
  if (!Array.isArray(raw)) throw new Error("attachments must be a list");
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments`);
  let total = 0;
  const attachments = raw.map((a) => {
    const x = (a ?? {}) as Record<string, unknown>;
    if (typeof x.filename !== "string" || !FILENAME.test(x.filename)) throw new Error("attachment filename is invalid");
    if (typeof x.contentBase64 !== "string") throw new Error("attachment content is missing");
    const n = base64Bytes(x.contentBase64);
    if (n < 0) throw new Error("attachment content is not base64");
    total += n;
    if (x.mime !== undefined && (typeof x.mime !== "string" || !MIME.test(x.mime))) throw new Error("attachment type is invalid");
    return { filename: x.filename, contentBase64: x.contentBase64, mime: x.mime as string | undefined };
  });
  if (total > MAX_ATTACHMENT_BYTES) throw new Error("attachments are too large");
  return { to, cc, subject: b.subject.trim(), text: b.text, attachments };
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const expected = deps.env("PORTAL_EMAIL_SECRET") ?? "";
  if (!expected) return json({ error: "not configured" }, 503);
  const provided = req.headers.get("x-portal-email-secret") ?? "";
  if (!provided || !deps.secretMatches(provided, expected)) return json({ error: "unauthorized" }, 401);
  const apiKey = deps.env("RESEND_API_KEY") ?? "";
  if (!apiKey) return json({ error: "not configured" }, 503);

  const length = Number(req.headers.get("content-length") ?? "");
  if (!Number.isFinite(length) || length > MAX_REQUEST_BYTES) return json({ error: "request too large" }, 413);

  let msg: Message;
  try {
    msg = parseMessage(await req.json());
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "invalid body" }, 422);
  }

  const email: Record<string, unknown> = {
    from: deps.env("PORTAL_FROM_ADDRESS") || DEFAULT_FROM,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
  };
  if (msg.cc.length) email.cc = msg.cc;
  if (msg.attachments.length) {
    email.attachments = msg.attachments.map((a) => ({ filename: a.filename, content: a.contentBase64, ...(a.mime ? { content_type: a.mime } : {}) }));
  }
  const r = await deps.sendEmail(apiKey, email);
  if (!r.ok || !r.id) {
    // Status only: the provider's body can echo addresses or the message, so it is never logged or returned.
    console.error("send-portal-email: provider refused or gave no id", r.status);
    return json({ error: "send failed", status: r.status }, 502);
  }
  return json({ id: r.id });
}
