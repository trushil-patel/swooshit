# Swooshit technical guide

## Runtime responsibilities

`app/page.tsx` renders `components/swooshit-app.tsx`. The browser coordinates live transfers and renders `later-transfer.tsx` for optional offline delivery. `code-editor.tsx` preserves plain text and supports copying and tab indentation; it is not a syntax-highlighting IDE. The theme helpers persist light/dark preferences.

`server/signaling.ts` starts the separate Express/Socket.IO process; `server/signaling-server.ts` owns validation, authorization, rate limits, and the testable server factory. Its device and request maps disappear on restart. Deploy one signaling instance; horizontal scaling would require shared state and a compatible Socket.IO adapter. The frontend uses HTTP polling with upgrades disabled.

## Live transfer lifecycle

1. The browser registers its saved six-digit code. If another live connection owns it, the server generates a different code without displacing the owner. The browser persists and displays the assigned code. Codes are addresses, not authenticated identities.
2. A sender requests a transfer by recipient code, sending filenames, sizes, and item kind.
3. The receiver accepts; signaling places both sockets in a transfer room.
4. Browsers exchange SDP offers/answers and ICE candidates through that room.
5. The sender writes 16 KiB chunks to an encrypted data channel, pausing when buffered data exceeds 4,000,000 bytes.
6. The receiver assembles the file in memory, checks its declared size, and hands it to the browser download mechanism or text editor. A receipt removes the matching sender file.

Folder selection uses JSZip STORE packaging (no compression), preserving file paths. It validates paths, duplicates, total input size, and file count. Empty folders are not represented by the picker. Large transfers are limited by browser memory; streaming-to-disk and resumable transfer are not implemented.

Live rejection dismisses the receiver dialog locally; it does not notify the sender. The server removes the pending request after its two-minute expiry. Refresh both browsers before independent manual test scenarios.

## Optional offline delivery

`lib/later/crypto.ts` creates RSA-OAEP device keys and encrypts each file and filename with AES-256-GCM. The content key is wrapped for the recipient. `lib/later/client.ts` persists the identity locally and adds its private credential to API requests.

`app/api/later/route.ts` authenticates credentials, looks up recipients, reserves uploads, confirms object sizes, lists inboxes, and authorizes download/completion/rejection. The privately maintained Supabase schema enables row-level security and restricts tables/functions to the service role. Reservations enforce quotas atomically.

Browsers upload/download ciphertext through signed Storage URLs. Files do not pass through Next.js request bodies. Access expires 24 hours after reservation. The daily cleanup job removes up to 500 expired objects/records per run and prunes old rate-limit records. Physical deletion can lag expiry, especially if cleanup fails.

Offline setup instructions and Supabase deployment assets are maintained privately and must be supplied separately to enable this optional feature.

## Deploying the frontend and signaling

1. Build the frontend with `npm ci` and `npm run build`. Use a Next.js-capable host such as Vercel, or `npm start` on a persistent Node host.
2. Deploy signaling on a separate persistent Node service such as Render: build with `npm ci`, start with `npm run signal`. Keep tsx installed because the command uses it.
3. Set `NODE_ENV=production` and `CLIENT_ORIGIN` on signaling to the exact frontend origins, comma-separated. Production startup refuses an empty origin configuration. Set `PORT` if the host does not supply it. Other environments default to http://localhost:3000 and http://127.0.0.1:3000. Handshakes without an Origin header are denied; non-browser diagnostic clients must send an allowed Origin.
4. Set `NEXT_PUBLIC_SIGNALING_URL` on the frontend to the public HTTPS signaling address before building. Rebuild after changing it.
5. Check the signaling root: it returns `{"service":"swooshit signaling","status":"ok"}`. A health response alone does not verify a transfer.
6. Test a small file and Unicode snippet in two browser profiles. Verify received bytes and formatting.

Example hostnames are placeholders, not verified demos. Do not deploy the development server as a production service.

## STUN and TURN

`lib/webrtc-config.ts` includes Google STUN and permits direct and relay candidates. `/api/ice-servers` obtains Metered credentials server-side, validates returned TURN URLs, and avoids caching. The API key stays server-side; TURN usernames/passwords necessarily reach browser clients.

Set `METERED_DOMAIN` and `METERED_TURN_API_KEY` on the frontend server. If absent or unavailable, the UI warns and attempts direct connectivity. TURN may be needed on restricted networks. ICE chooses a working path; it does not guarantee direct transport first. Inspect WebRTC diagnostics for a selected relay candidate when verifying TURN. Monitor provider usage and billing.

## Security boundaries

- Codes address devices; they are not authentication secrets. Share only with intended recipients.
- Live filenames/sizes are visible to signaling. Payload bytes use encrypted WebRTC, directly or through TURN.
- Live signaling validates request, file, SDP, and ICE fields; bounds message sizes and state; checks request ownership and both accepted room participants; and restricts offer/answer roles. It rejects unregistered/self transfers and disconnects rate-limit offenders. This protects signaling, not the contents sent by a peer after receiver approval.
- Origin checks cover polling and WebSocket handshakes. They are browser-origin restrictions, not authentication: a native client can forge an Origin header. Rate limits and receiver approval remain necessary.
- Offline content/filenames are encrypted, but routing metadata is visible. The public-key directory is trusted; independent recipient fingerprint verification is absent.
- Local-storage keys are vulnerable to XSS or device compromise. Losing site data loses inbox access; recovery/export is absent.
- The public TURN credential endpoint has no application rate limiter. Provider quotas and monitoring remain necessary.
- Vercel Analytics is integrated. Review deployed analytics behavior when making privacy claims.
- A credential was removed from setup documentation. The owner must revoke/rotate it, including copies in old commits.

## Signaling limits

The server remains a single in-memory instance. Limits reset on restart; reverse proxies and multiple processes need deployment-level rate controls. Source-address limits use the TCP peer address and ignore X-Forwarded-For. If your host proxies connections, clients may share the proxy address and quota. Verify this on the real host and configure edge rate limits using the host's trusted client identity; do not blindly trust caller-supplied headers.

| Resource | Default |
| --- | --- |
| Registration / request / acceptance / signal events per socket per minute | 10 / 20 / 60 / 600 |
| Connection attempts / control events / signals per TCP address per minute | 120 / 120 / 3,000 |
| Simultaneous Socket.IO connections | 512 |
| Unregistered connection lifetime | 30 seconds |
| Rate-limit address buckets | 4,096; excess buckets fail closed |
| Pending requests / accepted negotiation rooms | 1,024 each globally; 8 each per device |
| Pending request / accepted room lifetime | 2 minutes / 30 minutes |
| Individual Socket.IO message | 128 KiB |
| Files per request / filename length / combined filename bytes | 256 / 1,024 characters / 64 KiB |
| SDP / ICE candidate text | 65,536 / 4,096 characters |

File sizes must be nonnegative safe integers; control characters in filenames are rejected. Metadata is copied from validated fields rather than forwarding arbitrary objects. Re-registration on a connection is idempotent for its assigned code and cannot reserve aliases. Disconnect removes code ownership, pending requests, and active room memberships. Expired rooms stop relaying signaling; an already established WebRTC channel is independent. There is no new transfer-complete protocol event, so an accepted room occupies capacity until disconnect or expiry.

[Socket.IO's CORS documentation](https://socket.io/docs/v4/handling-cors/) explains why the server uses allowRequest in addition to CORS. These controls are not a distributed denial-of-service defense.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Receiver offline | Use the currently displayed code and the same reachable signaling server. |
| Cannot connect to signaling | CLIENT_ORIGIN must include the frontend origin; check host/proxy quotas and production environment settings. |
| Signaling rate limit | Wait a minute and refresh; repeated requests may consume shared proxy-address quotas. |
| Request works; transfer fails | TURN configuration/quota, HTTPS, network policy, and WebRTC diagnostics. |
| Offline setup fails | Server-only variables, applied SQL, and HTTPS or localhost. |
| Inbox disappears | Same origin/profile and intact local storage. |
| Expired objects remain | Cron execution, bearer secret, logs, and cleanup backlog. |

A local build does not verify external deployments, TURN connectivity, or Supabase setup.
