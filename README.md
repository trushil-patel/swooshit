# swooshit

## Live or send for later

Choose **Live transfer** for the existing WebRTC flow, or **Send for later** for browser-encrypted temporary storage when devices are online at different times. Offline mode needs a Supabase project and Vercel server variables; follow [OFFLINE_SETUP.md](OFFLINE_SETUP.md) and run [supabase/offline.sql](supabase/offline.sql).

Offline requests use a separate inbox code, a private browser credential and encryption keys. The receiver must create its inbox once before going offline. Clearing browser data loses access. Initial limits: 25 MiB per item and a 24-hour download window. Live transfer remains available without configuring offline mode. No cloud deployment has been provisioned by these code changes.

For a full explanation of the architecture, stack, pairing flow, deployment, troubleshooting, and next improvements, see [the swooshit technical guide](docs/SWOOSHIT_GUIDE.md).

swooshit sends files and editor text using encrypted WebRTC data channels. Direct connections are allowed, with Metered TURN fallback for restricted networks. Socket.IO only relays connection metadata; it never receives file contents.

## Local development

### Folder transfers

In **FILES** mode, click **Choose folder**. swooshit prepares `folder-name.zip` locally, preserving the selected files' paths and subfolders. Enter the receiver code and request the transfer as usual. After acceptance, the receiver downloads one ZIP and extracts it. The ZIP is removed from the sender's list after receipt confirmation. The ZIP uses the same WebRTC connection as ordinary files; nothing is uploaded to cloud storage.

Folder preparation is limited to 250 MiB and 10,000 files because it uses browser memory; less powerful devices may need smaller folders. Empty directories, permissions and symlink semantics are not preserved. Folder-picker support depends on the browser/device. If unavailable, or for larger folders, create a ZIP with your operating system and send it as a normal file. Use **Choose folder** rather than dropping a directory into the ordinary file drop zone.

```bash
npm.cmd install
npm.cmd run signal # Socket.IO at http://localhost:3001
npm.cmd run dev    # Next.js UI at http://localhost:3000
```

Copy `.env.example` to `.env.local` and set NEXT_PUBLIC_SIGNALING_URL before starting Next.js. Use two browsers/devices: select files on the sender, enter the receiver's six-digit code, request transfer, then accept on the receiver. The selected files start transferring automatically when the secure connection opens.

## Vercel Web Analytics

The frontend includes Vercel Web Analytics in the root layout to track page views. In the Vercel project dashboard, open **Analytics**, click **Enable**, then deploy the updated frontend. Visit the deployed site to start collecting page views; development mode does not send analytics data. See the [Vercel Web Analytics setup guide](https://vercel.com/docs/analytics/quickstart).

## Deploy the signaling server on Render

The Next.js frontend belongs on Vercel, but its Socket.IO signaling service must run on a host that supports persistent WebSocket connections. These steps deploy only the signaling service to Render.

1. Push the latest project changes to the `main` branch on GitHub.
2. Sign in to [Render](https://dashboard.render.com/) with GitHub.
3. Select **New** > **Web Service**, then select the `swooshit` repository.
4. Use these service settings:

   | Field | Value |
   | --- | --- |
   | Name | `swooshit-signaling` (or another unique name) |
   | Region | Choose one near your users |
   | Branch | `main` |
   | Runtime | `Node` |
   | Root Directory | Leave empty |
   | Build Command | `npm install` |
   | Start Command | `npm run signal` |
   | Health Check Path | `/` |

5. Under **Environment Variables**, add `CLIENT_ORIGIN` with your Vercel URL, for example `https://swooshit.vercel.app`. During testing you can permit both local and production URLs with a comma-separated value: `http://localhost:3000,https://swooshit.vercel.app`.
6. Choose a compute plan and click **Create Web Service**. Do not define `PORT`; Render supplies it automatically and the signaling server uses it.
7. Wait for the deploy to succeed, then copy Render’s public HTTPS URL, for example `https://swooshit-signaling.onrender.com`. Opening that URL should return a small JSON health response.
8. In Vercel, open the frontend project’s **Settings** > **Environment Variables**. Add:

   ```text
   NEXT_PUBLIC_SIGNALING_URL=https://swooshit-signaling.onrender.com
   ```

9. Redeploy the Vercel project. Open the live site on two devices to test pairing and a small file transfer.

Every push to the selected GitHub branch triggers a new Render deployment. When the Vercel domain changes, update `CLIENT_ORIGIN` in Render and let Render redeploy.

## Sending code or text

Select **CODE / TEXT**, paste your snippet, enter the receiver's device code, and click **Send text**. The receiver clicks **Accept & open editor**; the text transfers automatically into a separate received editor with a **Copy code** button. Editors show line numbers and counts, support tab indentation, and scroll horizontally without wrapping long lines. Text is sent as chunked UTF-8 over WebRTC, preserving spaces, tabs and blank lines without formatting or executing code. Received text stays in browser memory and is lost on refresh unless copied elsewhere.

Deploy both the frontend on Vercel and the updated signaling service on Render for the text-specific acceptance prompt. Refresh both devices after deployment. Run `node --test tests/text-transfer.test.mjs` to check the text encoding/chunking round trip; this does not replace a live two-device test.

## STUN + Metered TURN fallback

1. Keep `NEXT_PUBLIC_SIGNALING_URL` set to your Render signaling URL in Vercel.
2. In your Metered TURN dashboard, create or select a valid credential. Use its credential-specific API key, not an account master secret. Newly created credentials may need up to two minutes to propagate. See [Metered's setup guide](https://www.metered.ca/docs/turn-server-service/creating-turn-credentials/).
3. In Vercel, add `METERED_DOMAIN=your-app.metered.live` and `METERED_TURN_API_KEY=your-credential-api-key` to the environments you use. Never add a `NEXT_PUBLIC_` prefix or commit real credentials. For local testing, set them in `.env.local`.
4. Push and redeploy Vercel. Render signaling needs no changes. Refresh both devices before testing.

The browser fetches TURN configuration from `/api/ice-servers`; the endpoint calls Metered server-side without caching or returning the API key. Browser users necessarily receive TURN usernames/passwords. The app adds STUN and retains the returned TURN UDP/TCP/TLS endpoints, including TLS on port 443 when supplied by Metered.

`iceTransportPolicy: "all"` permits both direct and relay candidates. ICE chooses a working path: this is automatic relay fallback, not a promise that a direct route always wins or that relay usage is zero. The TURN-only policy is not used. Relayed traffic consumes Metered quota; monitor usage and provider billing limits. The public credential endpoint supports anonymous clients and is not a hard spending cap or abuse-control system.

If the endpoint fails, the UI explicitly warns that only direct connections are being attempted. If all paths fail, check Metered credentials/quota and network permissions. TURN/TLS may help with blocked UDP, but institutional networks can block TURN too. Direct connections can reveal network addresses to the other device. Both pages must stay open.

Test the receiver-accept flow on ordinary Wi-Fi and on the college network. Send a small file, a folder ZIP and a code snippet. Inspect browser WebRTC diagnostics (for example `chrome://webrtc-internals`): a selected local or remote candidate of type `relay` means TURN is carrying the transfer. Refresh both pages after correcting credential settings.

Run `node --import tsx --test tests/metered-turn.test.ts tests/webrtc-config.test.ts tests/text-transfer.test.mjs` for credential/configuration checks. These use mocked provider responses and do not verify live Metered credentials or college-network access.
