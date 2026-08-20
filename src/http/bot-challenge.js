import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function equal(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createBotChallenge({ enabled = false, now = () => Date.now() } = {}) {
  const secret = randomBytes(32);
  const used = new Map();
  const difficulty = 3;
  const maximumAgeMs = 10 * 60_000;
  const minimumAgeMs = 600;

  function sign(payload) {
    return createHmac("sha256", secret).update(payload).digest("base64url");
  }

  function issue(_request, response) {
    if (!enabled) return response.status(204).end();
    const payload = Buffer.from(JSON.stringify({ issued: now(), nonce: randomBytes(16).toString("base64url") })).toString("base64url");
    const token = `${payload}.${sign(payload)}`;
    response.set("Cache-Control", "no-store");
    return response.json({ token, difficulty, algorithm: "sha256", expires_in: maximumAgeMs / 1000 });
  }

  function verify(request, response, next) {
    if (!enabled) return next();
    const proof = String(request.get("x-galatic-bot-proof") ?? "");
    const parts = proof.split(".");
    if (parts.length !== 3) return response.status(400).json({ error: "bot_challenge_required", message: "Atualize a página e tente novamente." });
    const [payload, signature, counter] = parts;
    if (!/^\d{1,10}$/.test(counter) || !equal(signature, sign(payload))) {
      return response.status(400).json({ error: "invalid_bot_challenge", message: "Atualize a página e tente novamente." });
    }
    let challenge;
    try { challenge = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
    catch { return response.status(400).json({ error: "invalid_bot_challenge" }); }
    const age = now() - Number(challenge.issued);
    const proofHash = createHash("sha256").update(`${payload}.${signature}.${counter}`).digest("hex");
    const challengeId = createHash("sha256").update(`${payload}.${signature}`).digest("hex");
    if (age < minimumAgeMs || age > maximumAgeMs || !proofHash.startsWith("0".repeat(difficulty)) || used.has(challengeId)) {
      return response.status(400).json({ error: "invalid_bot_challenge", message: "Atualize a página e tente novamente." });
    }
    used.set(challengeId, now() + maximumAgeMs);
    if (used.size > 5_000) for (const [key, expires] of used) if (expires <= now()) used.delete(key);
    return next();
  }

  return Object.freeze({ enabled, issue, verify });
}
