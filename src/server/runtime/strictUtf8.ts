import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeStrictUtf8(bytes: Uint8Array, label = "text payload"): string {
  let text: string;
  try {
    text = strictUtf8Decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  if (text.includes("\uFFFD")) {
    throw new Error(`${label} contains Unicode replacement characters.`);
  }
  return text;
}

export function decodeStrictUtf8Chunks(chunks: Uint8Array[], label = "text payload"): string {
  return decodeStrictUtf8(Buffer.concat(chunks), label);
}

export function readStrictUtf8File(path: string, label = path): string {
  return decodeStrictUtf8(readFileSync(path), label);
}
