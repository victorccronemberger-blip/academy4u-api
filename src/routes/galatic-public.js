import { normalizeEmail } from "../domain/password.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";

const clean = (value, maximum) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);

export function createGalaticPublicRouter(express, { store, notifications = null }) {
  const router = express.Router();
  const writeLimiter = createFixedWindowLimiter({ limit: 20, windowMs: 60_000, prefix: "galatic-public-write" });

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
  router.post("/newsletter/subscribe", writeLimiter, async (request, response) => {
    if (request.body?.website) return response.json({ message: "Inscrição recebida." });
    try {
      const email = normalizeEmail(request.body?.email);
      if (request.body?.consent !== true) throw new Error("Confirme que deseja receber as novidades.");
      await store.upsertNewsletter(email, true);
      notifications?.sendNewsletterConfirmed?.({ email }).catch((error) => {
        console.error("Could not send Galatic newsletter email", { type: error?.name, code: error?.code });
      });
      return response.json({ message: "Inscrição confirmada. Você já está na Carta da Mesa." });
    } catch (error) { return response.status(400).json({ error: "invalid_newsletter", message: error.message }); }
  });
  router.post("/contact", writeLimiter, async (request, response) => {
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
  router.post("/orders/lookup", writeLimiter, async (request, response) => {
    try {
      const email = normalizeEmail(request.body?.email); const orderId = clean(request.body?.order_number, 36);
      if (!/^[0-9a-f-]{36}$/i.test(orderId)) throw new Error("Informe um pedido válido.");
      const order = await store.lookupOrder(orderId, email);
      return order ? response.json({ order, tracking: await store.trackingForOrder(orderId) }) : response.status(404).json({ error: "order_not_found", message: "Pedido não encontrado para este e-mail." });
    } catch (error) { return response.status(400).json({ error: "invalid_order_lookup", message: error.message }); }
  });
  return router;
}
