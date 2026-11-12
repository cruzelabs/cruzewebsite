import { assertEquals, assertThrows } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { base64Bytes, DEFAULT_FROM, type Deps, handle, parseMessage } from "./handler.ts";

const SECRET = "s".repeat(48);
const ENV: Record<string, string> = { PORTAL_EMAIL_SECRET: SECRET, RESEND_API_KEY: "re_test" };

function deps(env: Record<string, string> = ENV) {
  const sent: Array<Record<string, unknown>> = [];
  const d: Deps = {
    env: (n) => env[n],
    secretMatches: (a, b) => a === b,
    sendEmail: async (_key, email) => {
      sent.push(email);
      return { ok: true, status: 200, id: "msg_1" };
    },
  };
  return { d, sent };
}

const req = (body: unknown, headers: Record<string, string> = { "x-portal-email-secret": SECRET }, method = "POST") => {
  const raw = method === "POST" ? JSON.stringify(body) : undefined;
  return new Request("https://x.supabase.co/functions/v1/send-portal-email", { method, headers: { "Content-Type": "application/json", ...(raw ? { "Content-Length": String(new TextEncoder().encode(raw).byteLength) } : {}), ...headers }, body: raw });
};

const ok = { to: ["owner@fleet.example"], subject: "Blue Mesa invited you to Cruze", text: "Accept: https://client.cruzemaps.com/invite/abc" };

Deno.test("sends with the fixed sender and returns the provider id", async () => {
  const { d, sent } = deps();
  const r = await handle(req(ok), d);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).id, "msg_1");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].from, DEFAULT_FROM);
  assertEquals(sent[0].to, ["owner@fleet.example"]);
  assertEquals(sent[0].cc, undefined);
});

Deno.test("the caller cannot choose the sender", async () => {
  const { d, sent } = deps();
  await handle(req({ ...ok, from: "Boss <ceo@cruzemaps.com>" }), d);
  assertEquals(sent[0].from, DEFAULT_FROM);
});

Deno.test("refuses without, or with a wrong, secret, and stays closed while the secret is unset", async () => {
  const { d, sent } = deps();
  assertEquals((await handle(req(ok, {}), d)).status, 401);
  assertEquals((await handle(req(ok, { "x-portal-email-secret": "wrong" }), d)).status, 401);
  const closed = deps({ RESEND_API_KEY: "re_test" });
  assertEquals((await handle(req(ok, { "x-portal-email-secret": "" }), closed.d)).status, 503);
  assertEquals((await handle(req(ok), closed.d)).status, 503);
  assertEquals((await handle(req(ok, undefined, "GET"), d)).status, 405);
  assertEquals(sent.length, 0);
});

Deno.test("is closed without the Resend key", async () => {
  const { d, sent } = deps({ PORTAL_EMAIL_SECRET: SECRET });
  assertEquals((await handle(req(ok), d)).status, 503);
  assertEquals(sent.length, 0);
});

Deno.test("a provider refusal is a 502 with its status only", async () => {
  const d: Deps = { ...deps().d, sendEmail: async () => ({ ok: false, status: 403, text: "domain not verified for owner@fleet.example" }) };
  const r = await handle(req(ok), d);
  assertEquals(r.status, 502);
  assertEquals(await r.json(), { error: "send failed", status: 403 });
});

Deno.test("checks recipients, subject, text and attachments", () => {
  assertThrows(() => parseMessage({ ...ok, to: [] }));
  assertThrows(() => parseMessage({ ...ok, to: ["not an address"] }));
  assertThrows(() => parseMessage({ ...ok, to: ["x@website-users.cruzemaps.invalid"] }));
  assertThrows(() => parseMessage({ ...ok, to: Array.from({ length: 21 }, (_, i) => `a${i}@x.example`) }));
  assertThrows(() => parseMessage({ ...ok, subject: "Hi\r\nBcc: x@y.example" }));
  assertThrows(() => parseMessage({ ...ok, subject: "" }));
  assertThrows(() => parseMessage({ ...ok, text: "" }));
  assertThrows(() => parseMessage({ ...ok, attachments: [{ filename: "../x.pdf", contentBase64: "QUJD" }] }));
  assertThrows(() => parseMessage({ ...ok, attachments: [{ filename: "x.pdf", contentBase64: "not base64!" }] }));
  assertThrows(() => parseMessage({ ...ok, attachments: [{ filename: "x.pdf", contentBase64: "QUJD", mime: "text/html; x" }] }));
  const m = parseMessage({ ...ok, cc: ["ops@fleet.example"], attachments: [{ filename: "rate-confirmation-L1.pdf", contentBase64: "QUJD", mime: "application/pdf" }] });
  assertEquals(m.cc, ["ops@fleet.example"]);
  assertEquals(m.attachments.length, 1);
});

Deno.test("passes attachments to Resend as base64 content", async () => {
  const { d, sent } = deps();
  await handle(req({ ...ok, attachments: [{ filename: "a.pdf", contentBase64: "QUJD", mime: "application/pdf" }] }), d);
  assertEquals(sent[0].attachments, [{ filename: "a.pdf", content: "QUJD", content_type: "application/pdf" }]);
});

Deno.test("base64Bytes", () => {
  assertEquals(base64Bytes("QUJD"), 3);
  assertEquals(base64Bytes("QUI="), 2);
  assertEquals(base64Bytes("QQ=="), 1);
  assertEquals(base64Bytes("abc"), -1);
});

Deno.test("a success without a message id counts as a failure", async () => {
  const d: Deps = { ...deps().d, sendEmail: async () => ({ ok: true, status: 200 }) };
  assertEquals((await handle(req(ok), d)).status, 502);
});

Deno.test("refuses a request over the size cap before reading it", async () => {
  const { d, sent } = deps();
  assertEquals((await handle(req(ok, { "x-portal-email-secret": SECRET, "Content-Length": String(41 * 1024 * 1024) }), d)).status, 413);
  assertEquals(sent.length, 0);
});
