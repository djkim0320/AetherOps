import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";

export const protectedSecretPrefix = "enc:v1:";

const algorithm = "aes-256-gcm";
const aad = Buffer.from("aetherops-settings-secret:v1", "utf8");
const salt = "aetherops-settings-machine-user-bound:v1";

export function encryptMachineBoundSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, deriveMachineUserKey(), iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${protectedSecretPrefix}${toBase64Url(iv)}:${toBase64Url(tag)}:${toBase64Url(encrypted)}`;
}

export function decryptMachineBoundSecret(value: string): string | undefined {
  if (!value.startsWith(protectedSecretPrefix)) return undefined;
  const parts = value.slice(protectedSecretPrefix.length).split(":");
  if (parts.length !== 3) return undefined;
  try {
    const [iv, tag, encrypted] = parts.map(fromBase64Url);
    if (iv.byteLength !== 12 || tag.byteLength !== 16 || encrypted.byteLength === 0) return undefined;
    const decipher = createDecipheriv(algorithm, deriveMachineUserKey(), iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function deriveMachineUserKey(): Buffer {
  return scryptSync(machineUserMaterial(), salt, 32);
}

function machineUserMaterial(): string {
  let username = "unknown-user";
  try {
    username = userInfo().username || username;
  } catch {
    username = process.env.USERNAME || process.env.USER || username;
  }
  return [process.platform, process.arch, hostname(), username, homedir()].join("\0");
}

function toBase64Url(value: Buffer): string {
  return value.toString("base64url");
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
