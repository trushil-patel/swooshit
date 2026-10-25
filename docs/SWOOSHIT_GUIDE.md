# swooshit: Technical Guide

## What swooshit does

swooshit transfers a selected file directly from one web browser to another. It does not upload the file to Vercel, Render, or a storage provider.

The app uses a short pairing code or QR link to help two browsers find one another. Once paired, the file travels over a browser-to-browser WebRTC data channel.

## Tech stack

| Area | Technology | Why it is used |
| --- | --- | --- |
| Frontend framework | Next.js 16, React 19, TypeScript | Builds the browser UI and provides type safety. |
| Styling | Tailwind CSS | Utility classes for the responsive visual design. |
| Animation | Framer Motion | Page transitions and hover motion. |
| Icons | Lucide React | UI icons. |
| File picker | React Dropzone | Drag-and-drop and file selection. |
| QR codes | qrcode.react | Generates the pairing QR code. |
| Peer-to-peer transport | WebRTC `RTCPeerConnection` and `RTCDataChannel` | Creates an encrypted browser-to-browser channel and sends file bytes. |
| Signaling | Socket.IO | Relays only WebRTC offer, answer, and ICE metadata. |
| Signaling server | Node.js, Express, Socket.IO | Runs the small persistent server required for pairing. |
| Frontend hosting | Vercel | Hosts the Next.js website. |
| Signaling hosting | Render | Hosts the persistent Socket.IO server. |

## Project layout

```text
app/
  layout.tsx              Global Next.js layout and metadata
  page.tsx                Home route
  globals.css             Global CSS and visual utility classes

components/
  swooshit-app.tsx        Main UI, pairing state, WebRTC connection, and transfer UI

server/
  signaling.ts            Express + Socket.IO signaling service

docs/
  SWOOSHIT_GUIDE.md       This guide

.env.example              Environment-variable reference
```

## Architecture

```text
Sender browser                         Receiver browser
      |                                       |
      |------ Socket.IO signaling ----------->|
      |        (code, offer, answer, ICE)     |
      |<--------------------------------------|
      |                                       |
      |========= WebRTC DataChannel =========|
      |          actual encrypted file bytes  |
      |                                       |

                 Render signaling server
             (metadata only; no file content)
```

Vercel serves the frontend. Render hosts the signaling process. File data bypasses both services after the WebRTC connection is established.

## How pairing works

1. The sender selects files and starts pairing.
2. The sender browser creates a random six-digit code and connects to the Render Socket.IO service.
3. The receiver opens the QR URL or enters that same code, then connects to the same service.
4. Render places both sockets in a room named `drop-<code>`.
5. When the room has two devices, Render emits `peer-ready`.
6. The sender creates a WebRTC offer and sends it through Render.
7. The receiver creates an answer and sends it back through Render.
8. Both browsers exchange ICE candidates through Render to find a working network route.
9. When the WebRTC data channel opens, the browsers are paired.

The signaling service only forwards messages such as offers, answers, and network candidates. It does not receive the chosen files.

## How file transfer works

The sender reads each selected `File` in small chunks (16 KB in the current implementation):

1. Send file metadata: name, size, and MIME type.
2. Send each binary chunk over the `RTCDataChannel`.
3. Wait when the data channel buffer becomes large; this avoids overwhelming the browser.
4. Send a final `end` message for the file.
5. The receiver gathers the chunks into a `Blob` and creates a browser download.

WebRTC encrypts the data channel using DTLS. The current app also uses a public STUN server to help browsers discover a direct network path.

## Important limitation: TURN

STUN alone cannot connect every pair of networks. Some carrier, office, university, or restrictive NAT networks block direct peer-to-peer routes.

For production reliability, add an authenticated TURN service. A TURN server relays encrypted WebRTC traffic only when a direct connection is impossible. Common providers include Metered, Twilio Network Traversal, and self-hosted coturn.

Never put permanent TURN credentials in `NEXT_PUBLIC_` variables. Use short-lived credentials supplied from a secure server endpoint.

## Environment variables

### Vercel frontend

```text
NEXT_PUBLIC_SIGNALING_URL=https://your-render-service.onrender.com
NEXT_PUBLIC_STUN_URLS=stun:stun.l.google.com:19302
```

`NEXT_PUBLIC_` variables are compiled into browser JavaScript during the Vercel build. After changing one, redeploy Vercel.

### Render signaling service

```text
CLIENT_ORIGIN=https://your-project.vercel.app
```

For local and production development together:

```text
CLIENT_ORIGIN=http://localhost:3000,https://your-project.vercel.app
```

`PORT` is provided automatically by Render. The service uses it, falling back to `SIGNAL_PORT` or `3001` locally.

## Run locally

Install dependencies:

```powershell
npm.cmd install
```

Start the signaling server in one terminal:

```powershell
npm.cmd run signal
```

Start Next.js in a second terminal:

```powershell
npm.cmd run dev
```

Open `http://localhost:3000` on two browsers, use the same pairing code, and test with a small file first.

## Deployments

### Vercel

Vercel deploys the Next.js app from GitHub. It cannot host this app's persistent Socket.IO signaling process as a normal long-running server.

Set `NEXT_PUBLIC_SIGNALING_URL` in the Vercel project environment variables, then redeploy after changes.

### Render

Render deploys the signaling service from the same repository as a Node Web Service.

| Setting | Value |
| --- | --- |
| Build Command | `npm install` |
| Start Command | `npm run signal` |
| Health Check Path | `/` |

Opening the Render URL should return:

```json
{"service":"swooshit signaling","status":"ok"}
```

## Debugging checklist

### “Cannot reach the signaling service” / `xhr poll error`

- Verify `NEXT_PUBLIC_SIGNALING_URL` uses the exact `https://...onrender.com` service URL.
- Ensure the Vercel deployment was redeployed after the variable changed.
- Ensure `CLIENT_ORIGIN` matches the exact Vercel URL, without quotes.
- Open the Render URL directly; it should show the health JSON response.

### “Waiting for the other device” forever

- Both devices must use the same code.
- Keep both browser tabs open and awake.
- Do not press Start pairing again; that creates a new code/session.
- Render Logs should show `2/2 device(s) connected` for the code.

### Both devices pair but WebRTC does not connect

- Check Render Logs for relayed `offer`, `answer`, and `candidate` messages.
- Test both devices on the same Wi-Fi.
- Add TURN for networks where STUN cannot establish a direct route.

## Useful commands

```powershell
# Type-check TypeScript
npx.cmd tsc --noEmit

# Create a production build
npm.cmd run build

# Start frontend development server
npm.cmd run dev

# Start signaling server
npm.cmd run signal
```

## Security notes

- The pairing code is only a short-lived room identifier, not user authentication.
- Do not treat the current service as a full access-control system.
- Restrict `CLIENT_ORIGIN` in production.
- Add rate limiting and room expiration before exposing the app broadly.
- Use TURN credentials that expire quickly.
- Validate size limits and file-transfer rules if this becomes a public product.


