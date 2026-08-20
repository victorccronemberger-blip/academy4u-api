import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1";

function decodeKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64url");
  if (key.length !== 32) throw new Error("GALATIC_DATA_ENCRYPTION_KEY must encode exactly 32 bytes.");
  return key;
}

export function createSensitiveDataCipher(value) {
  const key = decodeKey(value);
  const api = {
    configured: Boolean(key),
    isEncrypted(input) { return String(input ?? "").startsWith(`${PREFIX}:`); },
    encrypt(input) {
      const plaintext = String(input ?? "");
      if (!plaintext || !key) return plaintext;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
    },
    decrypt(input) {
      const encoded = String(input ?? "");
      if (!encoded || !encoded.startsWith(`${PREFIX}:`)) return encoded;
      if (!key) throw new Error("Encrypted Galatic data cannot be read without GALATIC_DATA_ENCRYPTION_KEY.");
      const parts = encoded.split(":");
      if (parts.length !== 5) throw new Error("Encrypted Galatic data is malformed.");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64url"));
      decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64url")), decipher.final()]).toString("utf8");
    },
    encryptJson(input) {
      if (!key) return input;
      return { _encrypted: api.encrypt(JSON.stringify(input)) };
    },
    decryptJson(input) {
      const parsed = typeof input === "string" ? JSON.parse(input) : input;
      return parsed && typeof parsed === "object" && typeof parsed._encrypted === "string"
        ? JSON.parse(api.decrypt(parsed._encrypted))
        : parsed;
    },
  };
  return Object.freeze(api);
}
