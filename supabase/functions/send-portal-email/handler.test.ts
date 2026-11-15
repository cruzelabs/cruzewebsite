import { assertEquals, assertThrows } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { base64Bytes, DEFAULT_FROM, type Deps, handle, MAX_IDEMPOTENCY_KEY, parseMessage, resendSender, validIdempotencyKey } from "./handler.ts";

const SECRET = "s".repeat(48);
const ENV: Record<string, string> = { PORTAL_EMAIL_SECRET: SECRET, RESEND_API_KEY: "re_test" };
const AUTH = { "x-portal-email-secret": SECRET };
// What the portal sends: email-log-<EmailLog id>.
const KEY = "email-log-0b9f6c1e-52a7-4d0b-9c35-7e1f4a8d2c66";

function deps(env: Record<string, string> = ENV) {
  const sent: Array<Record<string, unknown>> = [];
  // The idempotency key of each provider call, undefined when the handler passed none.
  const keys: Array<string | undefined> = [];
  const d: Deps = {
    env: (n) => env[n],
    secretMatches: (a, b) => a === b,
    sendEmail: async (_key, email, idempotencyKey) => {
      sent.push(email);
      keys.push(idempotencyKey);
      return { ok: true, status: 200, id: "msg_1" };
    },
  };
  return { d, sent, keys };
}

/** A stand-in for Resend: the real sender (resendSender) over a fetch that records each request and calls nothing. */
function resend(answer: () => Response = () => Response.json({ id: "msg_1" })) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body) });
    return Promise.resolve(answer());
  }) as typeof fetch;
  const d: Deps = { ...deps().d, sendEmail: resendSender(fetchImpl) };
  return { d, calls };
}

const req = (body: unknown, headers: Record<string, string> = { "x-portal-email-secret": SECRET }, method = "POST") => {
  const raw = method === "POST" ? JSON.stringify(body) : undefined;
  return new Request("https://x.supabase.co/functions/v1/send-portal-email", { method, headers: { "Content-Type": "application/json", ...(raw ? { "Content-Length": String(new TextEncoder().encode(raw).byteLength) } : {}), ...headers }, body: raw });
};

const ok = { to: ["owner@fleet.com"], subject: "Blue Mesa invited you to Cruze", text: "Accept: https://client.cruzemaps.com/invite/abc" };

Deno.test("sends with the fixed sender and returns the provider id", async () => {
  const { d, sent } = deps();
  const r = await handle(req(ok), d);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).id, "msg_1");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].from, DEFAULT_FROM);
  assertEquals(sent[0].to, ["owner@fleet.com"]);
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
  const d: Deps = { ...deps().d, sendEmail: async () => ({ ok: false, status: 403, text: "domain not verified for owner@fleet.com" }) };
  const r = await handle(req(ok), d);
  assertEquals(r.status, 502);
  assertEquals(await r.json(), { error: "send failed", status: 403 });
});

Deno.test("checks recipients, subject, text and attachments", () => {
  assertThrows(() => parseMessage({ ...ok, to: [] }));
  assertThrows(() => parseMessage({ ...ok, to: ["not an address"] }));
  assertThrows(() => parseMessage({ ...ok, to: ["x@website-users.cruzemaps.invalid"] }));
  assertThrows(() => parseMessage({ ...ok, to: ["ops@bluemesa.example"] }));
  assertThrows(() => parseMessage({ ...ok, cc: ["a@example.com"] }));
  assertThrows(() => parseMessage({ ...ok, to: Array.from({ length: 21 }, (_, i) => `a${i}@x.com`) }));
  assertThrows(() => parseMessage({ ...ok, subject: "Hi\r\nBcc: x@y.example" }));
  assertThrows(() => parseMessage({ ...ok, subject: "" }));
  assertThrows(() => parseMessage({ ...ok, text: "" }));
  assertThrows(() => parseMessage({ ...ok, attachments: [{ filename: "../x.pdf", contentBase64: "QUJD" }] }));
  assertThrows(() => parseMessage({ ...ok, attachments: [{ filename: "x.pdf", contentBase64: "not base64!" }] }));
  assertThrows(() => parseMessage({ ...ok, attachments: [{ filename: "x.pdf", contentBase64: "QUJD", mime: "text/html; x" }] }));
  const m = parseMessage({ ...ok, cc: ["ops@fleet.com"], attachments: [{ filename: "rate-confirmation-L1.pdf", contentBase64: "QUJD", mime: "application/pdf" }] });
  assertEquals(m.cc, ["ops@fleet.com"]);
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

Deno.test("passes the caller's Idempotency-Key to the provider call, and none when the caller sent none", async () => {
  const { d, sent, keys } = deps();
  assertEquals((await handle(req(ok, { ...AUTH, "Idempotency-Key": KEY }), d)).status, 200);
  // An older portal sends no header: the email goes out as before.
  assertEquals((await handle(req(ok), d)).status, 200);
  assertEquals(keys, [KEY, undefined]);
  assertEquals(sent.length, 2);
  // The key is not part of the email.
  assertEquals(sent[0], sent[1]);
});

Deno.test("the request to Resend carries the key in the Idempotency-Key header, and only there", async () => {
  const { d, calls } = resend();
  const r = await handle(req(ok, { ...AUTH, "Idempotency-Key": KEY }), d);
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { id: "msg_1" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.resend.com/emails");
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers.get("Idempotency-Key"), KEY);
  assertEquals(calls[0].headers.get("Authorization"), "Bearer re_test");
  assertEquals(calls[0].headers.get("Content-Type"), "application/json");
  assertEquals(JSON.parse(calls[0].body), { from: DEFAULT_FROM, to: ok.to, subject: ok.subject, text: ok.text });
  // The shared secret stays here.
  assertEquals(calls[0].headers.has("x-portal-email-secret"), false);
});

Deno.test("without the header the request to Resend has no Idempotency-Key", async () => {
  const { d, calls } = resend();
  const r = await handle(req(ok), d);
  assertEquals(r.status, 200);
  assertEquals(await r.json(), { id: "msg_1" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].headers.has("Idempotency-Key"), false);
  assertEquals([...calls[0].headers.keys()].sort(), ["authorization", "content-type"]);
});

Deno.test("a retry gives Resend the same key and the same body, so Resend can match it to the first send", async () => {
  const { d, calls } = resend();
  const message = { ...ok, cc: ["ops@fleet.com"], attachments: [{ filename: "a.pdf", contentBase64: "QUJD", mime: "application/pdf" }] };
  assertEquals((await handle(req(message, { ...AUTH, "Idempotency-Key": KEY }), d)).status, 200);
  assertEquals((await handle(req(message, { ...AUTH, "Idempotency-Key": KEY }), d)).status, 200);
  assertEquals(calls.length, 2);
  assertEquals(calls[1].headers.get("Idempotency-Key"), calls[0].headers.get("Idempotency-Key"));
  assertEquals(calls[1].body, calls[0].body);
});

Deno.test("an invalid Idempotency-Key is a 400 before the body is read and before any provider call", async () => {
  const { d, calls } = resend();
  const invalid: Record<string, string> = {
    "empty": "",
    "only spaces": "   ",
    "too long": "k".repeat(MAX_IDEMPOTENCY_KEY + 1),
    "a tab inside": "email-log\t1",
    "a control character": "email-log-\x1f1",
    "DEL": "email-log-\x7f1",
    "a Latin-1 letter": "cl\xe9-1",
    // The bytes of a UTF-8 check mark, as a header value arrives.
    "UTF-8 bytes": "email-log-\xe2\x9c\x93",
  };
  for (const [name, key] of Object.entries(invalid)) {
    const request = req(ok, { ...AUTH, "Idempotency-Key": key });
    const r = await handle(request, d);
    assertEquals(r.status, 400, name);
    assertEquals(await r.json(), { error: "idempotency key must be 1 to 256 printable ASCII characters" }, name);
    assertEquals(request.bodyUsed, false, name);
  }
  // The key is checked first: a body that would be a 422 on its own is still a 400.
  assertEquals((await handle(req({ ...ok, to: [] }, { ...AUTH, "Idempotency-Key": "" }), d)).status, 400);
  assertEquals((await handle(req({ ...ok, to: [] }, { ...AUTH, "Idempotency-Key": KEY }), d)).status, 422);
  assertEquals(calls.length, 0);
});

Deno.test("accepts a key of 1 and of 256 printable ASCII characters and forwards it unchanged", async () => {
  const { d, calls } = resend();
  // Every printable ASCII character, space to ~. A header value has no leading or trailing space, so the space is inside.
  const printable = "k" + Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).join("") + "k";
  const valid = ["k", "k".repeat(MAX_IDEMPOTENCY_KEY), printable];
  for (const key of valid) assertEquals((await handle(req(ok, { ...AUTH, "Idempotency-Key": key }), d)).status, 200, key);
  assertEquals(calls.map((c) => c.headers.get("Idempotency-Key")), valid);
});

Deno.test("validIdempotencyKey takes 1 to 256 printable ASCII characters and nothing that could split a header", () => {
  assertEquals(MAX_IDEMPOTENCY_KEY, 256);
  assertEquals(validIdempotencyKey(KEY), true);
  assertEquals(validIdempotencyKey("a b"), true);
  assertEquals(validIdempotencyKey("k".repeat(256)), true);
  assertEquals(validIdempotencyKey("k".repeat(257)), false);
  assertEquals(validIdempotencyKey(""), false);
  // A Request cannot carry these, so they are checked here.
  assertEquals(validIdempotencyKey("a\r\nX-Injected: 1"), false);
  assertEquals(validIdempotencyKey("a\nb"), false);
  assertEquals(validIdempotencyKey("a\n"), false);
  assertEquals(validIdempotencyKey("a\0b"), false);
  assertEquals(validIdempotencyKey("email-log-" + String.fromCodePoint(0x2713)), false);
});

Deno.test("the secret check runs before the key check", async () => {
  const { d, sent } = deps();
  // Without the secret a caller gets 401 for any key, so it learns nothing about what a valid key is.
  for (const key of ["", "k".repeat(MAX_IDEMPOTENCY_KEY + 1), KEY]) {
    assertEquals((await handle(req(ok, { "Idempotency-Key": key }), d)).status, 401);
    assertEquals((await handle(req(ok, { "x-portal-email-secret": "wrong", "Idempotency-Key": key }), d)).status, 401);
  }
  // Closed while the secret or the Resend key is unset, and a GET is still a 405, whatever the key.
  assertEquals((await handle(req(ok, { ...AUTH, "Idempotency-Key": "" }), deps({ RESEND_API_KEY: "re_test" }).d)).status, 503);
  assertEquals((await handle(req(ok, { ...AUTH, "Idempotency-Key": "" }), deps({ PORTAL_EMAIL_SECRET: SECRET }).d)).status, 503);
  assertEquals((await handle(req(ok, { ...AUTH, "Idempotency-Key": "" }, "GET"), d)).status, 405);
  // The same bad key is a 400 only once the secret matches.
  assertEquals((await handle(req(ok, { ...AUTH, "Idempotency-Key": "" }), d)).status, 400);
  assertEquals(sent.length, 0);
});

Deno.test("a key Resend refuses comes back as a 502 with its status only", async () => {
  // Resend's 409: the key was used with a different message, or the first request is still running.
  const conflict = () => Response.json({ statusCode: 409, name: "invalid_idempotent_request", message: "used for owner@fleet.com" }, { status: 409 });
  const { d, calls } = resend(conflict);
  const r = await handle(req(ok, { ...AUTH, "Idempotency-Key": KEY }), d);
  assertEquals(r.status, 502);
  assertEquals(await r.json(), { error: "send failed", status: 409 });
  assertEquals(calls.length, 1);
});

Deno.test("a 2xx from Resend without a JSON id is a failure", async () => {
  for (const answer of [() => new Response("ok"), () => Response.json({}), () => Response.json(null)]) {
    const { d } = resend(answer);
    const r = await handle(req(ok, { ...AUTH, "Idempotency-Key": KEY }), d);
    assertEquals(r.status, 502);
    assertEquals(await r.json(), { error: "send failed", status: 200 });
  }
});
