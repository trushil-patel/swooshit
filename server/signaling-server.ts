import express from "express";
import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { Server } from "socket.io";

export const SIGNALING_LIMITS = {
  windowMs: 60_000,
  connectionsPerAddress: 120,
  registrationsPerSocket: 10,
  requestsPerSocket: 20,
  acceptsPerSocket: 60,
  signalsPerSocket: 600,
  controlsPerAddress: 120,
  signalsPerAddress: 3000,
  maxConnections: 512,
  maxRateBuckets: 4096,
  maxPending: 1024,
  maxActive: 1024,
  pendingPerDevice: 8,
  activePerDevice: 8,
  requestTtlMs: 120_000,
  sessionTtlMs: 30 * 60_000,
  registrationTtlMs: 30_000,
  maxFiles: 256,
  maxMessageBytes: 128 * 1024,
};

type Pair = { senderId: string; receiverId: string; expiresAt: number };
type Bucket = { hits: number; expiresAt: number };
type Options = {
  allowedOrigins?: string[];
  now?: () => number;
  limits?: Partial<typeof SIGNALING_LIMITS>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const validCode = (value: unknown): value is string => typeof value === "string" && /^\d{6}$/.test(value);
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

// Copy only the fields used by WebRTC; never forward arbitrary client objects.
function signalPayload(value: unknown) {
  if (!record(value)) return null;
  if (value.type === "offer" || value.type === "answer") {
    const description = value.description;
    if (!record(description) || description.type !== value.type || typeof description.sdp !== "string"
      || !description.sdp.length || description.sdp.length > 65_536) return null;
    return { type: value.type, description: { type: description.type, sdp: description.sdp } };
  }
  if (value.type === "candidate") {
    const candidate = value.candidate;
    if (!record(candidate) || typeof candidate.candidate !== "string" || candidate.candidate.length > 4096) return null;
    for (const key of ["sdpMid", "usernameFragment"]) {
      const field = candidate[key];
      if (field != null && (typeof field !== "string" || field.length > 256)) return null;
    }
    const index = candidate.sdpMLineIndex;
    if (index != null && (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 65_535)) return null;
    return { type: "candidate", candidate: {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: index,
      usernameFragment: candidate.usernameFragment,
    } };
  }
  return null;
}

export function createSignalingServer(options: Options = {}) {
  const now = options.now ?? Date.now;
  const limits = { ...SIGNALING_LIMITS, ...options.limits };
  const origins = new Set((options.allowedOrigins ?? ["http://localhost:3000", "http://127.0.0.1:3000"])
    .map(value => new URL(value).origin));
  const originAllowed = (origin: string | undefined) => {
    if (!origin) return false;
    try { return origins.has(new URL(origin).origin); } catch { return false; }
  };
  const buckets = new Map<string, Bucket>();
  const take = (map: Map<string, Bucket>, key: string, maximum: number) => {
    let bucket = map.get(key);
    if (!bucket || bucket.expiresAt <= now()) {
      if (!bucket && map.size >= limits.maxRateBuckets) return false;
      bucket = { hits: 0, expiresAt: now() + limits.windowMs };
      map.set(key, bucket);
    }
    if (bucket.hits >= maximum) return false;
    bucket.hits++;
    return true;
  };
  const devices = new Map<string, string>();
  const pending = new Map<string, Pair>();
  const active = new Map<string, Pair>();
  const app = express();
  app.disable("x-powered-by");
  const httpServer = createServer(app);
  app.get("/", (_request, response) => response.status(200).json({ service: "swooshit signaling", status: "ok" }));
  const io = new Server(httpServer, {
    maxHttpBufferSize: limits.maxMessageBytes,
    cors: { origin: (origin, callback) => callback(null, originAllowed(origin)), methods: ["GET", "POST"] },
    // CORS alone does not protect WebSocket handshakes. Do not trust caller-supplied X-Forwarded-For.
    allowRequest: (request, callback) => {
      const address = request.socket.remoteAddress ?? "unknown";
      callback(null, originAllowed(request.headers.origin)
        && io.engine.clientsCount < limits.maxConnections
        && take(buckets, `connect:${address}`, limits.connectionsPerAddress));
    },
  });
  io.use((_socket, next) => next(io.of("/").sockets.size >= limits.maxConnections ? new Error("Signaling capacity reached") : undefined));

  const removeActive = (id: string) => {
    active.delete(id);
    io.in(`transfer-${id}`).socketsLeave(`transfer-${id}`);
  };
  const prune = () => {
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.expiresAt <= time) buckets.delete(key);
    for (const [id, pair] of pending) if (pair.expiresAt <= time) pending.delete(id);
    for (const [id, pair] of active) if (pair.expiresAt <= time) removeActive(id);
  };
  const countFor = (pairs: Map<string, Pair>, id: string) =>
    Array.from(pairs.values()).filter(pair => pair.senderId === id || pair.receiverId === id).length;
  const timer = setInterval(prune, 30_000);
  timer.unref();
  httpServer.on("close", () => clearInterval(timer));

  io.on("connection", socket => {
    const address = socket.handshake.address;
    const socketBuckets = new Map<string, Bucket>();
    const fail = (message: string) => { socket.emit("app-error", message); };
    const registrationTimer = setTimeout(() => {
      if (!socket.data.deviceCode) socket.disconnect(true);
    }, limits.registrationTtlMs);
    registrationTimer.unref();
    const rates: Record<string, number> = {
      "register-device": limits.registrationsPerSocket,
      "request-transfer": limits.requestsPerSocket,
      "accept-transfer": limits.acceptsPerSocket,
      signal: limits.signalsPerSocket,
    };
    socket.use(([event], next) => {
      const isSignal = event === "signal";
      if (!Object.hasOwn(rates, event)
        || !take(socketBuckets, event, rates[event])
        || !take(buckets, `${isSignal ? "signal" : "control"}:${address}`, isSignal ? limits.signalsPerAddress : limits.controlsPerAddress)) {
        fail("Signaling rate limit exceeded. Wait a minute before reconnecting.");
        socket.disconnect(true);
        return;
      }
      next();
    });

    socket.on("register-device", (data: unknown) => {
      if (!record(data) || !validCode(data.code)) return fail("Invalid device code");
      if (socket.data.deviceCode) {
        if (data.code !== socket.data.deviceCode) return fail("This connection is already registered.");
        socket.emit("device-ready", { code: socket.data.deviceCode });
        return;
      }
      let code = data.code;
      // A collision never replaces the existing owner. A disconnected code may be reused.
      for (let attempt = 0; devices.has(code) && attempt < 100; attempt++) code = String(randomInt(100000, 1000000));
      if (devices.has(code)) return fail("Could not allocate a device code. Try again.");
      devices.set(code, socket.id);
      socket.data.deviceCode = code;
      clearTimeout(registrationTimer);
      socket.emit("device-ready", { code });
    });

    socket.on("request-transfer", (data: unknown) => {
      if (!socket.data.deviceCode) return fail("Register this device before requesting transfers.");
      if (!record(data) || !validCode(data.code) || !Array.isArray(data.files)
        || !data.files.length || data.files.length > limits.maxFiles
        || (data.kind !== undefined && data.kind !== "files" && data.kind !== "text")) return fail("Invalid transfer request.");
      const files: { name: string; size: number }[] = [];
      let total = 0;
      let nameBytes = 0;
      for (const file of data.files) {
        if (!record(file) || typeof file.name !== "string" || !file.name.length || file.name.length > 1024
          || /[\u0000-\u001f\u007f]/.test(file.name) || typeof file.size !== "number"
          || !Number.isSafeInteger(file.size) || file.size < 0) return fail("Invalid file metadata.");
        total += file.size;
        nameBytes += Buffer.byteLength(file.name);
        if (!Number.isSafeInteger(total) || nameBytes > 64 * 1024) return fail("Transfer metadata is too large.");
        files.push({ name: file.name, size: file.size });
      }
      const receiverId = devices.get(data.code);
      if (!receiverId || !io.of("/").sockets.has(receiverId)) return fail("That device is offline. Ask them to open swooshit.");
      if (receiverId === socket.id) return fail("Enter another device's code.");
      prune();
      if (pending.size >= limits.maxPending || countFor(pending, socket.id) >= limits.pendingPerDevice
        || countFor(pending, receiverId) >= limits.pendingPerDevice) return fail("Too many pending transfers. Wait for requests to expire.");
      const requestId = randomUUID();
      pending.set(requestId, { senderId: socket.id, receiverId, expiresAt: now() + limits.requestTtlMs });
      io.to(receiverId).emit("incoming-transfer", { requestId, from: socket.data.deviceCode, files, kind: data.kind === "text" ? "text" : "files" });
      socket.emit("request-sent");
    });

    socket.on("accept-transfer", (data: unknown) => {
      if (!record(data) || !validId(data.requestId)) return fail("Invalid transfer request.");
      prune();
      const pair = pending.get(data.requestId);
      if (!pair || pair.receiverId !== socket.id) return fail("Transfer request expired or not authorized.");
      const sender = io.of("/").sockets.get(pair.senderId);
      if (!sender) return fail("Sender is no longer online.");
      if (active.size >= limits.maxActive || countFor(active, socket.id) >= limits.activePerDevice
        || countFor(active, sender.id) >= limits.activePerDevice) return fail("Too many active transfers. Reconnect after finishing your current transfers.");
      const room = `transfer-${data.requestId}`;
      // The default in-memory adapter joins synchronously; this server runs as one instance.
      socket.join(room);
      sender.join(room);
      active.set(data.requestId, { ...pair, expiresAt: now() + limits.sessionTtlMs });
      pending.delete(data.requestId);
      io.to(room).emit("transfer-ready", { requestId: data.requestId });
    });

    socket.on("signal", (data: unknown) => {
      if (!record(data) || !validId(data.requestId)) return fail("Invalid signal.");
      prune();
      const pair = active.get(data.requestId);
      const room = `transfer-${data.requestId}`;
      if (!pair || (socket.id !== pair.senderId && socket.id !== pair.receiverId) || !socket.rooms.has(room)) return fail("Signal not authorized for this transfer.");
      const payload = signalPayload(data.payload);
      if (!payload) return fail("Invalid signal payload.");
      if ((payload.type === "offer" && socket.id !== pair.senderId) || (payload.type === "answer" && socket.id !== pair.receiverId)) return fail("Signal role not authorized.");
      const recipientId = socket.id === pair.senderId ? pair.receiverId : pair.senderId;
      if (!io.of("/").sockets.get(recipientId)?.rooms.has(room)) return fail("Transfer peer disconnected.");
      socket.to(room).emit("signal", { requestId: data.requestId, payload });
    });

    socket.on("disconnect", () => {
      clearTimeout(registrationTimer);
      if (devices.get(socket.data.deviceCode) === socket.id) devices.delete(socket.data.deviceCode);
      for (const [id, pair] of pending) if (pair.senderId === socket.id || pair.receiverId === socket.id) pending.delete(id);
      for (const [id, pair] of active) if (pair.senderId === socket.id || pair.receiverId === socket.id) removeActive(id);
    });
  });

  return { httpServer, io };
}
