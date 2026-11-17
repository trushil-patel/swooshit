import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export const BUCKET = "swooshit-later";
export class LaterError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function adminClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new LaterError("Send for later is not configured yet. Follow OFFLINE_SETUP.md; live transfer still works.", 503);
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol)) throw new Error();
  } catch {
    throw new LaterError("Send for later has an invalid SUPABASE_URL. Set the project's HTTP(S) URL and redeploy.", 503);
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Classify provider failures without exposing raw messages, credentials or URLs.
export function serviceError(error: unknown): LaterError {
  if (error instanceof LaterError) return error;
  const detail = error && typeof error === "object" ? error as { code?: string; message?: string; status?: number; statusCode?: string | number } : {};
  const code = detail.code || "";
  const message = typeof detail.message === "string" ? detail.message : "";
  const status = Number(detail.status || detail.statusCode);
  if (["PGRST202", "PGRST205", "42P01", "42883"].includes(code)) {
    return new LaterError("Send for later database setup is missing or outdated. Run supabase/offline.sql in the configured project's SQL Editor, then retry.", 503);
  }
  if ([401, 403].includes(status) || ["PGRST301", "PGRST302", "42501"].includes(code) || /invalid api key|invalid jwt|jwt expired/i.test(message)) {
    return new LaterError("Send for later cannot access Supabase. Check that SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY belong to the same project and that the backend has database/storage permissions, then redeploy.", 503);
  }
  if (code === "NoSuchBucket" || /bucket not found/i.test(message)) {
    return new LaterError("Send for later storage is not set up. Run supabase/offline.sql to create the private swooshit-later bucket, then retry.", 503);
  }
  if (/fetch failed|failed to fetch|network|timeout|timed out|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return new LaterError("Send for later cannot reach Supabase. Check the project URL, project availability and server network connection, then retry.", 503);
  }
  return new LaterError("Send for later is temporarily unavailable. Retry shortly; if it persists, check the Supabase project and backend setup.", 503);
}
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function requireOwner(row: { sender_id: string; receiver_id: string } | null, id: string, role: "sender" | "receiver") {
  if (!row || row[`${role}_id`] !== id) throw new LaterError("Transfer not found.", 404);
}
export function validPublicKey(key: JsonWebKey) {
  return key?.kty === "RSA" && key.e === "AQAB" && typeof key.n === "string" && /^[A-Za-z0-9_-]{342}$/.test(key.n) && !key.d;
}
