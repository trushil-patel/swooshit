import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { adminClient, BUCKET, hash, LaterError, LaterProviderError, serviceDiagnostic, requireOwner, serviceError, validPublicKey } from "../../../lib/later/server";
import { LATER_MAX_BYTES } from "../../../lib/later/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  try {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
    if (!/^[a-f0-9]{64}$/.test(token)) throw new LaterError("Invalid device credential.", 401);
    const raw = await request.text();
    if (raw.length > 8192) throw new LaterError("Request too large.", 413);
    let body;
    try { body = JSON.parse(raw); } catch { throw new LaterError("Invalid request."); }
    if (!body || typeof body.action !== "string") throw new LaterError("Invalid request.");
    const db = adminClient();
    const tokenHash = hash(token);
    const limit = async (bucket: string, maximum: number) => {
      const result = await db.rpc("dl_take_limit", { bucket_key: bucket, maximum });
      if (result.error) throw new LaterProviderError("rate-limit", result.error, result.status);
      if (!result.data) throw new LaterError("Daily limit reached. Please try tomorrow.", 429);
    };
    const day = new Date().toISOString().slice(0, 10);
    if (body.action === "register") {
      if (!validPublicKey(body.publicKey)) throw new LaterError("Invalid device public key.");
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
      await limit(`register:${hash(ip + process.env.SUPABASE_SERVICE_ROLE_KEY)}:${day}`, 100);
      const result = await db.rpc("dl_register", { token_hash_value: tokenHash, public_key_value: body.publicKey });
      if (result.error) throw new LaterProviderError("register", result.error, result.status);
      return NextResponse.json(result.data, { headers });
    }
    const deviceResult = await db.from("dl_devices").select("id,code").eq("token_hash", tokenHash).maybeSingle();
    if (deviceResult.error) throw new LaterProviderError("device-lookup", deviceResult.error, deviceResult.status);
    const device = deviceResult.data;
    if (!device) throw new LaterError("Open Send for later on this device to register its inbox.", 401);
    await limit(`api:${device.id}:${day}`, 5000);
    if (body.action === "lookup") {
      await limit(`lookup:${device.id}:${day}`, 100);
      if (!/^\d{6}$/.test(body.code)) throw new LaterError("Enter a six-digit inbox code.");
      const result = await db.from("dl_devices").select("code,public_key").eq("code", body.code).maybeSingle();
      if (result.error) throw new LaterProviderError("recipient-lookup", result.error, result.status);
      if (!result.data) throw new LaterError("Inbox not found. The receiver must open Send for later once and share its inbox code.", 404);
      if (result.data.code === device.code) throw new LaterError("Enter another device's inbox code.");
      return NextResponse.json(result.data, { headers });
    }
    if (body.action === "prepare") {
      const envelope = body.envelope;
      if (!/^\d{6}$/.test(body.code) || !Number.isSafeInteger(body.size) || body.size < 20 || body.size > LATER_MAX_BYTES + 8192 || !["file", "text"].includes(body.kind)
        || envelope?.version !== 1 || !/^[A-Za-z0-9+/]{16}$/.test(envelope.iv) || !/^[A-Za-z0-9+/]{342}==$/.test(envelope.key)) throw new LaterError("Invalid encrypted transfer.");
      const result = await db.rpc("dl_reserve", { sender: device.id, receiver_code: body.code, encryption: envelope, byte_count: body.size, item_kind: body.kind });
      if (result.error) {
        if (result.error.code === "P0001") throw new LaterError("Cannot queue transfer. Check the recipient code or daily/inbox limits.", 409);
        throw new LaterProviderError("reserve", result.error, result.status);
      }
      const item = result.data;
      const upload = await db.storage.from(BUCKET).createSignedUploadUrl(item.object_path, { upsert: false });
      if (upload.error || !upload.data) throw new LaterProviderError("upload-ticket", upload.error);
      return NextResponse.json({ id: item.id, uploadUrl: upload.data.signedUrl }, { headers });
    }
    if (body.action === "inbox") {
      const result = await db.from("dl_transfers").select("id,sender_code,kind,byte_count,created_at,expires_at").eq("receiver_id", device.id).eq("status", "ready").gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(50);
      if (result.error) throw new LaterProviderError("inbox", result.error, result.status);
      return NextResponse.json({ items: result.data }, { headers });
    }
    if (!["commit", "download", "complete", "reject"].includes(body.action) || typeof body.id !== "string" || !/^[a-f0-9-]{36}$/.test(body.id)) throw new LaterError("Invalid action.");
    const result = await db.from("dl_transfers").select("*").eq("id", body.id).maybeSingle();
    if (result.error) throw new LaterProviderError("transfer-lookup", result.error, result.status);
    const item = result.data;
    requireOwner(item, device.id, body.action === "commit" ? "sender" : "receiver");
    if (new Date(item.expires_at).getTime() <= Date.now()) throw new LaterError("This transfer has expired.", 410);
    if (body.action === "commit") {
      if (item.status === "ready") return NextResponse.json({ ok: true }, { headers });
      if (item.status !== "uploading") throw new LaterError("Transfer is not awaiting upload.", 409);
      const stored = await db.storage.from(BUCKET).info(item.object_path);
      if (stored.error || Number(stored.data?.size) !== Number(item.byte_count)) throw new LaterError("Upload is incomplete. Keep this page open and retry.", 409);
      const update = await db.from("dl_transfers").update({ status: "ready" }).eq("id", item.id).eq("status", "uploading");
      if (update.error) throw new LaterProviderError("commit", update.error, update.status);
      return NextResponse.json({ ok: true }, { headers });
    }
    if (item.status !== "ready") throw new LaterError("Transfer is no longer pending.", 409);
    if (body.action === "download") {
      const lifetime = Math.max(1, Math.min(60, Math.floor((new Date(item.expires_at).getTime() - Date.now()) / 1000)));
      const signed = await db.storage.from(BUCKET).createSignedUrl(item.object_path, lifetime);
      if (signed.error || !signed.data) throw new LaterProviderError("download-ticket", signed.error);
      return NextResponse.json({ url: signed.data.signedUrl, envelope: item.envelope, size: item.byte_count }, { headers });
    }
    const update = await db.from("dl_transfers").update({ status: body.action === "complete" ? "downloaded" : "rejected" }).eq("id", item.id).eq("receiver_id", device.id).eq("status", "ready");
    if (update.error) throw new LaterProviderError("complete-or-reject", update.error, update.status);
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    const failure = serviceError(error);
    if (!(error instanceof LaterError)) {
      const reference = randomUUID();
      const diagnostic = serviceDiagnostic(error);
      // Never log raw provider messages, request bodies, keys, tokens or signed URLs.
      console.error("[later] Provider failure", { reference, ...diagnostic });
      return NextResponse.json({
        error: `${failure.message} Reference: ${reference} (${diagnostic.operation}, ${diagnostic.code}${diagnostic.status === null ? "" : `, HTTP ${diagnostic.status}`}).`,
        reference,
      }, { status: failure.status, headers });
    }
    return NextResponse.json({ error: failure.message }, { status: failure.status, headers });
  }
}
