import test from "node:test";
import assert from "node:assert/strict";
import { createGalaticNotifications } from "../src/integrations/email/galatic-notifications.js";

test("prefers the Hostinger Mail API and verifies the configured mailbox", async (context) => {
  const calls = [];
  context.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/v1/me")) {
      return new Response(JSON.stringify({ data: { mailboxes: [{ resourceId: "AC_galatic", address: "noreply@galatic.com.br" }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  });

  const notifications = createGalaticNotifications({
    GALATIC_MAIL_API_TOKEN: "secret-token",
    GALATIC_MAIL_API_MAILBOX_ID: "AC_galatic",
    GALATIC_MAIL_FROM_NAME: "Galatic",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
    // A API deve prevalecer mesmo se houver um SMTP legado configurado.
    GALATIC_SMTP_HOST: "smtp.invalid",
    GALATIC_SMTP_USER: "legacy@example.com",
    GALATIC_SMTP_PASSWORD: "legacy-password",
  });

  assert.equal(notifications.provider, "hostinger-mail-api");
  assert.equal(await notifications.verify(), true);
  await notifications.sendCustom({ recipient: "cliente@example.com", subject: "Pedido enviado", message: "Seu jogo está a caminho." });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.mail.hostinger.com/api/v1/me");
  assert.equal(calls[1].url, "https://api.mail.hostinger.com/api/v1/mailboxes/AC_galatic/send");
  assert.equal(calls[1].options.headers.authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(calls[1].options.body).to, ["cliente@example.com"]);
});

test("rejects a Hostinger token that cannot manage the configured mailbox", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: { mailboxes: [] } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const notifications = createGalaticNotifications({
    GALATIC_MAIL_API_TOKEN: "secret-token",
    GALATIC_MAIL_API_MAILBOX_ID: "AC_missing",
  });
  await assert.rejects(() => notifications.verify(), /não pertence ao token/);
});
