import assert from "node:assert/strict";
import test from "node:test";
import { createIdentity, encryptFile, decryptFile, LATER_MAX_BYTES } from "../lib/later/crypto";
import { adminClient, LaterError, requireOwner, serviceError, validPublicKey } from "../lib/later/server";
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
