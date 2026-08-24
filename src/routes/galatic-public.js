import { normalizeEmail, opaqueToken, tokenHash } from "../domain/password.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";
import { allowBodyFields } from "../http/request-security.js";

const clean = (value, maximum) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
const newsletterToken = () => tokenHash(opaqueToken());
const expiresIn = (milliseconds) => new Date(Date.now() + milliseconds).toISOString().slice(0, 23).replace("T", " ");

export function createGalaticPublicRouter(express, { store, notifications = null, botChallenge = { issue: (_request, response) => response.status(204).end(), verify: (_request, _response, next) => next() } }) {
  const router = express.Router();
  const writeLimiter = createFixedWindowLimiter({ limit: 20, windowMs: 60_000, prefix: "galatic-public-write" });

  router.get("/security/challenge", writeLimiter, botChallenge.issue);

  router.get("/catalog/products", async (_request, response) => {
    response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return response.json({ products: await store.listCatalogProducts() });
  });
  router.get("/catalog/products/:slug", async (request, response) => {
    const product = await store.getCatalogProduct(request.params.slug);
    if (!product) return response.status(404).json({ error: "product_not_found", message: "Produto não encontrado." });
    response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return response.json({ product });
  });
  router.post("/newsletter/subscribe", writeLimiter, botChallenge.verify, allowBodyFields(["email", "consent", "consent_version", "website"]), async (request, response) => {
    if (request.body?.website) return response.json({ message: "Inscrição recebida." });
    if (!notifications?.ready) return response.status(503).json({ error: "email_unavailable", message: "A confirmação por e-mail está temporariamente indisponível." });
    try {
      const email = normalizeEmail(request.body?.email);
      if (request.body?.consent !== true) throw new Error("Confirme que deseja receber as novidades.");
      const consentVersion = clean(request.body?.consent_version, 32);
      if (!/^site-\d{4}-\d{2}$/.test(consentVersion)) throw new Error("Atualize a página e confirme novamente.");
      const token = newsletterToken();
      await store.requestNewsletterSubscription({ email, tokenHash: tokenHash(token), expiresAt: expiresIn(24 * 3600000), consentVersion });
      await notifications.sendNewsletterVerification({ email, token });
      return response.json({ message: "Confira seu e-mail para confirmar a inscrição na Carta da Mesa." });
    } catch (error) { return response.status(400).json({ error: "invalid_newsletter", message: error.message }); }
  });
  router.post("/newsletter/confirm", writeLimiter, allowBodyFields(["token"]), async (request, response) => {
    const token = clean(request.body?.token, 64);
    if (!/^[a-f0-9]{64}$/i.test(token)) return response.status(400).json({ error: "invalid_newsletter_token", message: "Este link é inválido ou expirou." });
    const unsubscribeToken = newsletterToken();
    const email = await store.confirmNewsletterSubscription(tokenHash(token), tokenHash(unsubscribeToken));
    if (!email) return response.status(400).json({ error: "invalid_newsletter_token", message: "Este link é inválido ou expirou." });
    notifications?.sendNewsletterConfirmed?.({ email, unsubscribeToken }).catch((error) => {
      console.error("Could not send Galatic newsletter welcome", { type: error?.name, code: error?.code });
    });
    return response.json({ message: "Inscrição confirmada. Você já está na Carta da Mesa." });
  });
  router.post("/newsletter/unsubscribe", writeLimiter, allowBodyFields(["token"]), async (request, response) => {
    const token = clean(request.body?.token, 64);
    if (!/^[a-f0-9]{64}$/i.test(token)) return response.status(400).json({ error: "invalid_newsletter_token", message: "Este link é inválido ou já foi utilizado." });
    const email = await store.unsubscribeNewsletter(tokenHash(token));
    if (!email) return response.status(400).json({ error: "invalid_newsletter_token", message: "Este link é inválido ou já foi utilizado." });
    notifications?.sendNewsletterUnsubscribed?.({ email }).catch((error) => {
      console.error("Could not send Galatic newsletter cancellation", { type: error?.name, code: error?.code });
    });
    return response.json({ message: "Inscrição cancelada. Você não receberá novos e-mails da Carta da Mesa." });
  });
  router.post("/contact", writeLimiter, botChallenge.verify, allowBodyFields(["name", "email", "subject", "message", "website"]), async (request, response) => {
    if (request.body?.website) return response.json({ message: "Mensagem recebida." });
    try {
      const name = clean(request.body?.name, 180); const email = normalizeEmail(request.body?.email);
      const subject = clean(request.body?.subject, 180); const message = clean(request.body?.message, 5000);
      if (name.length < 2 || subject.length < 3 || message.length < 10) throw new Error("Complete os dados da mensagem.");
      const protocol = await store.createContactMessage({ name, email, subject, message });
      notifications?.sendContactReceived?.({ email, name, protocol, subject }).catch((error) => {
        console.error("Could not send Galatic contact receipt", { type: error?.name, code: error?.code });
      });
      notifications?.sendContactAlert?.({ email, name, protocol, subject }).catch((error) => {
        console.error("Could not send Galatic contact alert", { type: error?.name, code: error?.code });
      });
      return response.status(201).json({ message: "Mensagem recebida pela equipe Galatic.", protocol });
    } catch (error) { return response.status(400).json({ error: "invalid_contact", message: error.message }); }
  });
  router.post("/orders/lookup", writeLimiter, botChallenge.verify, allowBodyFields(["email", "order_number"]), async (request, response) => {
    try {
      const email = normalizeEmail(request.body?.email); const orderId = clean(request.body?.order_number, 36);
      if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new Error("Informe um pedido válido.");
      const order = await store.lookupOrder(orderId, email);
      return order ? response.json({ order, tracking: await store.trackingForOrder(orderId) }) : response.status(404).json({ error: "order_not_found", message: "Pedido não encontrado para este e-mail." });
    } catch (error) { return response.status(400).json({ error: "invalid_order_lookup", message: error.message }); }
  });
  return router;
}
