import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { io as connect, type Socket } from "socket.io-client";
import { createSignalingServer } from "../server/signaling-server";

const origin = "http://localhost:3000";
const offer = { type: "offer", description: { type: "offer", sdp: "v=0\r\n" } };
const answer = { type: "answer", description: { type: "answer", sdp: "v=0\r\n" } };
const candidate = { type: "candidate", candidate: { candidate: "candidate:1 1 UDP 1 127.0.0.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 } };
type Incoming = { requestId: string; from: string; files: { name: string; size: number }[]; kind: string };

function event<T>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, listener); reject(new Error(`Timed out waiting for ${name}`)); }, 3000);
    const listener = (data: T) => { clearTimeout(timer); resolve(data); };
    socket.once(name, listener);
  });
}

async function fixture(t: TestContext, options: Parameters<typeof createSignalingServer>[0] = {}) {
  const server = createSignalingServer(options);
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await new Promise<void>(resolve => server.io.close(() => resolve()));
  });
  server.httpServer.listen(0, "127.0.0.1");
  await once(server.httpServer, "listening");
  const url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  const client = (transport = "polling", requestOrigin: string | undefined = origin, extraHeaders = {}) => {
    const socket = connect(url, { transports: [transport], upgrade: false, reconnection: false, autoConnect: false,
      extraHeaders: { ...(requestOrigin ? { Origin: requestOrigin } : {}), ...extraHeaders } });
    sockets.push(socket);
    return socket;
  };
  const device = async (code?: string) => {
    const socket = client();
    const connected = event(socket, "connect"); socket.connect(); await connected;
    if (code) {
      const registered = event<{ code: string }>(socket, "device-ready");
      socket.emit("register-device", { code });
      return { socket, code: (await registered).code };
    }
    return { socket, code: "" };
  };
  return { ...server, url, device, client };
}

async function request(sender: Socket, receiver: Socket, code: string, kind = "files") {
  const incoming = event<Incoming>(receiver, "incoming-transfer");
  sender.emit("request-transfer", { code, files: [{ name: "snippet.txt", size: 8 }], kind });
  return incoming;
}
async function accept(sender: Socket, receiver: Socket, requestId: string) {
  const ready = Promise.all([event(sender, "transfer-ready"), event(receiver, "transfer-ready")]);
  receiver.emit("accept-transfer", { requestId });
  await ready;
}
async function rejected(socket: Socket, name: string, payload?: unknown) {
  const error = event<string>(socket, "app-error");
  if (payload === undefined) socket.emit(name); else socket.emit(name, payload);
  return error;
}

test("live file/text requests preserve approval and bidirectional SDP/ICE signaling", async t => {
  const f = await fixture(t);
  const sender = await f.device("123456"), receiver = await f.device("654321");
  assert.equal((await (await fetch(f.url)).json()).service, "swooshit signaling");
  for (const kind of ["files", "text"]) {
    const incoming = await request(sender.socket, receiver.socket, receiver.code, kind);
    assert.equal(incoming.from, sender.code);
    assert.equal(incoming.kind, kind);
    assert.deepEqual(incoming.files, [{ name: "snippet.txt", size: 8 }]);
    assert.match(await rejected(sender.socket, "signal", { requestId: incoming.requestId, payload: offer }), /not authorized/);
    await accept(sender.socket, receiver.socket, incoming.requestId);
    for (const [from, to, payload] of [[sender.socket, receiver.socket, offer], [receiver.socket, sender.socket, answer],
      [sender.socket, receiver.socket, candidate], [receiver.socket, sender.socket, candidate]] as const) {
      const message = event<{ requestId: string; payload: unknown }>(to, "signal");
      from.emit("signal", { requestId: incoming.requestId, payload });
      const relayed = await message;
      assert.equal(relayed.requestId, incoming.requestId);
      assert.deepEqual(relayed.payload, payload);
    }
  }
});

test("only the receiver can accept; unrelated sockets and wrong SDP roles cannot inject signals", async t => {
  const f = await fixture(t);
  const a = await f.device("123456"), b = await f.device("654321"), stranger = await f.device("111111");
  const incoming = await request(a.socket, b.socket, b.code);
  for (const socket of [a.socket, stranger.socket]) assert.match(await rejected(socket, "accept-transfer", { requestId: incoming.requestId }), /not authorized/);
  await accept(a.socket, b.socket, incoming.requestId);
  assert.match(await rejected(b.socket, "accept-transfer", { requestId: incoming.requestId }), /expired/);
  const received: unknown[] = [];
  b.socket.on("signal", data => received.push(data));
  assert.match(await rejected(stranger.socket, "signal", { requestId: incoming.requestId, payload: offer }), /not authorized/);
  assert.match(await rejected(b.socket, "signal", { requestId: incoming.requestId, payload: offer }), /role not authorized/);
  assert.match(await rejected(a.socket, "signal", { requestId: incoming.requestId, payload: answer }), /role not authorized/);
  const valid = event(b.socket, "signal");
  a.socket.emit("signal", { requestId: incoming.requestId, payload: offer });
  await valid;
  assert.equal(received.length, 1);
});

test("colliding codes are reassigned without taking over the original receiver; a socket cannot reserve aliases", async t => {
  const f = await fixture(t);
  const first = await f.device("123456"), second = await f.device("123456"), sender = await f.device("654321");
  assert.equal(first.code, "123456"); assert.match(second.code, /^\d{6}$/); assert.notEqual(first.code, second.code);
  assert.match(await rejected(second.socket, "register-device", { code: "222222" }), /already registered/);
  const stable = event<{ code: string }>(second.socket, "device-ready");
  second.socket.emit("register-device", { code: second.code }); assert.equal((await stable).code, second.code);
  await request(sender.socket, first.socket, first.code);
  await request(sender.socket, second.socket, second.code);
  const gone = once(f.io.of("/").sockets.get(first.socket.id!)!, "disconnect");
  first.socket.disconnect(); await gone;
  const replacement = await f.device("123456"); assert.equal(replacement.code, "123456");
});

test("malformed payloads, invalid metadata, unregistered requests, and self-transfers fail safely", async t => {
  const f = await fixture(t, { limits: { requestsPerSocket: 100, registrationsPerSocket: 100, controlsPerAddress: 1000 } });
  const unknown = await f.device();
  assert.match(await rejected(unknown.socket, "request-transfer", { code: "123456", files: [{ name: "a", size: 1 }] }), /Register/);
  for (const value of [undefined, null, [], {}, { code: 123456 }, { code: "../123456" }]) {
    assert.match(await rejected(unknown.socket, "register-device", value), /Invalid/);
  }
  const a = await f.device("123456"), b = await f.device("654321");
  for (const value of [undefined, null, [], {}, { code: b.code, files: "a" }, { code: b.code, files: [] },
    { code: b.code, files: Array.from({ length: 257 }, () => ({ name: "a", size: 1 })) },
    ...[-1, 0.5, "4", Number.MAX_SAFE_INTEGER + 1].map(size => ({ code: b.code, files: [{ name: "a", size }] })),
    ...[null, "", "a\u0000b", "x".repeat(1025)].map(name => ({ code: b.code, files: [{ name, size: 1 }] })),
    { code: b.code, files: [{ name: "a", size: 1 }], kind: "html" }]) {
    assert.match(await rejected(a.socket, "request-transfer", value), /Invalid/);
  }
  assert.match(await rejected(a.socket, "request-transfer", { code: a.code, files: [{ name: "a", size: 0 }] }), /another device/);
  assert.match(await rejected(a.socket, "accept-transfer", null), /Invalid/);
  assert.match(await rejected(a.socket, "signal", null), /Invalid/);
  const incoming = await request(a.socket, b.socket, b.code); await accept(a.socket, b.socket, incoming.requestId);
  for (const payload of [null, [], {}, { type: "offer", description: { type: "answer", sdp: "v=0" } },
    { type: "offer", description: { type: "offer", sdp: "a".repeat(65537) } },
    { type: "candidate", candidate: null }, { type: "candidate", candidate: { candidate: "x", sdpMLineIndex: -1 } },
    { type: "candidate", candidate: { candidate: "x", sdpMid: {} } }]) {
    assert.match(await rejected(a.socket, "signal", { requestId: incoming.requestId, payload }), /Invalid signal payload/);
  }
  const delivered = event<{ payload: unknown }>(b.socket, "signal");
  a.socket.emit("signal", { requestId: incoming.requestId, payload: { ...offer, arbitrary: "discard", description: { ...offer.description, arbitrary: "discard" } } });
  assert.deepEqual((await delivered).payload, offer);
});

test("pending requests and accepted rooms expire; disconnect invalidates peer authorization", async t => {
  let time = 1000;
  const f = await fixture(t, { now: () => time, limits: { requestTtlMs: 100, sessionTtlMs: 200 } });
  const a = await f.device("123456"), b = await f.device("654321");
  const expired = await request(a.socket, b.socket, b.code);
  time += 101;
  assert.match(await rejected(b.socket, "accept-transfer", { requestId: expired.requestId }), /expired/);
  const active = await request(a.socket, b.socket, b.code); await accept(a.socket, b.socket, active.requestId);
  time += 201;
  assert.match(await rejected(a.socket, "signal", { requestId: active.requestId, payload: offer }), /not authorized/);
  assert.equal(f.io.of("/").adapter.rooms.has(`transfer-${active.requestId}`), false);
  const live = await request(a.socket, b.socket, b.code); await accept(a.socket, b.socket, live.requestId);
  const pending = await request(a.socket, b.socket, b.code);
  const gone = once(f.io.of("/").sockets.get(a.socket.id!)!, "disconnect");
  a.socket.disconnect(); await gone;
  assert.match(await rejected(b.socket, "signal", { requestId: live.requestId, payload: answer }), /not authorized/);
  assert.match(await rejected(b.socket, "accept-transfer", { requestId: pending.requestId }), /expired/);
});

test("pending and active capacities are bounded and expired requests release capacity", async t => {
  let time = 1000;
  const f = await fixture(t, { now: () => time, limits: { pendingPerDevice: 1, activePerDevice: 1, requestTtlMs: 100 } });
  const a = await f.device("123456"), b = await f.device("654321");
  await request(a.socket, b.socket, b.code);
  assert.match(await rejected(a.socket, "request-transfer", { code: b.code, files: [{ name: "a", size: 1 }] }), /Too many pending/);
  time += 101;
  const live = await request(a.socket, b.socket, b.code); await accept(a.socket, b.socket, live.requestId);
  const another = await request(a.socket, b.socket, b.code);
  assert.match(await rejected(b.socket, "accept-transfer", { requestId: another.requestId }), /Too many active/);
});

test("per-socket request limits disconnect floods; address limits survive reconnect and forged forwarding headers", async t => {
  const f = await fixture(t, { limits: { requestsPerSocket: 1, controlsPerAddress: 100 } });
  const a = await f.device("123456"), b = await f.device("654321");
  await request(a.socket, b.socket, b.code);
  const disconnected = event(a.socket, "disconnect");
  assert.match(await rejected(a.socket, "request-transfer", { code: b.code, files: [{ name: "a", size: 1 }] }), /rate limit/);
  await disconnected;
  const limited = await fixture(t, { limits: { controlsPerAddress: 1 } });
  const first = await limited.device("111111"); first.socket.disconnect();
  const second = limited.client("polling", origin, { "X-Forwarded-For": "203.0.113.9" });
  const connected = event(second, "connect"); second.connect(); await connected;
  assert.match(await rejected(second, "register-device", { code: "222222" }), /rate limit/);
});

test("origin checks cover polling and WebSocket; missing origins and excessive connection attempts are denied", async t => {
  const f = await fixture(t);
  for (const transport of ["polling", "websocket"]) {
    for (const header of ["https://untrusted.example", undefined]) {
      // Pass an empty string explicitly to omit the Origin header.
      const socket = f.client(transport, header ?? "");
      const error = event<Error>(socket, "connect_error"); socket.connect(); assert.ok(await error);
    }
  }
  const limited = await fixture(t, { limits: { connectionsPerAddress: 1 } });
  const first = await limited.device("123456"); first.socket.disconnect();
  const next = limited.client(); const error = event<Error>(next, "connect_error"); next.connect(); assert.ok(await error);
});

test("signal floods are disconnected and oversized packets do not reach the peer", async t => {
  const f = await fixture(t, { limits: { signalsPerSocket: 1 } });
  const a = await f.device("123456"), b = await f.device("654321");
  const incoming = await request(a.socket, b.socket, b.code); await accept(a.socket, b.socket, incoming.requestId);
  const delivered = event(b.socket, "signal"); a.socket.emit("signal", { requestId: incoming.requestId, payload: offer }); await delivered;
  const disconnected = event(a.socket, "disconnect");
  assert.match(await rejected(a.socket, "signal", { requestId: incoming.requestId, payload: candidate }), /rate limit/);
  await disconnected;

  const socket = f.client("websocket");
  const connected = event(socket, "connect"); socket.connect(); await connected;
  const closed = event(socket, "disconnect");
  socket.emit("register-device", { code: "111111", padding: "x".repeat(128 * 1024) });
  await closed;
  // The previous well-behaved receiver remains connected and can re-register idempotently.
  const healthy = event<{ code: string }>(b.socket, "device-ready"); b.socket.emit("register-device", { code: b.code });
  assert.equal((await healthy).code, b.code);
});

test("connection capacity and registration timeout release idle resources", async t => {
  const f = await fixture(t, { limits: { maxConnections: 1, registrationTtlMs: 150 } });
  const idle = await f.device();
  const idleClosed = event(idle.socket, "disconnect");
  const overCapacity = f.client();
  const refused = event<Error>(overCapacity, "connect_error"); overCapacity.connect(); assert.ok(await refused);
  await idleClosed;
  const registered = await f.device("123456");
  assert.equal(registered.code, "123456");
});
