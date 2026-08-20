import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createBotChallenge } from "../src/http/bot-challenge.js";

function responseCapture() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function solve(challenge) {
  for (let nonce = 0; nonce < 2_000_000; nonce += 1) {
    const proof = `${challenge.token}.${nonce}`;
    if (crypto.createHash("sha256").update(proof).digest("hex").startsWith("0".repeat(challenge.difficulty))) {
      return proof;
    }
  }
  throw new Error("Não foi possível resolver o desafio de teste.");
}

test("desafio antibot exige trabalho, idade mínima e impede reutilização", async () => {
  let clock = Date.now();
  const protection = createBotChallenge({ enabled: true, now: () => clock });
  const issued = responseCapture();
  protection.issue({}, issued);
  assert.equal(issued.statusCode, 200);
  const proof = solve(issued.body);

  clock += 650;
  let accepted = false;
  protection.verify({ get: (name) => name.toLowerCase() === "x-galatic-bot-proof" ? proof : null }, responseCapture(), () => { accepted = true; });
  assert.equal(accepted, true);

  const replay = responseCapture();
  protection.verify({ get: () => proof }, replay, () => assert.fail("prova reutilizada foi aceita"));
  assert.equal(replay.statusCode, 400);
});
