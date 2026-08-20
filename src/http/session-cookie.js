import { timingSafeEqual } from "node:crypto";

export const CUSTOMER_SESSION_COOKIE = "__Host-galatic_session";
export const ADMIN_SESSION_COOKIE = "__Host-galatic_admin_session";

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readCookie(request, name) {
  const source = String(request.get("cookie") ?? "");
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (!safeEqual(key, name)) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return null; }
  }
  return null;
}

export function sessionCredential(request, cookieName) {
  const authorization = String(request.get("authorization") ?? "");
  const bearer = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{32,})$/i)?.[1] ?? null;
  if (bearer) return { token: bearer, transport: "bearer" };
  const cookie = readCookie(request, cookieName);
  return /^[A-Za-z0-9_-]{32,}$/.test(cookie ?? "")
    ? { token: cookie, transport: "cookie" }
    : null;
}

function cookieValue(name, value, maxAgeSeconds) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Partitioned",
    "Priority=High",
  ].join("; ");
}

export function setSessionCookie(response, name, token, maxAgeSeconds) {
  response.append("Set-Cookie", cookieValue(name, token, maxAgeSeconds));
}

export function clearSessionCookie(response, name) {
  response.append("Set-Cookie", cookieValue(name, "", 0));
}
