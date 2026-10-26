# Screenshot and demo capture plan

Capture the running Swooshit app. Do not use generated images, altered progress states, or stock product mockups. No verified screenshots or demo video are currently included.

## Screenshot sequence

| Asset to capture | Real screen | Suggested caption |
| --- | --- | --- |
| `docs/images/live-transfer.png` | Live transfer panel after both devices register | Send files or text using the receiver's code. |
| `docs/images/receiver-approval.png` | Actual incoming request before acceptance | The receiver reviews a transfer before accepting. |
| `docs/images/received-text.png` | Actual received Unicode snippet in the editor | Code and text retain indentation and blank lines. |

These filenames are a capture plan, not existing assets. Add image links to the README Preview section only after the corresponding files exist and have been checked. Use descriptive alt text. An optional Send for later screenshot must come from a configured test project after a real encrypted upload; never imply it works without setup.

## Capture steps

1. Start frontend and signaling using the README. Confirm the frontend's exact origin is allowed.
2. Open two separate browser profiles, wait for registration, and use the code displayed in the receiver. A collision may change the requested code.
3. Use a harmless sample file and a short snippet containing tabs, Unicode, and blank lines. Do not capture personal filenames, real inboxes, credentials, environment files, or unrelated tabs.
4. Use a desktop viewport around 1440 × 1000. Capture the unmodified interface and the real receiver approval dialog.
5. Verify the downloaded file's hash matches the original and compare the text exactly. Record browser versions, OS, and direct versus TURN connection details in the final release checklist.
6. Save screenshots under `docs/images/`, inspect every image for private data, and embed only the real files. Local browser automation now verifies same-host Chrome transfers; record additional browser/network results separately rather than generalizing that evidence.

## Short demo sequence

- Show the receiver code and the sender's selected harmless file.
- Enter the code and request the transfer.
- Show receiver approval and actual progress.
- Show the saved file and a successful byte/hash comparison, then demonstrate text with preserved indentation.

Keep the clip short, use captions, and do not display secret-bearing Git history. Store video under `docs/media/` or upload it manually to GitHub, then verify the playable link before embedding it. No demo URL has been invented or published.

## Additional manual checks

- Direct connection: file, zero-byte file, folder ZIP, and Unicode text.
- TURN: repeat over a network requiring relay and confirm a selected relay candidate in WebRTC diagnostics.
- Disconnect mid-transfer, reject, refresh, and retry. Check messages remain understandable.
- Collision: open two clients with the same saved code and confirm neither takes over the other's requests.
- Send for later: register recipient, close it, queue content, return and decrypt within expiry; verify cleanup with a disposable test project.

Node/Socket.IO regression tests do not establish any of these browser or provider results.
