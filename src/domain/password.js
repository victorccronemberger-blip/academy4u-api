import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(nodeScrypt);
const KEY_LENGTH = 64;

export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error("Informe um e-mail válido."), { code: "invalid_email" });
  }
  return email;
}

export function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 10 || password.length > 128) {
    throw Object.assign(new Error("A senha deve ter entre 10 e 128 caracteres."), { code: "invalid_password" });
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw Object.assign(new Error("Use letras e números na senha."), { code: "invalid_password" });
  }
  return password;
}

export async function hashPassword(value) {
  const password = validatePassword(value);
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(value, encoded) {
  const [algorithm, saltValue, hashValue] = String(encoded ?? "").split("$");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    const actual = Buffer.from(await scrypt(String(value ?? ""), salt, expected.length));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token) {
  return createHash("sha256").update(String(token ?? "")).digest("hex");
}
