import { test as base, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

type Pair = { sender: Page; receiver: Page; receiverCode: string };
const test = base.extend<{ pair: Pair }>({
  pair: async ({ browser, baseURL }, providePair, testInfo) => {
    const contexts = await Promise.all([browser.newContext({ acceptDownloads: true }), browser.newContext({ acceptDownloads: true })]);
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    const errors: string[] = [];
    try {
      for (let index = 0; index < contexts.length; index++) {
        await contexts[index].addInitScript(code => localStorage.setItem("swooshit-device-code", code), index ? "654321" : "123456");
        pages[index].on("pageerror", error => errors.push(error.message));
      }
      await Promise.all(pages.map(page => page.goto(baseURL!)));
      for (const page of pages) await expect(page.getByRole("status").filter({ hasText: "Ready to receive requests" })).toBeVisible();
      const [sender, receiver] = pages;
      const receiverCode = (await receiver.locator("aside p").filter({ hasText: /^\s*\d{3}\s+\d{3}\s*$/ }).innerText()).replace(/\D/g, "");
      expect(receiverCode).toMatch(/^\d{6}$/);
      await providePair({ sender, receiver, receiverCode });
      expect(errors, "Uncaught browser errors").toEqual([]);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        for (let index = 0; index < pages.length; index++) {
          if (!pages[index].isClosed()) await pages[index].screenshot({ path: testInfo.outputPath(`browser-${index}.png`), fullPage: true }).catch(() => {});
        }
      }
      await Promise.all(contexts.map(context => context.close()));
    }
  },
});

async function request(pair: Pair, text = false) {
  await pair.sender.getByPlaceholder("ENTER 6-DIGIT CODE").fill(pair.receiverCode);
  await pair.sender.getByRole("button", { name: text ? "Send text" : "Request", exact: true }).click();
  await expect(pair.receiver.getByRole("button", { name: text ? "Accept & open editor" : "Accept & download", exact: true })).toBeVisible();
}

for (const empty of [false, true]) {
  test(`live ${empty ? "empty" : "binary"} file downloads exact bytes and receives acknowledgement`, async ({ pair }) => {
    const name = empty ? "empty.bin" : "binary-sample.bin";
    const bytes = empty ? Buffer.alloc(0) : Buffer.from(Array.from({ length: 65_553 }, (_, index) => index % 256));
    await pair.sender.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name, mimeType: "application/octet-stream", buffer: bytes });
    await request(pair);
    const downloading = pair.receiver.waitForEvent("download");
    await pair.receiver.getByRole("button", { name: "Accept & download", exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(name);
    expect(await download.failure()).toBeNull();
    const actual = await readFile((await download.path())!);
    expect(actual).toEqual(bytes);
    expect(createHash("sha256").update(actual).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    await expect(pair.sender.getByRole("button", { name: `Remove ${name}`, exact: true })).toHaveCount(0);
  });
}

test("live folder selection downloads a ZIP with nested paths and exact contents", async ({ pair }, testInfo) => {
  const folder = testInfo.outputPath("sample-folder");
  await mkdir(path.join(folder, "nested"), { recursive: true });
  const contents = new Map([
    ["hello.txt", Buffer.from("hello from Swooshit\n")],
    ["nested/日本語.bin", Buffer.from([0, 255, 128, 10, 13])],
    ["nested/empty.txt", Buffer.alloc(0)],
  ]);
  for (const [relative, bytes] of contents) await writeFile(path.join(folder, relative), bytes);
  await pair.sender.getByLabel("Choose folder", { exact: true }).setInputFiles(folder);
  await expect(pair.sender.getByRole("button", { name: "Remove sample-folder.zip", exact: true })).toBeVisible();
  await request(pair);
  const downloading = pair.receiver.waitForEvent("download");
  await pair.receiver.getByRole("button", { name: "Accept & download", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("sample-folder.zip");
  const zip = await JSZip.loadAsync(await readFile((await download.path())!), { checkCRC32: true });
  for (const [relative, bytes] of contents) expect(await zip.file(`sample-folder/${relative}`)!.async("nodebuffer")).toEqual(bytes);
  await expect(pair.sender.getByRole("button", { name: "Remove sample-folder.zip", exact: true })).toHaveCount(0);
});

test("live Unicode text crosses multiple chunks and preserves tabs and blank lines", async ({ pair }) => {
  const text = "\tconst greeting = 'Hello 🌍 日本語';\n  // indentation remains\n\n".repeat(600);
  await pair.sender.getByRole("button", { name: "</> CODE / TEXT", exact: true }).click();
  await pair.sender.getByRole("textbox", { name: "outgoing / snippet.txt", exact: true }).fill(text);
  await request(pair, true);
  await pair.receiver.getByRole("button", { name: "Accept & open editor", exact: true }).click();
  await expect(pair.receiver.getByRole("textbox", { name: "received / snippet.txt", exact: true })).toHaveValue(text);
  await expect(pair.receiver.getByRole("status").filter({ hasText: "Code received" })).toBeVisible();
});

test("offline receiver returns a visible error and retains the selected file", async ({ pair }) => {
  await pair.sender.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("keep me") });
  // 000000 is not registered by either of these isolated contexts.
  await pair.sender.getByPlaceholder("ENTER 6-DIGIT CODE").fill("000000");
  await pair.sender.getByRole("button", { name: "Request", exact: true }).click();
  await expect(pair.sender.getByText("That device is offline. Ask them to open swooshit.", { exact: true })).toBeVisible();
  await expect(pair.sender.getByRole("button", { name: "Remove retry.txt", exact: true })).toBeVisible();
  await expect(pair.sender.getByRole("status").filter({ hasText: "Transfer error" })).toBeVisible();
  await expect(pair.sender.getByRole("status").filter({ hasText: "waiting for receiver approval" })).toHaveCount(0);
});

test("rejection prevents delivery; sender has no rejection notification in the current protocol", async ({ pair }) => {
  const downloads: string[] = [];
  pair.receiver.on("download", download => downloads.push(download.suggestedFilename()));
  await pair.sender.locator('input[type="file"]:not([webkitdirectory])').setInputFiles({ name: "declined.txt", mimeType: "text/plain", buffer: Buffer.from("do not send") });
  await request(pair);
  await pair.receiver.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(pair.receiver.getByRole("button", { name: "Accept & download", exact: true })).toHaveCount(0);
  await expect(pair.sender.getByRole("button", { name: "Remove declined.txt", exact: true })).toBeVisible();
  // This assertion documents the existing UX limitation; it does not claim rejection feedback is complete.
  await expect(pair.sender.getByRole("status").filter({ hasText: "waiting for receiver approval" })).toBeVisible();
  expect(downloads).toEqual([]);
});
