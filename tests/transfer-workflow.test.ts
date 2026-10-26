import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createFolderArchive } from "../lib/folder-archive";
import { createIdentity, encryptFile, decryptFile } from "../lib/later/crypto";
import { removeTransferredFile } from "../lib/transfer-files";

test("offline folder pipeline preserves ZIP paths and bytes through encryption and decryption", async () => {
  const contents = new Uint8Array([0, 255, 128, 10, 13]);
  const file = new File([contents], "sample.bin");
  Object.defineProperty(file, "webkitRelativePath", { value: "example/nested/sample.bin" });
  const zip = await createFolderArchive([file]);
  const recipient = await createIdentity();
  const sealed = await encryptFile(zip, recipient.publicKey, "file");
  const opened = await decryptFile(await sealed.blob.arrayBuffer(), sealed.envelope, recipient);
  assert.equal(opened.kind, "file");
  assert.equal(opened.file.name, "example.zip");
  assert.equal(opened.file.type, "application/zip");
  const archive = await JSZip.loadAsync(await opened.file.arrayBuffer(), { checkCRC32: true });
  assert.deepEqual(await archive.file(file.webkitRelativePath)!.async("uint8array"), contents);
});

test("text pipeline preserves UTF-8 whitespace and receipts cannot remove a newly queued copy", async () => {
  const text = "\tconst greeting = 'hello 🌍';\r\n  // indentation\n\n";
  const queued = new File([text], "snippet.txt", { type: "text/plain;charset=utf-8" });
  const newlyQueued = new File([text], "snippet.txt", { type: queued.type });
  const recipient = await createIdentity();
  const sealed = await encryptFile(queued, recipient.publicKey, "text");
  const opened = await decryptFile(await sealed.blob.arrayBuffer(), sealed.envelope, recipient);
  assert.equal(opened.kind, "text");
  assert.equal(await opened.file.text(), text);
  const queue = [queued, newlyQueued];
  const afterReceipt = removeTransferredFile(queue, queued);
  assert.deepEqual(afterReceipt, [newlyQueued]);
  assert.equal(removeTransferredFile(afterReceipt, queued), afterReceipt);
  assert.deepEqual(queue, [queued, newlyQueued]);
});
