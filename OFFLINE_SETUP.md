# Live transfer + Send for later

## What has been added

- **Live transfer** remains WebRTC with STUN and your Metered TURN fallback. Both devices must be online.
- **Send for later** uploads browser-encrypted files to private Supabase Storage and keeps pending requests in Postgres. The receiver can open the website later, accept, decrypt locally and download. Folder ZIPs and editor text are supported.
- No user login is required. A separate server-issued **inbox code** addresses offline requests. The existing Live code remains unchanged. Codes are public addresses, not passwords. Each browser holds a random private credential and an RSA private key; the server stores only the credential hash and public key.
- The receiver must open Send for later **once before going offline** and share its inbox code. Returning browsers check for pending requests on page load, including while Live is selected. Nothing can notify a browser that is completely closed; requests appear when it returns.

## Your setup steps

1. Create a [Supabase project](https://supabase.com/dashboard). Choose a region near your users. You do not need to enable email or anonymous Supabase Auth: this feature uses private browser device credentials through the Next.js backend.
2. In Supabase **SQL Editor**, paste and run [supabase/offline.sql](supabase/offline.sql). It creates the device/request/quota tables, backend-only functions and the private `swooshit-later` bucket. Run this on your own project. Do not add public storage policies or disable row-level security.
3. From the project settings, copy the **Project URL** and **service_role key**. Treat the service-role key as a server secret; it bypasses row-level security. Do not paste it into chat or commit it. See [Supabase access-control guidance](https://supabase.com/docs/guides/storage/security/access-control).
4. In Vercel project settings, add these environment variables for Production (and separately for Preview if you use it):

   ```text
   SUPABASE_URL=https://pmqsykargmyfrwsrhiln.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtcXN5a2FyZ215ZnJ3c3JoaWxuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MDI1ODA1NywiZXhwIjoyMTA1ODM0MDU3fQ.KrgaJo7WklBQ2yyMlmr4eBv5aZifDsTSXPkixzo-gQY
   CRON_SECRET=A-RANDOM-SECRET-OF-AT-LEAST-32-CHARACTERS
   ```

   None should have a `NEXT_PUBLIC_` prefix. Keep the existing Render signaling and Metered variables unchanged. For local testing, put these in `.env.local` (ignored by Git).
5. Push the code and redeploy Vercel. The included `vercel.json` schedules `/api/later/cleanup` daily at 03:00 UTC. Vercel must be configured to run the cron and send `Authorization: Bearer <CRON_SECRET>`. Confirm a successful job in Vercel's cron/logs dashboard; do not assume cleanup is running just because deployment succeeded. See [Vercel cron setup](https://vercel.com/docs/cron-jobs/manage-cron-jobs).
6. Refresh both devices. On the receiver, open **Send for later**, wait for its inbox code, copy it, then close that browser. On the sender, open **Send for later**, enter that inbox code, choose files/folder or paste text, and click **Send for later**. Wait for **Queued** before closing the sender.
7. Reopen the receiver in the **same browser/profile and site origin**. A pending-inbox notice appears, or open Send for later directly. Click **Accept & download/open**. Verify file bytes, folder contents and code indentation. Render needs no changes for offline delivery.

## Limits, privacy and recovery

- Initial offline limit: **25 MiB per item**, 20 upload reservations/day per device, 100/day project-wide, and 50 pending items per recipient. These are enforced server-side, with atomic database quotas. A batch sends each selected file as a separate item; folder selection packages one ZIP. Failed uploads can consume a reservation. Limits are intentionally conservative; they do **not** guarantee staying inside any provider's free allowance.
- Download access expires **24 hours after upload reservation**. Daily cleanup normally physically deletes expired encrypted objects within the following 24 hours. If cleanup fails, bytes can remain longer even though the app denies access. Monitor cleanup and storage use. Downloaded/rejected objects are retained until that scheduled deletion; they disappear from the pending inbox immediately. Devices themselves persist so their inbox codes and public keys remain usable.
- AES-256-GCM encrypts content and filenames in the browser; RSA-OAEP wraps the AES key for the recipient. The backend sees sender/receiver addresses, item type, encrypted size and timestamps, not plaintext. The public-key directory is trusted: there is no out-of-band fingerprint verification against a malicious server. This is not independently security-audited.
- Private keys/credentials live in browser local storage. Clearing site data, using private browsing, switching browser/profile/domain, or losing that device can make existing requests **unrecoverable**. No account recovery or identity export is implemented. XSS or browser/device compromise can expose local keys. Share codes only with people you trust; strangers who know the code can submit requests within the limits, but cannot read the inbox.
- Signed upload URLs are limited to one server-chosen object path; download URLs expire after 60 seconds. Browser uploads go directly to storage, avoiding Vercel's request-body limits. Incomplete uploads never appear in the receiver inbox. Keep the sender open until Queued: this is not a service-worker/background-upload feature. If confirmation fails, retry; unconfirmed objects expire automatically.
- Storage/database and download bandwidth may incur costs. Review Supabase quotas/billing before inviting other users. API/device/IP and global quotas are basic abuse controls, not bot-proof protection. A public launch should add anti-bot registration, monitoring, and a security review. Never disable college security controls; HTTPS storage access can also be blocked by network policy.

## Verification

Local unit checks (no service credentials required):

```powershell
node --import tsx --test tests/later.test.ts
npm.cmd run build
```

After provisioning Supabase, run the opt-in integration test below. It creates three temporary test inboxes and one small encrypted object, tests unauthorized access, upload completion, download/decryption and expiry, then removes its test records/object. It uses a few daily quota slots. Use a test project first.

```powershell
$env:RUN_LATER_INTEGRATION = "1"
node --env-file=.env.local --import tsx --test tests/later.integration.test.ts
Remove-Item Env:RUN_LATER_INTEGRATION
```

Also test Reject, a failed upload, page refresh, receiver offline during upload, sender offline during download, expired requests, and successful scheduled cleanup. Actual downloads still depend on browser permissions; acceptance hands the decrypted file to the browser but cannot prove it was saved to disk.

Existing dependency audit warnings remain separate work. Do not treat a passing build as a production security audit.

## Existing installations after the swooshit rename

Redeploy both the frontend and signaling server together, and rerun `supabase/offline.sql` to create the `swooshit-later` bucket. Browser storage keys and the encrypted transfer format now use the new name: pair trusted devices again and create a new offline inbox on each device. Download pending offline items using the previous app version before upgrading; the renamed app cannot decrypt those existing items. Saved theme preferences and live device codes also reset. Update hosting project names and URLs separately in your hosting accounts if desired.
