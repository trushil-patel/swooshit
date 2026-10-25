import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';

type FileInfo = { name: string; size: number };
type TransferRequest = { senderId: string; receiverId: string; files: FileInfo[] };
const app = express();
const httpServer = createServer(app);
app.get('/', (_request, response) => response.status(200).json({ service: 'swooshit signaling', status: 'ok' }));
const allowedOrigins = process.env.CLIENT_ORIGIN?.split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean);
const io = new Server(httpServer, { cors: { origin: (origin, callback) => callback(!allowedOrigins?.length || !origin || allowedOrigins.includes(origin.replace(/\/$/, '')) ? null : new Error('Origin not allowed'), true), methods: ['GET', 'POST'] } });

const devices = new Map<string, string>();
const requests = new Map<string, TransferRequest>();

io.on('connection', socket => {
  socket.on('register-device', ({ code }: { code: string }) => {
    if (!/^\d{6}$/.test(code)) return socket.emit('app-error', 'Invalid device code');
    devices.set(code, socket.id);
    socket.data.deviceCode = code;
    socket.emit('device-ready', { code });
    console.log(`Device online: ${code}`);
  });

  socket.on('request-transfer', ({ code, files, kind }: { code: string; files: FileInfo[]; kind?: string }) => {
    const receiverId = devices.get(code);
    if (!receiverId || !io.sockets.sockets.has(receiverId)) return socket.emit('app-error', 'That device is offline. Ask them to open swooshit.');
    if (!files?.length) return socket.emit('app-error', 'Choose at least one file.');
    const requestId = randomUUID();
    requests.set(requestId, { senderId: socket.id, receiverId, files });
    io.to(receiverId).emit('incoming-transfer', { requestId, from: socket.data.deviceCode, files, kind: kind === 'text' ? 'text' : 'files' });
    socket.emit('request-sent');
  });

  socket.on('accept-transfer', ({ requestId }: { requestId: string }) => {
    const request = requests.get(requestId);
    if (!request || request.receiverId !== socket.id) return socket.emit('app-error', 'Transfer request expired');
    const sender = io.sockets.sockets.get(request.senderId);
    if (!sender) return socket.emit('app-error', 'Sender is no longer online');
    const room = `transfer-${requestId}`;
    socket.join(room); sender.join(room);
    io.to(room).emit('transfer-ready', { requestId });
    requests.delete(requestId);
  });

  socket.on('signal', ({ requestId, payload }: { requestId: string; payload: unknown }) => socket.to(`transfer-${requestId}`).emit('signal', { requestId, payload }));
  socket.on('disconnect', () => {
    if (socket.data.deviceCode && devices.get(socket.data.deviceCode) === socket.id) devices.delete(socket.data.deviceCode);
    for (const [id, request] of requests) if (request.senderId === socket.id || request.receiverId === socket.id) requests.delete(id);
  });
});

httpServer.listen(Number(process.env.PORT ?? process.env.SIGNAL_PORT ?? 3001), () => console.log('swooshit signaling service started'));
