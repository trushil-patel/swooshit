import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export const BUCKET = "swooshit-later";
export class LaterError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new LaterError("Send for later is not configured yet. Follow OFFLINE_SETUP.md; live transfer still works.", 503);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function requireOwner(row: { sender_id: string; receiver_id: string } | null, id: string, role: "sender" | "receiver") {
  if (!row || row[`${role}_id`] !== id) throw new LaterError("Transfer not found.", 404);
}
export function validPublicKey(key: JsonWebKey) {
  return key?.kty === "RSA" && key.e === "AQAB" && typeof key.n === "string" && /^[A-Za-z0-9_-]{342}$/.test(key.n) && !key.d;
}
