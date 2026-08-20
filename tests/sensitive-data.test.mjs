import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createSensitiveDataCipher } from "../src/domain/sensitive-data.js";

test("encrypts sensitive values with authenticated AES-256-GCM envelopes", () => {
  const cipher = createSensitiveDataCipher(randomBytes(32).toString("base64url"));
  const encrypted = cipher.encrypt("19100000000");
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(encrypted.includes("19100000000"), false);
  assert.equal(cipher.decrypt(encrypted), "19100000000");
  const json = cipher.encryptJson({ street: "Avenida Exemplo", number: "501" });
  assert.equal(JSON.stringify(json).includes("Avenida Exemplo"), false);
  assert.deepEqual(cipher.decryptJson(json), { street: "Avenida Exemplo", number: "501" });
});

test("rejects invalid encryption keys and modified ciphertext", () => {
  assert.throws(() => createSensitiveDataCipher("short"), /32 bytes/);
  const cipher = createSensitiveDataCipher(randomBytes(32).toString("base64url"));
  const encrypted = cipher.encrypt("sensitive");
  const modified = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => cipher.decrypt(modified));
});
