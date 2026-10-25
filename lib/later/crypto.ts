export const LATER_MAX_BYTES = 25 * 1024 * 1024;
const aad = new TextEncoder().encode("swooshit-later-v1");
export type Envelope = { version: 1; iv: string; key: string };
export type LocalIdentity = { token: string; privateKey: JsonWebKey; publicKey: JsonWebKey };

export function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export async function createIdentity(): Promise<LocalIdentity> {
  const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  return {
    token: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""),
    privateKey: await crypto.subtle.exportKey("jwk", keys.privateKey),
    publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey),
  };
}
export async function encryptFile(file: File, recipient: JsonWebKey, kind: "file" | "text") {
  if (file.size > LATER_MAX_BYTES) throw new Error("Send for later supports up to 25 MiB per item.");
  const header = new TextEncoder().encode(JSON.stringify({ name: file.name, mime: file.type, kind }));
  if (header.length > 4096) throw new Error("Filename is too long.");
  const payload = new Uint8Array(4 + header.length + file.size);
  new DataView(payload.buffer).setUint32(0, header.length);
  payload.set(header, 4);
  payload.set(new Uint8Array(await file.arrayBuffer()), 4 + header.length);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const publicKey = await crypto.subtle.importKey("jwk", recipient, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, await crypto.subtle.exportKey("raw", key));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, payload);
  return { blob: new Blob([encrypted], { type: "application/octet-stream" }), envelope: { version: 1, iv: toBase64(iv), key: toBase64(new Uint8Array(wrapped)) } as Envelope };
}
export async function decryptFile(data: ArrayBuffer, envelope: Envelope, identity: LocalIdentity) {
  if (envelope.version !== 1 || data.byteLength > LATER_MAX_BYTES + 8192) throw new Error("Unsupported encrypted item.");
  const privateKey = await crypto.subtle.importKey("jwk", identity.privateKey, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const rawKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, fromBase64(envelope.key));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(envelope.iv), additionalData: aad }, key, data);
  if (bytes.byteLength < 4) throw new Error("Invalid encrypted file.");
  const length = new DataView(bytes).getUint32(0);
  if (length > 4096 || 4 + length > bytes.byteLength) throw new Error("Invalid file metadata.");
  const info = JSON.parse(new TextDecoder().decode(bytes.slice(4, 4 + length)));
  if (typeof info.name !== "string" || typeof info.mime !== "string" || !["file", "text"].includes(info.kind)) throw new Error("Invalid file metadata.");
  const safeName = info.name.replace(/[\\/\u0000-\u001f]/g, "_") || "download";
  return { file: new File([bytes.slice(4 + length)], safeName, { type: info.mime }), kind: info.kind as "file" | "text" };
}
