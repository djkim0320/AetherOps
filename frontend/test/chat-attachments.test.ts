import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentAccept,
  MAX_CHAT_ATTACHMENTS,
  prepareChatAttachments
} from "../src/chat-attachments.ts";

test("chat attachment picker includes documents, text, and images", () => {
  const accept = attachmentAccept();
  for (const value of [".pdf", ".docx", ".xlsx", ".pptx", ".md", "image/png"]) {
    assert.match(accept, new RegExp(value.replace(".", "\\.")));
  }
});

test("document files are encoded for the chat API", async () => {
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "sample.pdf", {
    type: "application/pdf"
  });
  const [attachment] = await prepareChatAttachments([file], []);
  assert.equal(attachment.kind, "document");
  assert.equal(attachment.name, "sample.pdf");
  assert.equal(attachment.data, "JVBERi0=");
});

test("chat attachments enforce the bounded file count", async () => {
  const files = Array.from({ length: MAX_CHAT_ATTACHMENTS + 1 }, (_, index) =>
    new File(["ok"], `${index}.txt`, { type: "text/plain" })
  );
  await assert.rejects(prepareChatAttachments(files, []), /4개/);
});
