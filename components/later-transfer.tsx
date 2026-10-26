"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import CodeEditor from "./code-editor";
import { getLaterIdentity, laterApi } from "../lib/later/client";
import { decryptFile, encryptFile, LATER_MAX_BYTES } from "../lib/later/crypto";
import { createFolderArchive } from "../lib/folder-archive";
import { removeTransferredFile } from "../lib/transfer-files";

type InboxItem = { id: string; sender_code: string; kind: "file" | "text"; byte_count: number; expires_at: string };
const size = (bytes: number) => `${(bytes / 1048576).toFixed(2)} MiB`;
const message = (reason: unknown) => reason instanceof Error ? reason.message : "Offline transfer failed. Please retry.";

export default function LaterTransfer({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const [code, setCode] = useState("");
  const [target, setTarget] = useState("");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<"file" | "text">("file");
  const [draft, setDraft] = useState("");
  const [received, setReceived] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const busyRef = useRef(false);
  const refresh = useCallback(async () => { const result = await laterApi("inbox"); setItems(result.items); }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      try {
        if (document.visibilityState === "visible") {
          const result = await laterApi("inbox");
          if (!stopped) setItems(result.items);
        }
      } catch (reason) { if (!stopped) setError(message(reason)); }
      if (!stopped) timer = setTimeout(poll, 30000);
    };
    void (async () => {
      try {
        // Existing inboxes check for requests even when the Live tab is selected.
        if (!active && !localStorage.getItem("swooshit-later-identity-v1")) return;
        const identity = await getLaterIdentity();
        const result = await laterApi("register", { publicKey: identity.publicKey });
        if (stopped) return;
        setCode(result.code);
        setError("");
        await poll();
      } catch (reason) { if (!stopped) setError(message(reason)); }
    })();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, retry]);

  const perform = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { await work(); } catch (reason) { setError(message(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const send = () => perform(async () => {
    if (!code) throw new Error("Wait for your inbox to be ready.");
    if (!/^\d{6}$/.test(target) || target === code) throw new Error("Enter the receiver's six-digit Send for later inbox code.");
    const batch = kind === "text" ? [new File([draft], "snippet.txt", { type: "text/plain;charset=utf-8" })] : [...files];
    if (!batch.length || (kind === "text" && !draft.length)) throw new Error("Select files or paste text first.");
    if (batch.some((file) => file.size > LATER_MAX_BYTES)) throw new Error("Each offline item must be 25 MiB or smaller. Use Live transfer for larger files.");
    const destination = await laterApi("lookup", { code: target });
    for (let index = 0; index < batch.length; index++) {
      const file = batch[index];
      setStatus(`Encrypting ${index + 1}/${batch.length}: ${file.name}`);
      const encrypted = await encryptFile(file, destination.public_key, kind);
      const ticket = await laterApi("prepare", { code: target, kind, size: encrypted.blob.size, envelope: encrypted.envelope });
      setStatus(`Uploading encrypted item ${index + 1}/${batch.length}. Keep this page open.`);
      const uploaded = await fetch(ticket.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: encrypted.blob, signal: AbortSignal.timeout(300000) });
      if (!uploaded.ok) throw new Error("Encrypted upload failed. This item has not been queued; retry it.");
      // Retry only the idempotent commit, never silently duplicate an upload.
      let committed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await laterApi("commit", { id: ticket.id }); committed = true; break; }
        catch { if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000)); }
      }
      if (!committed) throw new Error("Upload could not be confirmed as queued. Please retry; unconfirmed uploads expire automatically.");
      if (kind === "file") setFiles((current) => removeTransferredFile(current, file));
    }
    setStatus(`Queued ${batch.length} item(s) for inbox ${target}. You can close this page. The receiver has 24 hours to accept.`);
  });
  const receive = (item: InboxItem) => perform(async () => {
    setStatus("Downloading encrypted item...");
    const ticket = await laterApi("download", { id: item.id });
    const response = await fetch(ticket.url, { cache: "no-store", signal: AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error("Download failed. Please retry before this item expires.");
    const ciphertext = await response.arrayBuffer();
    if (ciphertext.byteLength !== Number(ticket.size)) throw new Error("Incomplete download. Please retry.");
    const opened = await decryptFile(ciphertext, ticket.envelope, await getLaterIdentity());
    if (opened.kind === "text") setReceived(await opened.file.text());
    else {
      const url = URL.createObjectURL(opened.file);
      const link = document.createElement("a"); link.href = url; link.download = opened.file.name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    await laterApi("complete", { id: item.id });
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setStatus(opened.kind === "text" ? "Text decrypted in your editor." : "Decrypted file handed to your browser for download. Check your downloads.");
  });
  const chooseFolder = (selected: File[]) => perform(async () => {
    if (!selected.length) return;
    if (selected.reduce((sum, file) => sum + file.size, 0) > LATER_MAX_BYTES) throw new Error("Offline folders must fit within 25 MiB including ZIP overhead. Use Live transfer for larger folders.");
    setStatus("Preparing folder ZIP locally...");
    const zip = await createFolderArchive(selected);
    if (zip.size > LATER_MAX_BYTES) throw new Error("Folder ZIP exceeds 25 MiB. Choose a smaller folder or use Live transfer.");
    setFiles((current) => [...current, zip]); setStatus("Folder ready to send later.");
  });
  if (!active) return items.length ? <div className="relative z-10 mx-auto mb-5 max-w-6xl px-5"><button onClick={onOpen} className="rounded-xl bg-cyan-300 px-4 py-3 text-slate-950">{items.length} pending Send for later request(s) — open inbox</button></div> : null;
  return <section className="relative z-10 mx-auto max-w-6xl px-5 pb-14">
    <div className="dev-console rounded-[28px] p-6">
      <h2 className="text-xl font-semibold">Send for later</h2>
      <p className="mt-2 text-sm text-slate-400">Encrypted temporary storage. The receiver can be offline. Keep the sender open until the status says Queued.</p>
      <div className="mt-5 rounded-xl bg-white/5 p-4">
        <p className="text-xs text-cyan-200">Your private inbox&apos;s public code (different from Live transfer)</p>
        <p className="mt-2 font-mono text-3xl tracking-widest">{code || "------"}</p>
        <p className="mt-2 text-xs text-slate-400">Share this code once. Keep using this browser; clearing browser data loses access to this inbox and its decryption keys.</p>
        <button disabled={!code} onClick={() => void navigator.clipboard.writeText(code).then(() => setStatus("Inbox code copied.")).catch(() => setError("Select the inbox code and copy it manually."))} className="mt-3 rounded-lg border border-cyan-300/25 px-3 py-2 text-sm text-cyan-200">Copy inbox code</button>
      </div>
      {!code && <button onClick={() => setRetry((value) => value + 1)} className="mt-3 text-sm text-cyan-200">Retry setup</button>}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="font-semibold">Queue a transfer</h3>
          <input aria-label="Receiver inbox code" value={target} onChange={(event) => setTarget(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Receiver inbox code" disabled={busy} className="mt-3 w-full rounded-xl border border-white/15 bg-black/20 px-4 py-3" />
          <div className="mt-3 flex gap-2">{(["file", "text"] as const).map((tab) => <button key={tab} disabled={busy} aria-pressed={kind === tab} onClick={() => setKind(tab)} className={`rounded-lg px-3 py-2 text-sm ${kind === tab ? "bg-cyan-300 text-slate-950" : "bg-white/5"}`}>{tab === "file" ? "Files / folder" : "Code / text"}</button>)}</div>
          {kind === "text" ? <CodeEditor label="send later / snippet.txt" value={draft} onChange={setDraft} /> : <>
            <label className="mt-4 block text-sm text-cyan-200">Choose files<input type="file" multiple disabled={busy} className="mt-2 block w-full text-xs" onChange={(event) => { const selected = Array.from(event.target.files || []); setFiles((current) => [...current, ...selected]); event.target.value = ""; }} /></label>
            <label className="mt-4 block text-sm text-cyan-200">Choose folder<input type="file" multiple {...{ webkitdirectory: "" }} disabled={busy} className="mt-2 block w-full text-xs" onChange={(event) => { const selected = Array.from(event.target.files || []); event.target.value = ""; void chooseFolder(selected); }} /></label>
            <ul className="mt-4 space-y-2">{files.map((file, index) => <li key={index} className="flex items-center gap-2 rounded-lg bg-white/5 p-2 text-xs"><span className="min-w-0 flex-1 truncate">{file.name} · {size(file.size)}</span><button disabled={busy} aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => removeTransferredFile(current, file))}>×</button></li>)}</ul>
          </>}
          <button disabled={busy || !code} onClick={() => void send()} className="mt-4 rounded-xl bg-cyan-300 px-5 py-3 font-semibold text-slate-950 disabled:opacity-50">{busy ? "Working..." : "Send for later"}</button>
          <p className="mt-2 text-xs text-slate-500">25 MiB per item · 24-hour download window · 20 items/day per sender. Folder ZIPs keep subfolders, not empty directories.</p>
        </div>
        <div>
          <div className="flex justify-between gap-3"><h3 className="font-semibold">Pending inbox ({items.length})</h3><button disabled={busy || !code} onClick={() => void perform(refresh)} className="text-sm text-cyan-200">Refresh</button></div>
          <p className="mt-2 text-xs text-slate-400">Requests refresh every 30 seconds while this tab is visible. Names and contents are encrypted until you accept.</p>
          {items.length === 0 && <p className="mt-5 text-sm text-slate-400">No pending requests.</p>}
          <ul className="mt-4 space-y-3">{items.map((item) => <li key={item.id} className="rounded-xl border border-cyan-300/25 p-4">
            <p className="text-sm">{item.kind === "text" ? "Code / text" : "File / folder ZIP"} from inbox {item.sender_code}</p>
            <p className="mt-2 text-xs text-slate-500">{size(item.byte_count)} encrypted · expires {new Date(item.expires_at).toLocaleString()}</p>
            <div className="mt-3 flex gap-3"><button disabled={busy} onClick={() => void receive(item)} className="rounded-lg bg-cyan-300 px-3 py-2 text-sm text-slate-950">Accept & {item.kind === "text" ? "open" : "download"}</button><button disabled={busy} onClick={() => void perform(async () => { await laterApi("reject", { id: item.id }); await refresh(); })} className="rounded-lg bg-white/10 px-3 py-2 text-sm">Reject</button></div>
          </li>)}</ul>
        </div>
      </div>
      {status && <p role="status" className="mt-5 text-sm text-cyan-200">{status}</p>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-red-400/15 p-3 text-sm text-red-100">{error}</p>}
      {received !== null && <CodeEditor label="received later / snippet.txt" value={received} onChange={setReceived} />}
    </div>
  </section>;
}
