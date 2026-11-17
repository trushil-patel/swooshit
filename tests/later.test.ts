import assert from "node:assert/strict";
import test from "node:test";
import { createIdentity, encryptFile, decryptFile, LATER_MAX_BYTES } from "../lib/later/crypto";
import { adminClient, LaterError, LaterProviderError, serviceDiagnostic, requireOwner, serviceError, validPublicKey } from "../lib/later/server";
import { POST } from "../app/api/later/route";
import { GET as cleanup } from "../app/api/later/cleanup/route";

test("offline service errors identify setup failures without exposing provider details", () => {
  for (const code of ["PGRST202", "PGRST205", "42P01", "42883"]) {
    assert.match(serviceError({ code }).message, /database setup/);
  }
  assert.match(serviceError({ message: "Invalid API key secret-value" }).message, /SERVICE_ROLE_KEY/);
  assert.match(serviceError({ code: "42501" }).message, /permissions/);
  assert.match(serviceError({ message: "Bucket not found" }).message, /swooshit-later/);
  assert.match(serviceError(new TypeError("fetch failed at secret-url" )).message, /cannot reach/);
  assert.doesNotMatch(serviceError({ message: "secret-value" }).message, /secret-value/);
  const expected = new LaterError("Transfer not found.", 404);
  assert.equal(serviceError(expected), expected);
});

test("offline API preserves Supabase setup failures and validates configuration", async (t) => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });
  process.env.SUPABASE_URL = "not-a-url";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-key";
  assert.throws(adminClient, /invalid SUPABASE_URL/);
  process.env.SUPABASE_URL = "https://example.supabase.co";
  const request = () => new Request("https://test/api/later", {
    method: "POST", headers: { Authorization: `Bearer ${"a".repeat(64)}` },
    body: JSON.stringify({ action: "register", publicKey: { kty: "RSA", e: "AQAB", n: "a".repeat(342) } }),
  });
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ code: "PGRST202", message: "private provider details" }), {
    status: 404, headers: { "Content-Type": "application/json" },
  }));
  const response = await POST(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.match(body.error, /supabase\/offline.sql/);
  assert.doesNotMatch(body.error, /private provider details/);
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.match((await (await POST(request())).json()).error, /not configured/);
});

test("offline encryption preserves text, Unicode, empty and binary files; rejects tampering and wrong receiver", async () => {
  const receiver = await createIdentity();
  const stranger = await createIdentity();
  assert.match(receiver.token, /^[a-f0-9]{64}$/);
  assert.equal(validPublicKey(receiver.publicKey), true);
  assert.equal(validPublicKey(receiver.privateKey), false);
  for (const file of [new File(["\tcode 🚀\r\n  next\n\n"], "code.txt", { type: "text/plain" }), new File([new Uint8Array([0, 255, 128, 3])], "folder.zip", { type: "application/zip" }), new File([], "empty")]) {
    const sealed = await encryptFile(file, receiver.publicKey, "file");
    const bytes = await sealed.blob.arrayBuffer();
    const opened = await decryptFile(bytes, sealed.envelope, receiver);
    assert.equal(opened.file.name, file.name);
    assert.equal(opened.file.type, file.type);
    assert.deepEqual(new Uint8Array(await opened.file.arrayBuffer()), new Uint8Array(await file.arrayBuffer()));
    await assert.rejects(decryptFile(bytes, sealed.envelope, stranger));
    const modified = new Uint8Array(bytes.slice(0)); modified[modified.length - 1] ^= 1;
    await assert.rejects(decryptFile(modified.buffer, sealed.envelope, receiver));
  }
  const text = new File(["\t hello\n"], "snippet.txt");
  const encrypted = await encryptFile(text, receiver.publicKey, "text");
  assert.equal((await decryptFile(await encrypted.blob.arrayBuffer(), encrypted.envelope, receiver)).kind, "text");
  const huge = new File([], "huge"); Object.defineProperty(huge, "size", { value: LATER_MAX_BYTES + 1 });
  await assert.rejects(encryptFile(huge, receiver.publicKey, "file"), /25 MiB/);
});

test("private owner checks cannot be replaced with a public code or another device", () => {
  const row = { sender_id: "sender", receiver_id: "receiver" };
  requireOwner(row, "sender", "sender"); requireOwner(row, "receiver", "receiver");
  assert.throws(() => requireOwner(row, "sender", "receiver"));
  assert.throws(() => requireOwner(row, "receiver", "sender"));
  assert.throws(() => requireOwner(null, "receiver", "receiver"));
});

test("offline API and cleanup reject requests without private credentials", async () => {
  assert.equal((await POST(new Request("https://test/api/later", { method: "POST", body: JSON.stringify({ action: "inbox" }) }))).status, 401);
  assert.equal((await POST(new Request("https://test/api/later", { method: "POST", headers: { Authorization: "Bearer 123456" }, body: "{}" }))).status, 401);
  assert.equal((await cleanup(new Request("https://test/api/later/cleanup"))).status, 401);
});


test("offline diagnostics preserve HTTP status and redact arbitrary provider data", () => {
  const failure = new LaterProviderError("reserve", { message: "private token and URL", code: "42702" }, 400);
  assert.deepEqual(serviceDiagnostic(failure), { operation: "reserve", code: "42702", status: 400 });
  assert.equal(serviceDiagnostic({ code: "InvalidMimeType" }).code, "InvalidMimeType");
  assert.match(serviceError({ code: "InvalidMimeType" }).message, /application\/octet-stream/);
  assert.equal(serviceDiagnostic({ code: "secret-token", status: "private" }).code, "UNKNOWN");
  assert.match(serviceError(new LaterProviderError("reserve", { message: "private" }, 403)).message, /SERVICE_ROLE_KEY/);
  assert.equal(serviceError({ code: "P0001", message: "Registration limit reached" }).status, 429);
  assert.equal(serviceError({ code: "P0001", message: "Device key mismatch" }).status, 409);
});

test("send failures identify reserve or upload-ticket without leaking provider details", async (t) => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  t.after(() => {
    if (originalUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalUrl;
    if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-key";
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  let stage = "reserve";
  let reservations = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    let data: unknown = null;
    let status = 200;
    if (url.includes("/dl_devices")) data = { id: "device", code: "123456" };
    else if (url.includes("/dl_take_limit")) data = true;
    else if (url.includes("/storage/v1/bucket/")) {
      if (stage === "storage-bucket") { status = 400; data = { code: "NoSuchBucket", message: "private-provider-message" }; }
      else data = { id: "swooshit-later", name: "swooshit-later", public: stage === "public-bucket" };
    }
    else if (url.includes("/dl_reserve")) {
      reservations++;
      if (stage === "reserve") { status = 400; data = { code: "42702", message: "private-provider-message" }; }
      else data = { id: "transfer", object_path: "private-object/payload.bin" };
    } else if (url.includes("/storage/")) {
      status = 400; data = { statusCode: "400", code: "DatabaseError", message: "private-provider-message", error: "StorageError" };
    } else throw new Error("Unexpected request");
    return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  });
  for (stage of ["storage-bucket", "public-bucket", "reserve", "upload-ticket"]) {
    const response = await POST(new Request("https://test/api/later", {
      method: "POST", headers: { Authorization: `Bearer ${"a".repeat(64)}` },
      body: JSON.stringify({ action: "prepare", code: "654321", size: 100, kind: "file", envelope: { version: 1, iv: "a".repeat(16), key: "a".repeat(342) + "==" } }),
    }));
    assert.equal(response.status, 503);
    const body = await response.json();
    if (stage === "public-bucket") {
      assert.match(body.error, /private swooshit-later bucket/);
      assert.equal(reservations, 0);
      continue;
    }
    if (stage === "storage-bucket") {
      assert.match(body.error, /NoSuchBucket/);
      assert.equal(reservations, 0);
    }
    if (stage === "upload-ticket") assert.match(body.error, /DatabaseError/);
    assert.match(body.error, new RegExp(stage));
    assert.match(body.reference, /^[a-f0-9-]{36}$/);
    assert.doesNotMatch(JSON.stringify(body), /private-provider-message|private-object|test-server-key/);
  }
  assert.equal(logs.length, 3);
  assert.equal(reservations, 2);
  assert.doesNotMatch(JSON.stringify(logs), /private-provider-message|private-object|test-server-key/);
});
