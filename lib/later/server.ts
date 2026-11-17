import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export const BUCKET = "swooshit-later";
export class LaterError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export class LaterProviderError extends Error {
  constructor(public operation: string, public providerError: unknown, public providerStatus?: number) {
    super("Offline provider request failed");
  }
}

// Only recognized Storage identifiers may be shown; never echo arbitrary provider text.
const storageCodes = new Set([
  "NoSuchBucket", "NoSuchKey", "NoSuchUpload", "InvalidJWT", "InvalidRequest",
  "TenantNotFound", "EntityTooLarge", "InternalError", "ResourceAlreadyExists",
  "InvalidBucketName", "InvalidKey", "InvalidRange", "InvalidMimeType", "InvalidUploadId",
  "KeyAlreadyExists", "BucketAlreadyExists", "AccessDenied", "DatabaseError",
  "DatabaseTimeout", "SignatureDoesNotMatch", "ExpiredToken", "InvalidSignature",
]);

export function serviceDiagnostic(error: unknown) {
  const provider = error instanceof LaterProviderError ? error.providerError : error;
  const detail = provider && typeof provider === "object" ? provider as { code?: unknown; status?: unknown; statusCode?: unknown } : {};
  const status = Number(error instanceof LaterProviderError ? error.providerStatus ?? detail.status ?? detail.statusCode : detail.status ?? detail.statusCode);
  return {
    operation: error instanceof LaterProviderError ? error.operation : "request",
    code: typeof detail.code === "string" && (/^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(detail.code) || storageCodes.has(detail.code)) ? detail.code : "UNKNOWN",
    status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : null,
  };
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
  const provider = error instanceof LaterProviderError ? error.providerError : error;
  const detail = provider && typeof provider === "object" ? provider as { code?: string; message?: string; status?: number; statusCode?: string | number } : {};
  const code = detail.code || "";
  const message = typeof detail.message === "string" ? detail.message : "";
  const status = Number(error instanceof LaterProviderError ? error.providerStatus ?? detail.status ?? detail.statusCode : detail.status ?? detail.statusCode);
  if (code === "P0001" && message === "Device key mismatch") {
    return new LaterError("This browser's encryption key does not match its registered inbox. Use the original browser/profile for existing transfers; do not clear its site data.", 409);
  }
  if (code === "P0001" && message === "Registration limit reached") {
    return new LaterError("The daily limit for new inboxes has been reached. Try again tomorrow.", 429);
  }
  if (["PGRST202", "PGRST205", "42P01", "42883"].includes(code)) {
    return new LaterError("Send for later database setup is missing or outdated. Run supabase/offline.sql in the configured project's SQL Editor, then retry.", 503);
  }
  if ([401, 403].includes(status) || ["PGRST301", "PGRST302", "42501", "AccessDenied", "InvalidJWT", "SignatureDoesNotMatch"].includes(code) || /invalid api key|invalid jwt|jwt expired/i.test(message)) {
    return new LaterError("Send for later cannot access Supabase. Check that SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY belong to the same project and that the backend has database/storage permissions, then redeploy.", 503);
  }
  if (code === "NoSuchBucket" || /bucket not found/i.test(message)) {
    return new LaterError("Send for later storage is not set up. Run supabase/offline.sql to create the private swooshit-later bucket, then retry.", 503);
  }
  if (code === "InvalidMimeType") {
    return new LaterError("Storage rejected the content type. The private swooshit-later bucket must allow application/octet-stream for encrypted files.", 503);
  }
  if (code === "DatabaseError") {
    return new LaterError("Supabase Storage could not create the upload record. Check the swooshit-later bucket and the Storage logs for a database constraint or permission failure.", 503);
  }
  if (/fetch failed|failed to fetch|network|timeout|timed out|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return new LaterError("Send for later cannot reach Supabase. Check the project URL, project availability and server network connection, then retry.", 503);
  }
  if (code === "PGRST002" || code === "PGRST000" || code === "PGRST001" || status === 502 || status === 504) {
    return new LaterError("Supabase's database API is unavailable. Check project availability and database health, then retry.", 503);
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
