"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { io, Socket } from "socket.io-client";
import CodeEditor from "./code-editor";
import ThemeSwitcher from "./theme-switcher";
import LaterTransfer from "./later-transfer";
import { getWebRtcConfig } from "../lib/webrtc-config";
import { removeTransferredFile } from "../lib/transfer-files";
import { createFolderArchive } from "../lib/folder-archive";
import {
  Check,
  Copy,
  File,
  Link2,
  ShieldCheck,
  UploadCloud,
  Wifi,
} from "lucide-react";

type SignalPayload =
  | { type: "offer" | "answer"; description: RTCSessionDescriptionInit }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

type FileInfo = { name: string; size: number };
type Request = { requestId: string; from: string; files: FileInfo[]; kind?: "files" | "text" };
const CODE_MIME = "application/x-swooshit-code";
const format = (value: number) =>
  value < 1048576
    ? `${Math.ceil(value / 1024)} KB`
    : `${(value / 1048576).toFixed(1)} MB`;
const newCode = () => String(Math.floor(100000 + Math.random() * 900000));

export default function SwooshitApp() {
  const [deliveryMode, setDeliveryMode] = useState<"live" | "later">("live");
  const [deviceCode, setDeviceCode] = useState("");
  const [targetCode, setTargetCode] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [preparingFolder, setPreparingFolder] = useState(false);
  const [folderProgress, setFolderProgress] = useState(0);
  const folderBusy = useRef(false);
  const [mode, setMode] = useState<"files" | "text">("files");
  const [draft, setDraft] = useState("");
  const [receivedText, setReceivedText] = useState<string | null>(null);
  const [status, setStatus] = useState("Starting device listener…");
  const [error, setError] = useState("");
  const [connectionWarning, setConnectionWarning] = useState("");
  const [incoming, setIncoming] = useState<Request | null>(null);
  const [progress, setProgress] = useState(0);
  const [copied, setCopied] = useState(false);
  const socket = useRef<Socket | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const peerLoading = useRef<Promise<RTCPeerConnection> | null>(null);
  const signalQueue = useRef<Promise<void>>(Promise.resolve());
  const channel = useRef<RTCDataChannel | null>(null);
  const pending = useRef<RTCIceCandidateInit[]>([]);
  const sender = useRef(false);
  const outgoingFiles = useRef<File[] | null>(null);
  const awaitingReceipt = useRef(new Map<string, { file: File; dc: RTCDataChannel }>());
  const requestRef = useRef("");
  const chunks = useRef<ArrayBuffer[]>([]);
  const metadata = useRef<{ id?: string; name: string; size: number; mime: string } | null>(
    null,
  );
  const signalUrl =
    process.env.NEXT_PUBLIC_SIGNALING_URL || "http://localhost:3001";
  const relay = useCallback(
    (payload: unknown) =>
      socket.current?.emit("signal", {
        requestId: requestRef.current,
        payload,
      }),
    [],
  );
  const sendFiles = useCallback(async (dc: RTCDataChannel, batch: File[]) => {
    try {
      setProgress(0);
      setError("");
      const total = batch.reduce((sum, file) => sum + file.size, 0);
      let sent = 0;
      for (const file of batch) {
        const id = crypto.randomUUID();
        awaitingReceipt.current.set(id, { file, dc });
        setStatus(`Sending ${file.name}...`);
        dc.send(JSON.stringify({ type: "meta", id, name: file.name, size: file.size, mime: file.type }));
        for (let offset = 0; offset < file.size; offset += 16384) {
          while (dc.bufferedAmount > 4_000_000) {
            if (dc.readyState !== "open") throw new Error("Connection closed during transfer. Please request the transfer again.");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          const chunk = await file.slice(offset, offset + 16384).arrayBuffer();
          if (dc.readyState !== "open") throw new Error("Connection closed during transfer. Please request the transfer again.");
          dc.send(chunk);
          sent += chunk.byteLength;
          setProgress(Math.round((sent / total) * 100));
        }
        dc.send(JSON.stringify({ type: "end" }));
      }
      setProgress(100);
      setStatus("Files sent");
    } catch (reason) {
      for (const [id, receipt] of awaitingReceipt.current) {
        if (receipt.dc === dc) awaitingReceipt.current.delete(id);
      }
      setError(reason instanceof Error ? reason.message : "Could not send files. Please request the transfer again.");
      setStatus("Transfer interrupted");
    }
  }, []);
  const attach = useCallback((dc: RTCDataChannel) => {
    channel.current = dc;
    dc.binaryType = "arraybuffer";
    dc.onclose = () => {
      for (const [id, receipt] of awaitingReceipt.current) {
        if (receipt.dc === dc) awaitingReceipt.current.delete(id);
      }
    };
    dc.onopen = () => {
      setStatus("Encrypted WebRTC connection ready");
      if (sender.current && outgoingFiles.current) {
        const batch = outgoingFiles.current;
        outgoingFiles.current = null;
        void sendFiles(dc, batch);
      }
    };
    dc.onmessage = ({ data }) => {
      if (typeof data === "string") {
        const m = JSON.parse(data);
        if (m.type === "received") {
          const receipt = awaitingReceipt.current.get(m.id);
          if (receipt?.dc === dc) {
            awaitingReceipt.current.delete(m.id);
            setFiles((current) => removeTransferredFile(current, receipt.file));
          }
        } else if (m.type === "meta") {
          metadata.current = m;
          chunks.current = [];
          setProgress(0);
          setStatus(`Receiving ${m.name}…`);
        } else if (m.type === "end" && metadata.current) {
          const received = metadata.current;
          const blob = new Blob(chunks.current, {
            type: metadata.current.mime,
          });
          if (blob.size !== received.size) {
            setError("The file was incomplete. Please request it again.");
            metadata.current = null;
            chunks.current = [];
            return;
          }
          const acknowledge = () => {
            if (received.id && dc.readyState === "open")
              dc.send(JSON.stringify({ type: "received", id: received.id }));
          };
          if (metadata.current.mime === CODE_MIME) {
            void blob.text().then((text) => {
              setReceivedText(text);
              setProgress(100);
              setStatus("Code received — ready to copy");
              acknowledge();
            }).catch(() => setError("Could not read received text."));
            metadata.current = null;
            chunks.current = [];
            return;
          }
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = metadata.current.name;
          link.click();
          URL.revokeObjectURL(url);
          setProgress(100);
          setStatus(`Downloaded ${metadata.current.name}`);
          acknowledge();
          metadata.current = null;
          chunks.current = [];
        }
      } else if (metadata.current) {
        chunks.current.push(data);
        // React may run this updater after the end message clears metadata.
        // Capture the values now instead of reading a mutable ref in the updater.
        const totalBytes = metadata.current.size;
        const receivedBytes = (data as ArrayBuffer).byteLength;
        setProgress((value) =>
          Math.min(
            99,
            value + (totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0),
          ),
        );
      }
    };
  }, [sendFiles]);
  const getPeer = useCallback(async () => {
    if (peer.current) return peer.current;
    if (peerLoading.current) return peerLoading.current;
    const owner = socket.current;
    peerLoading.current = (async () => {
    let config = getWebRtcConfig();
    try {
      const response = await fetch("/api/ice-servers", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.iceServers) || !data.iceServers.length)
        throw new Error(data.error || "TURN fallback configuration unavailable.");
      config = getWebRtcConfig(data.iceServers);
      setConnectionWarning("");
    } catch (reason) {
      setConnectionWarning(`${reason instanceof Error ? reason.message : "TURN fallback unavailable."} Trying direct connection only; restricted networks may not connect.`);
    }
    if (socket.current !== owner || !owner?.connected) throw new Error("Signaling disconnected. Refresh both devices and request the transfer again.");
    const pc = new RTCPeerConnection(config);
    pc.onicecandidate = (event) =>
      event.candidate &&
      relay({ type: "candidate", candidate: event.candidate.toJSON() });
    pc.ondatachannel = (event) => attach(event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        setStatus("Connection failed");
        setError(
          "Could not establish a connection. Check the Metered credential and quota, or try another network. Some institutional networks block TURN as well.",
        );
      }
    };
    peer.current = pc;
    return pc;
    })();
    try { return await peerLoading.current; }
    finally { peerLoading.current = null; }
  }, [attach, relay]);
  const handleSignal = useCallback(
    async ({ payload }: { payload: SignalPayload }) => {
      try {
        const pc = await getPeer();
        if (payload.type === "offer") {
          await pc.setRemoteDescription(payload.description);
          for (const candidate of pending.current)
            await pc.addIceCandidate(candidate);
          pending.current = [];
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          relay({ type: "answer", description: answer });
        } else if (payload.type === "answer") {
          await pc.setRemoteDescription(payload.description);
          for (const candidate of pending.current) await pc.addIceCandidate(candidate);
          pending.current = [];
        } else if (payload.type === "candidate") {
          if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
          else pending.current.push(payload.candidate);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not negotiate the secure connection.");
      }
    },
    [getPeer, relay],
  );
  useEffect(() => {
    let stored = localStorage.getItem("swooshit-device-code") || newCode();
    localStorage.setItem("swooshit-device-code", stored);
    // Read browser storage after hydration so server and initial client HTML agree.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDeviceCode(stored);
    const client = io(signalUrl, {
      transports: ["polling", "websocket"],
      upgrade: false,
    });
    socket.current = client;
    client.on("connect", () => {
      client.emit("register-device", { code: stored });
      setStatus("Registering device...");
    });
    client.on("device-ready", ({ code }: { code: string }) => {
      stored = code;
      localStorage.setItem("swooshit-device-code", code);
      setDeviceCode(code);
      setStatus("Ready to receive requests");
    });
    client.on("connect_error", () => setError("Could not connect to signaling. Check the server URL and allowed frontend origin."));
    client.on("incoming-transfer", setIncoming);
    client.on("app-error", (message: string) => {
      setError(message);
      setStatus("Transfer error ? see details below");
    });
    client.on("signal", (message) => { signalQueue.current = signalQueue.current.then(() => handleSignal(message)); });
    client.on("transfer-ready", async ({ requestId: id }) => {
      requestRef.current = id;
      if (sender.current) {
        try {
        const pc = await getPeer();
        const dc = pc.createDataChannel("swooshit-files");
        attach(dc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.current?.emit("signal", {
          requestId: id,
          payload: { type: "offer", description: offer },
        });
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "Could not start a WebRTC connection.");
        }
      }
    });
    return () => {
      client.disconnect();
      peer.current?.close();
    };
  }, [attach, getPeer, handleSignal, signalUrl]);
  const requestTransfer = () => {
    if (folderBusy.current) return setError("Wait for the folder to finish preparing.");
    if (!/^\d{6}$/.test(targetCode) || targetCode === deviceCode)
      return setError("Enter another device’s six-digit code.");
    if (mode === "files" && !files.length) return setError("Choose at least one file.");
    if (mode === "text" && !draft.length) return setError("Paste some code or text first.");
    if (!socket.current?.connected) return setError("Wait for the signaling connection before sending.");
    const batch = mode === "text"
      ? [new globalThis.File([draft], "snippet.txt", { type: CODE_MIME })]
      : [...files];
    setError("");
    sender.current = true;
    outgoingFiles.current = batch;
    socket.current?.emit("request-transfer", {
      code: targetCode,
      kind: mode,
      files: batch.map((file) => ({ name: file.name, size: file.size })),
    });
    setStatus("Request sent — waiting for receiver approval");
  };
  const accept = () => {
    if (!incoming) return;
    sender.current = false;
    outgoingFiles.current = null;
    requestRef.current = incoming.requestId;
    socket.current?.emit("accept-transfer", { requestId: incoming.requestId });
    setStatus("Request accepted — establishing secure link…");
    setIncoming(null);
  };
  const addFolder = async (selected: File[]) => {
    if (!selected.length || folderBusy.current) return;
    folderBusy.current = true;
    setPreparingFolder(true);
    setFolderProgress(0);
    setError("");
    try {
      const archive = await createFolderArchive(selected, setFolderProgress);
      setFiles((current) => [...current, archive]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not prepare this folder. Try a smaller folder or send a ZIP.");
    } finally {
      folderBusy.current = false;
      setPreparingFolder(false);
    }
  };
  const drop = useDropzone({
    onDrop: (accepted) => setFiles((current) => [...current, ...accepted]),
  });
  return (
    <main className="canvas min-h-screen">
      <div className="fixed inset-0 noise pointer-events-none" />
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-5 py-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300 text-slate-950">
            <Link2 size={20} />
          </span>
          <div>
            <h1 className="text-lg font-semibold">
              swooshit <span className="text-cyan-300">/ P2P</span>
            </h1>
            <p className="font-mono text-xs text-slate-500">
              SIMPLE DEVICE TRANSFER
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
        <span className="hidden items-center gap-2 font-mono text-xs text-emerald-300 lg:flex">
          <Wifi size={15} /> {status}
        </span>
        <ThemeSwitcher />
        </div>
      </header>
      <section className="relative z-10 mx-auto max-w-6xl px-5 pb-12 pt-8 sm:pt-14">
        <div className="max-w-3xl">
          <p className="font-mono text-xs uppercase tracking-[.24em] text-cyan-300">{"// PRIVATE_FILE_RELAY"}</p>
          <h2 className="mt-5 text-5xl font-semibold leading-[.95] tracking-[-.065em] sm:text-7xl">Send a file with <span className="text-cyan-300">one code.</span></h2>
          <p className="mt-6 max-w-2xl text-base leading-7 text-slate-400 sm:text-lg">Transfer live with WebRTC, or send encrypted files to a temporary inbox for later. No account required.</p>
          <div className="mt-8 flex flex-wrap gap-3"><span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 font-mono text-xs text-cyan-100">01 / ENTER CODE</span><span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 font-mono text-xs text-cyan-100">02 / ACCEPT REQUEST</span><span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 font-mono text-xs text-cyan-100">03 / DIRECT DOWNLOAD</span></div>
        </div>
        <div className="mt-10 grid gap-3 md:grid-cols-3"><div className="glass rounded-2xl p-4"><p className="font-mono text-xs text-cyan-300">CHOOSE_YOUR_MODE</p><p className="mt-2 text-sm text-slate-400">Live connections or encrypted temporary storage.</p></div><div className="glass rounded-2xl p-4"><p className="font-mono text-xs text-cyan-300">DEVICE_CODE</p><p className="mt-2 text-sm text-slate-400">A saved six-digit code, reassigned if already in use.</p></div><div className="glass rounded-2xl p-4"><p className="font-mono text-xs text-cyan-300">ACCEPT_ONCE</p><p className="mt-2 text-sm text-slate-400">Receiver reviews files before transfer begins.</p></div></div>
      </section>
      <nav aria-label="Delivery mode" className="relative z-10 mx-auto mb-5 flex max-w-6xl gap-3 px-5">
        <button aria-pressed={deliveryMode === "live"} onClick={() => setDeliveryMode("live")} className={`rounded-xl px-4 py-3 text-sm ${deliveryMode === "live" ? "bg-cyan-300 text-slate-950" : "glass"}`}>Live transfer</button>
        <button aria-pressed={deliveryMode === "later"} onClick={() => setDeliveryMode("later")} className={`rounded-xl px-4 py-3 text-sm ${deliveryMode === "later" ? "bg-cyan-300 text-slate-950" : "glass"}`}>Send for later</button>
      </nav>
      <LaterTransfer active={deliveryMode === "later"} onOpen={() => setDeliveryMode("later")} />
      <div hidden={deliveryMode !== "live"}>
      <div className="relative z-10 mx-auto grid max-w-6xl gap-5 px-5 pb-14 lg:grid-cols-[.8fr_1.2fr]">
        <aside className="dev-console rounded-[28px] p-6">
          <p className="font-mono text-xs uppercase tracking-[.2em] text-cyan-300">
            This device
          </p>
          <p className="mt-3 text-4xl font-semibold tracking-[.18em]">
            {deviceCode.slice(0, 3)} {deviceCode.slice(3)}
          </p>
          <p className="mt-3 text-sm leading-6 text-slate-400">
            Give this code to your other device. Keep this page open to receive
            files.
          </p>
          <button
            onClick={() => {
              navigator.clipboard.writeText(deviceCode);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="mt-5 rounded-xl border border-cyan-300/25 px-4 py-2.5 text-sm text-cyan-200"
          >
            {copied ? (
              <>
                <Check className="mr-2 inline" size={16} />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-2 inline" size={16} />
                Copy my code
              </>
            )}
          </button>
          <div className="mt-7 border-t border-white/10 pt-5">
            <p className="font-mono text-xs text-emerald-300">
              ● ONLINE / READY
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Receiver clicks Accept once. Files then download automatically.
            </p>
          </div>
        </aside>
        <section className="dev-console rounded-[28px] p-5 sm:p-7">
          <p className="font-mono text-xs uppercase tracking-[.2em] text-cyan-300">
            Send to a device
          </p>
          <div className="mt-5 flex gap-3">
            <input
              value={targetCode}
              onChange={(event) =>
                setTargetCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              placeholder="ENTER 6-DIGIT CODE"
              className="min-w-0 flex-1 rounded-xl border border-white/15 bg-black/20 px-4 py-3 text-center font-mono tracking-[.22em] outline-none focus:border-cyan-300"
            />
            <button
              onClick={requestTransfer}
              disabled={preparingFolder}
              className="rounded-xl bg-cyan-300 px-4 text-sm font-semibold text-slate-950 disabled:opacity-50"
            >
              {mode === "text" ? "Send text" : "Request"}
            </button>
          </div>
          <div className="mt-5 flex gap-2" aria-label="Transfer type">
            {(["files", "text"] as const).map((tab) => <button key={tab} type="button" aria-pressed={mode === tab} onClick={() => setMode(tab)} className={`rounded-lg px-4 py-2 font-mono text-xs ${mode === tab ? "bg-cyan-300 text-slate-950" : "bg-white/5 text-slate-400"}`}>{tab === "files" ? "FILES" : "</> CODE / TEXT"}</button>)}
          </div>
          {mode === "text" ? <>
            <CodeEditor label="outgoing / snippet.txt" value={draft} onChange={setDraft} />
            <p className="mt-2 text-xs text-slate-500">Paste code, enter the device code, and send. Indentation and blank lines are preserved. The receiver accepts once.</p>
          </> : <>
          <div
            {...drop.getRootProps()}
            className="mt-5 grid min-h-48 cursor-pointer place-items-center rounded-2xl border border-dashed border-cyan-300/25 bg-cyan-300/[.025] p-6 text-center hover:bg-cyan-300/[.06]"
          >
            <input {...drop.getInputProps()} />
            <div>
              <UploadCloud className="mx-auto mb-3 text-cyan-300" size={30} />
              <p className="font-medium">Drop files here</p>
              <p className="mt-1 text-sm text-slate-500">
                or click to choose files
              </p>
            </div>
          </div>
          <label className="mt-3 inline-flex cursor-pointer items-center rounded-xl border border-cyan-300/25 px-4 py-2 text-sm text-cyan-200 focus-within:ring-2 focus-within:ring-cyan-300">
            {preparingFolder ? `Preparing folder ${folderProgress}%` : "Choose folder"}
            <input type="file" multiple {...{ webkitdirectory: "" }} aria-label="Choose folder" className="sr-only" disabled={preparingFolder}
              onChange={(event) => {
                const selected = Array.from(event.currentTarget.files || []);
                event.currentTarget.value = "";
                void addFolder(selected);
              }} />
          </label>
          <p className="mt-2 text-xs text-slate-500" role="status">{preparingFolder ? "Packaging locally. Please keep this page open." : "Folders arrive as ZIP files with subfolders preserved. Up to 250 MiB / 10,000 files; empty folders are not included. If folder selection is unavailable, send a ZIP."}</p>
          {files.length > 0 && (
            <div className="mt-4 space-y-2">
              {files.map((file, index) => (
                <div
                  key={`${file.name}-${index}`}
                  className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2"
                >
                  <File className="text-cyan-300" size={17} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {file.name}
                  </span>
                  <span className="text-xs text-slate-500">
                    {format(file.size)}
                  </span>
                  <button type="button" aria-label={`Remove ${file.name}`} className="px-2 text-slate-400 hover:text-red-300" onClick={() => setFiles((current) => removeTransferredFile(current, file))}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          </>}
          {receivedText !== null && <CodeEditor label="received / snippet.txt" value={receivedText} onChange={setReceivedText} />}
          <p role="status" className="mt-4 text-xs text-cyan-200">{status}</p>
          {progress > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex justify-between text-xs text-slate-400">
                <span>{status}</span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-cyan-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}
          {error && (
            <p className="mt-4 rounded-xl bg-red-400/15 p-3 text-sm text-red-100">
              {error}
            </p>
          )}
          {connectionWarning && <p role="status" className="mt-4 rounded-xl border border-cyan-300/25 p-3 text-sm text-slate-400">{connectionWarning}</p>}
        </section>
      </div>
      </div>
      {incoming && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5">
          <section className="dev-console w-full max-w-lg rounded-[28px] p-7">
            <p className="font-mono text-xs uppercase tracking-[.2em] text-cyan-300">
              Incoming {incoming.kind === "text" ? "code / text" : "file"} request
            </p>
            <h2 className="mt-3 text-2xl font-semibold">
              {incoming.kind === "text" ? "A device wants to send code / text." : `A device wants to send ${incoming.files.length} file${incoming.files.length === 1 ? "" : "s"}.`}
            </h2>
            <div className="mt-5 space-y-2">
              {incoming.files.map((file) => (
                <div
                  key={file.name}
                  className="flex justify-between rounded-xl bg-white/5 p-3 text-sm"
                >
                  <span>{file.name}</span>
                  <span className="text-slate-500">{format(file.size)}</span>
                </div>
              ))}
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setIncoming(null)}
                className="flex-1 rounded-xl bg-white/10 py-3 text-sm"
              >
                Reject
              </button>
              <button
                onClick={accept}
                className="flex-1 rounded-xl bg-cyan-300 py-3 text-sm font-semibold text-slate-950"
              >
                {incoming.kind === "text" ? "Accept & open editor" : "Accept & download"}
              </button>
            </div>
            <p className="mt-4 flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheck size={14} /> Encrypted WebRTC transfer — files do not
              pass through Render.
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
