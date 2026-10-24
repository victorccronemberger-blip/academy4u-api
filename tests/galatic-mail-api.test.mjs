import test from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
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

test("renders every new Galatic lifecycle email with the official visual signature", async (context) => {
  const deliveries = [];
  context.mock.method(globalThis, "fetch", async (_url, options = {}) => {
    deliveries.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  });
  const notifications = createGalaticNotifications({
    GALATIC_MAIL_API_TOKEN: "secret-token",
    GALATIC_MAIL_API_MAILBOX_ID: "AC_galatic",
    GALATIC_ADMIN_EMAIL: "comercial@galatic.com.br",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.com.br",
  });
  const customer = { first_name: "Victor", email: "victor@example.com" };
  await notifications.sendWelcome({ customer });
  await notifications.sendPasswordChanged({ customer });
  await notifications.sendNewsletterVerification({ email: customer.email, token: "a".repeat(64) });
  await notifications.sendNewsletterConfirmed({ email: customer.email, unsubscribeToken: "b".repeat(64) });
  await notifications.sendNewsletterUnsubscribed({ email: customer.email });
  await notifications.sendContactReceived({ email: customer.email, name: "Victor", protocol: "GAL-123", subject: "Meu pedido" });
  await notifications.sendContactAlert({ email: customer.email, name: "Victor", protocol: "GAL-123", subject: "Meu pedido" });
  await notifications.sendOrderCreated({ email: customer.email, name: "Victor", orderId: "order-12345678", totalCents: 18990, method: "pix" });
  await notifications.sendShippingUpdate({ email: customer.email, name: "Victor", orderId: "order-12345678", status: "in_transit", trackingCode: "BR123GAL" });

  assert.equal(deliveries.length, 9);
  assert.deepEqual(deliveries.map((item) => item.to[0]), [
    customer.email, customer.email, customer.email, customer.email, customer.email, customer.email, "comercial@galatic.com.br",
    customer.email, customer.email,
  ]);
  for (const delivery of deliveries) {
    assert.match(delivery.html, /galatic-wordmark-email-v2\.png/);
    assert.match(delivery.html, /galatic\.com\.br/);
    assert.match(delivery.html, /prepara/);
    assert.doesNotMatch(delivery.html, /CNPJ 67\.956\.916\/0001-90/);
    assert.match(delivery.html, /comercial@galatic\.com\.br/);
    assert.doesNotMatch(delivery.html, /<div[^>]*>GALATIC<\/div>/);
  }
  assert.match(deliveries[0].html, /galatic-email-account-v1\.jpg/);
  assert.match(deliveries[2].html, /galatic-email-community-v1\.jpg/);
  assert.match(deliveries[7].html, /galatic-email-order-v1\.jpg/);
  assert.match(deliveries[8].html, /galatic-email-shipping-v1\.jpg/);
  assert.match(deliveries[4].text, /Você poderá se inscrever novamente quando quiser\./);
});

test("Hostinger Mail API sends complete plaintext with exact verification, reset and unsubscribe links", async (context) => {
  const deliveries = [];
  context.mock.method(globalThis, "fetch", async (_url, options = {}) => {
    deliveries.push(JSON.parse(options.body));
    return new Response(null, { status: 204 });
  });
  const origin = "https://galatic.test/campaign&source=fixture";
  const notifications = createGalaticNotifications({
    GALATIC_MAIL_API_TOKEN: "synthetic-token",
    GALATIC_MAIL_API_MAILBOX_ID: "synthetic-mailbox",
    GALATIC_PUBLIC_ORIGIN: origin,
  });
  const customer = { first_name: "Ana <&>", email: "ana@example.test" };
  const verificationToken = "verify+synthetic&token";
  const resetToken = "reset+synthetic&token";
  const newsletterToken = "newsletter+synthetic&token";
  const unsubscribeToken = "unsubscribe+synthetic&token";
  await notifications.sendEmailVerification({ customer, token: verificationToken });
  await notifications.sendPasswordReset({ customer, token: resetToken });
  await notifications.sendNewsletterVerification({ email: customer.email, token: newsletterToken });
  await notifications.sendNewsletterConfirmed({ email: customer.email, unsubscribeToken });

  const expectedLinks = [
    `${origin}/confirmar-email/?token=${encodeURIComponent(verificationToken)}`,
    `${origin}/recuperar-acesso/?token=${encodeURIComponent(resetToken)}`,
    `${origin}/newsletter/confirmar/?token=${encodeURIComponent(newsletterToken)}`,
    `${origin}/newsletter/descadastrar/?token=${encodeURIComponent(unsubscribeToken)}`,
  ];
  assert.equal(deliveries.length, expectedLinks.length);
  for (const [index, link] of expectedLinks.entries()) {
    assert.ok(deliveries[index].text.includes(link), `plaintext must include exact link ${index + 1}`);
    assert.doesNotMatch(deliveries[index].text, /&amp;/);
  }
  assert.match(deliveries[0].text, /Olá, Ana <&>\./);
  assert.match(deliveries[0].html, /Ana &lt;&amp;&gt;/);
  assert.match(deliveries[1].text, /O link expira em 1 hora/);
  assert.match(deliveries[2].text, /Carta da Mesa/);
  assert.match(deliveries[3].text, /Sua inscrição está ativa/);
  assert.match(deliveries[3].text, /Cancelar inscrição:\nhttps:\/\/galatic\.test\/campaign&source=fixture\/newsletter\/descadastrar\//);
  assert.ok(deliveries.every((delivery) => delivery.text.includes("Central de ajuda")));
});

test("SMTP sends complete plaintext with order, shipping and tracking details; custom preview remains HTML", async (context) => {
  const deliveries = [];
  context.mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message) => { deliveries.push(message); return { accepted: [message.to] }; },
    verify: async () => true,
  }));
  const notifications = createGalaticNotifications({
    GALATIC_SMTP_HOST: "smtp.fixture.invalid",
    GALATIC_SMTP_USER: "mailer@example.test",
    GALATIC_SMTP_PASSWORD: "synthetic-password",
    GALATIC_PUBLIC_ORIGIN: "https://galatic.test",
  });
  await notifications.sendOrderCreated({
    email: "buyer@example.test", name: "João <Mesa>", orderId: "fixture-order-12345678", totalCents: 18990, method: "pix",
  });
  await notifications.sendShippingUpdate({
    email: "buyer@example.test", name: "João <Mesa>", orderId: "fixture-order-12345678", status: "in_transit",
    trackingCode: "BR-SYNTH-123", description: "Objeto em trânsito — previsão atualizada.",
  });

  assert.equal(deliveries.length, 2);
  assert.match(deliveries[0].text, /O pedido fixture-order-12345678 foi registrado no valor de R\$ 189,90/);
  assert.match(deliveries[0].text, /Pagamento: Pix à vista/);
  assert.match(deliveries[0].text, /Acompanhar pedido:\nhttps:\/\/galatic\.test\/pedido\/\?order_id=fixture-order-12345678/);
  assert.match(deliveries[1].text, /Pedido em trânsito/);
  assert.match(deliveries[1].text, /Código de rastreio: BR-SYNTH-123/);
  assert.match(deliveries[1].text, /Objeto em trânsito — previsão atualizada\./);
  assert.match(deliveries[1].text, /Acompanhar entrega:\nhttps:\/\/galatic\.test\/pedido\/\?order_id=fixture-order-12345678/);
  assert.match(deliveries[0].html, /João &lt;Mesa&gt;/);

  const preview = notifications.previewCustom({ subject: "Aviso <sintético>", message: "Linha um\nLinha dois" });
  assert.equal(typeof preview, "string");
  assert.match(preview, /<html lang="pt-BR">/);
  assert.match(preview, /Aviso &lt;sintético&gt;/);
  assert.match(preview, /Linha um<br>\s*Linha dois/);
});
