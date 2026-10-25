import { createIdentity, type LocalIdentity } from "./crypto";
let identityPromise: Promise<LocalIdentity> | null = null;

export function getLaterIdentity() {
  if (!identityPromise) identityPromise = (async () => {
    if (!globalThis.crypto?.subtle) throw new Error("Send for later requires HTTPS or localhost for browser encryption.");
    const saved = localStorage.getItem("swooshit-later-identity-v1");
    if (saved) {
      const identity = JSON.parse(saved) as LocalIdentity;
      if (!/^[a-f0-9]{64}$/.test(identity.token) || !identity.privateKey?.d || !identity.publicKey?.n) throw new Error("Stored inbox identity is damaged. Do not clear browser data if you need existing transfers.");
      return identity;
    }
    const identity = await createIdentity();
    // Persist before registering: never create an inbox whose private key is lost.
    localStorage.setItem("swooshit-later-identity-v1", JSON.stringify(identity));
    return identity;
  })().catch((error) => { identityPromise = null; throw error; });
  return identityPromise;
}
export async function laterApi(action: string, body: Record<string, unknown> = {}) {
  const identity = await getLaterIdentity();
  const response = await fetch("/api/later", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${identity.token}` },
    body: JSON.stringify({ action, ...body }), cache: "no-store", signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Offline transfer service unavailable.");
  return data;
}
