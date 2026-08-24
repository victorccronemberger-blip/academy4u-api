import { hashPassword, normalizeEmail, opaqueToken, tokenHash, verifyPassword } from "../domain/password.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";
import { allowBodyFields } from "../http/request-security.js";
import { ADMIN_SESSION_COOKIE, clearSessionCookie, sessionCredential, setSessionCookie } from "../http/session-cookie.js";
import { normalizeAsaasPaymentStatus } from "../domain/payment-status.js";

const clean = (value, maximum = 255) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
const integer = (value, minimum = 0) => {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= minimum ? result : null;
};
const decimal = (value, minimum = 0) => {
  if (value === "" || value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= minimum ? result : null;
};
const enabled = (value) => value === true || value === 1 || value === "1" || value === "true" || value === "on";
const expiresAt = (milliseconds) => new Date(Date.now() + milliseconds).toISOString().slice(0, 23).replace("T", " ");
const PRODUCT_FIELDS = ["sku", "slug", "name", "title", "unit_amount", "price", "cost_amount", "cost", "description",
  "image_url", "image", "source_url", "source", "category", "brand", "active", "manage_stock", "manage",
  "stock_quantity", "stock", "weight_grams", "length_cm", "width_cm", "height_cm", "editorial_status"];
const COUPON_FIELDS = ["code", "description", "discount_type", "type", "discount_value", "value", "minimum_subtotal",
  "minimum_cents", "minimum", "usage_limit", "limit", "per_customer_limit", "per_customer", "per", "active"];

function safeUrl(value, { local = false } = {}) {
  const raw = clean(value, 1000);
  if (!raw) return "";
  if (local && /^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password) return parsed.href;
  } catch {}
  throw Object.assign(new Error("Informe uma URL HTTPS válida."), { code: "invalid_url" });
}

function adminView(admin) {
  return { id: admin.id, name: admin.name, email: admin.email, role: admin.role, status: admin.status };
}

function productInput(body, existingSku = null) {
  const sku = clean(existingSku ?? body?.sku, 80).toUpperCase();
  const slug = clean(body?.slug, 100).toLowerCase();
  const name = clean(body?.name ?? body?.title, 255);
  const unitAmount = body?.unit_amount !== undefined ? integer(body.unit_amount) : Math.round(Number(body?.price ?? 0) * 100);
  const costAmount = body?.cost_amount !== undefined ? integer(body.cost_amount) : (body?.cost === "" || body?.cost == null ? null : Math.round(Number(body.cost) * 100));
  if (!/^[A-Z0-9_-]{2,80}$/.test(sku) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || name.length < 2 || unitAmount === null) {
    throw Object.assign(new Error("Revise SKU, slug, nome e preço."), { code: "invalid_product" });
  }
  const logistics = {
    weightGrams: decimal(body?.weight_grams, 1), lengthCm: decimal(body?.length_cm, 0.1),
    widthCm: decimal(body?.width_cm, 0.1), heightCm: decimal(body?.height_cm, 0.1),
  };
  return { sku, slug, name, unitAmount, costAmount, description: clean(body?.description, 20_000),
    imageUrl: safeUrl(body?.image_url ?? body?.image, { local: true }),
    sourceUrl: safeUrl(body?.source_url ?? body?.source),
    category: clean(body?.category, 120), brand: clean(body?.brand, 120), active: enabled(body?.active),
    manageStock: enabled(body?.manage_stock ?? body?.manage), stockQuantity: integer(body?.stock_quantity ?? body?.stock),
    ...logistics, editorialStatus: clean(body?.editorial_status, 24) || "draft" };
}

function couponInput(body) {
  const type = (body?.discount_type ?? body?.type) === "fixed" ? "fixed" : "percent";
  const value = integer(body?.discount_value ?? body?.value, 1);
  const minimum = integer(body?.minimum_subtotal ?? body?.minimum_cents ?? Math.round(Number(body?.minimum ?? 0) * 100));
  const rawLimit = body?.usage_limit ?? body?.limit;
  const limit = rawLimit === "" || rawLimit == null ? null : integer(rawLimit, 1);
  const perCustomer = integer(body?.per_customer_limit ?? body?.per_customer ?? body?.per, 1);
  if (value === null || minimum === null || perCustomer === null || (type === "percent" && value > 100)) {
    throw Object.assign(new Error("Revise as regras do cupom."), { code: "invalid_coupon" });
  }
  return { description: clean(body?.description), type, value, minimum, limit, perCustomer, active: body?.active === undefined || enabled(body.active) };
}

export function createGalaticAdminRouter(express, { environment, store, notifications = null, fulfillment = null, asaasClient = null,
  botChallenge = { verify: (_request, _response, next) => next() } }) {
  const router = express.Router();
  const authLimiter = createFixedWindowLimiter({ limit: 10, windowMs: 60_000, prefix: "galatic-admin-auth-ip" });
  const identityLimiter = createFixedWindowLimiter({
    limit: 5,
    windowMs: 15 * 60_000,
    prefix: "galatic-admin-auth-identity",
    keyGenerator: (request) => `${request.ip}:${tokenHash(String(request.body?.email ?? "").trim().toLowerCase())}`,
  });
  const dummyPasswordHash = hashPassword("GalaticDummyAdminPassword2026");

  async function notifyOnce(orderId, key, method, extra = {}) {
    if (!notifications?.[method] || !store.getOrderNotification) return;
    const order = await store.getOrderNotification(orderId);
    const notificationKey = `${key}:${orderId}`;
    if (!order || !(await store.claimNotification?.(notificationKey))) return;
    notifications[method]({ ...order, ...extra }).catch(async (error) => {
      await store.releaseNotification?.(notificationKey).catch(() => {});
      console.error("Could not send Galatic admin transaction email", { method, type: error?.name, code: error?.code });
    });
  }

  async function authenticate(request, response, next) {
    const credential = sessionCredential(request, ADMIN_SESSION_COOKIE);
    const admin = credential ? await store.adminForSession(tokenHash(credential.token)) : null;
    if (!admin) return response.status(401).json({ error: "unauthorized", message: "Acesso administrativo não autorizado." });
    request.galaticAdmin = admin;
    request.galaticAdminTokenHash = tokenHash(credential.token);
    return next();
  }

  function requireOwner(request, response, next) {
    return request.galaticAdmin?.role === "owner"
      ? next()
      : response.status(403).json({ error: "owner_required", message: "Esta ação exige acesso de proprietário." });
  }

  router.post("/login", authLimiter, identityLimiter, botChallenge.verify,
    allowBodyFields(["email", "password", "website"]), async (request, response) => {
    if (request.body?.website) return response.status(401).json({ error: "invalid_credentials", message: "E-mail ou senha incorretos." });
    let email;
    try { email = normalizeEmail(request.body?.email); }
    catch { return response.status(401).json({ error: "invalid_credentials", message: "E-mail ou senha incorretos." }); }
    let admin = await store.getAdminByEmail(email, { includePassword: true });
    if (!admin && environment.galaticAdminEmail === email && environment.galaticAdminPassword) {
      admin = await store.createInitialAdmin({ name: "Administrador Galatic", email,
        passwordHash: await hashPassword(environment.galaticAdminPassword) });
      admin = await store.getAdminByEmail(email, { includePassword: true });
    }
    const validPassword = await verifyPassword(request.body?.password, admin?.password_hash ?? await dummyPasswordHash);
    if (!admin || admin.status !== "active" || !validPassword) {
      return response.status(401).json({ error: "invalid_credentials", message: "E-mail ou senha incorretos." });
    }
    const accessToken = opaqueToken();
    await store.createAdminSession({ adminId: admin.id, tokenHash: tokenHash(accessToken), expiresAt: expiresAt(12 * 3600000) });
    setSessionCookie(response, ADMIN_SESSION_COOKIE, accessToken, 12 * 3600);
    return response.json({ admin: adminView(admin), expires_in: 43_200 });
  });
  router.get("/me", authenticate, (request, response) => response.json({ admin: adminView(request.galaticAdmin) }));
  router.post("/logout", authenticate, allowBodyFields([]), async (request, response) => {
    await store.revokeAdminSession(request.galaticAdminTokenHash);
    clearSessionCookie(response, ADMIN_SESSION_COOKIE);
    return response.json({ logged_out: true });
  });

  router.use(authenticate);
  router.get("/dashboard", async (_request, response) => response.json({ metrics: await store.adminDashboard() }));
  router.get("/products", async (_request, response) => response.json({ products: await store.adminListProducts() }));
  router.post("/products", requireOwner, allowBodyFields(PRODUCT_FIELDS), async (request, response) => {
    try { const product = productInput(request.body); await store.adminUpsertProduct(product, { create: true }); return response.status(201).json({ product }); }
    catch (error) { return response.status(error?.code === "invalid_product" ? 400 : 409).json({ error: error?.code ?? "product_conflict", message: error.message }); }
  });
  router.patch("/products/:sku", requireOwner, allowBodyFields(PRODUCT_FIELDS), async (request, response) => {
    try {
      const current = (await store.adminListProducts()).find((item) => item.sku === clean(request.params.sku, 80).toUpperCase());
      if (!current) return response.status(404).json({ error: "product_not_found" });
      const merged = { ...current, ...request.body, slug: request.body?.slug ?? current.slug,
        name: request.body?.name ?? current.name, unit_amount: request.body?.unit_amount ?? current.unit_amount,
        cost_amount: request.body?.cost_amount !== undefined ? request.body.cost_amount : current.cost_amount,
        image_url: request.body?.image_url !== undefined ? request.body.image_url : current.image_url,
        source_url: request.body?.source_url !== undefined ? request.body.source_url : current.source_url,
        category: request.body?.category !== undefined ? request.body.category : current.category,
        brand: request.body?.brand !== undefined ? request.body.brand : current.brand,
        active: request.body?.active !== undefined ? request.body.active : current.active,
        manage_stock: request.body?.manage_stock !== undefined ? request.body.manage_stock : current.manage_stock,
        stock_quantity: request.body?.stock_quantity !== undefined ? request.body.stock_quantity : current.stock_quantity };
      const product = productInput(merged, request.params.sku); const updated = await store.adminUpsertProduct(product);
      return updated ? response.json({ product }) : response.status(404).json({ error: "product_not_found" });
    }
    catch (error) { return response.status(400).json({ error: error?.code ?? "invalid_product", message: error.message }); }
  });
  router.post("/products/bulk-logistics", requireOwner, allowBodyFields(["products"]), async (request, response) => {
    const rows = Array.isArray(request.body?.products) ? request.body.products : Array.isArray(request.body) ? request.body : [];
    const products = rows.map((row) => ({ sku: clean(row.sku, 80).toUpperCase(), weight_grams: decimal(row.weight_grams, 1),
      length_cm: decimal(row.length_cm, 0.1), width_cm: decimal(row.width_cm, 0.1), height_cm: decimal(row.height_cm, 0.1), stock_quantity: integer(row.stock_quantity) }));
    if (!products.length || products.length > 600 || products.some((row) => !/^[A-Z0-9_-]{2,80}$/.test(row.sku) || Object.values(row).some((value) => value === null))) {
      return response.status(400).json({ error: "invalid_logistics", message: "Revise o arquivo de logística." });
    }
    try { return response.json({ updated: await store.adminBulkLogistics(products) }); }
    catch { return response.status(409).json({ error: "unknown_product", message: "O arquivo contém um SKU inexistente." }); }
  });
  router.post("/products/bulk-import", requireOwner, allowBodyFields(["products"]), async (request, response) => {
    const rows = Array.isArray(request.body?.products) ? request.body.products : [];
    if (!rows.length || rows.length > 600) return response.status(400).json({ error: "invalid_import" });
    let imported = 0;
    try { for (const row of rows) { await store.adminUpsertProduct(productInput(row), { create: true }); imported += 1; } }
    catch (error) { return response.status(409).json({ error: error?.code ?? "import_failed", message: error.message }); }
    return response.json({ imported });
  });

  router.get("/orders", async (_request, response) => response.json({ orders: await store.adminListOrders() }));
  router.get("/alerts", async (_request, response) => response.json({ alerts: await store.adminListOperationalAlerts() }));
  router.get("/orders/:id", async (request, response) => {
    const result = await store.adminOrder(request.params.id); return result ? response.json(result) : response.status(404).json({ error: "order_not_found" });
  });
  router.post("/orders/:id/payment/cancel", requireOwner, allowBodyFields([]), async (request, response) => {
    if (!asaasClient) return response.status(503).json({ error: "payment_unavailable" });
    const order = await store.adminPaymentContext(request.params.id);
    if (!order) return response.status(404).json({ error: "order_not_found" });
    if (["paid", "refunded", "chargeback"].includes(order.status)) {
      return response.status(409).json({ error: "paid_order_cannot_be_canceled", message: "Use o fluxo de estorno para um pedido pago." });
    }
    try {
      if (!order.providerOrderId) {
        const canceled = await store.adminCancelUnpaidOrder(order.id);
        if (canceled) await notifyOnce(order.id, "payment-canceled", "sendPaymentCanceled");
        return response.json({ canceled: Boolean(canceled), order_id: order.id });
      }
      const provider = await asaasClient.getPayment(order.providerOrderId);
      if (normalizeAsaasPaymentStatus(provider?.status) === "paid") {
        await store.updateOrderFromWebhook({ provider: "asaas", providerOrderId: order.providerOrderId, status: "paid" });
        return response.status(409).json({ error: "payment_already_received", message: "O pagamento já foi recebido e não pode ser cancelado." });
      }
      if (order.providerGroupId) await asaasClient.deleteInstallment(order.providerGroupId);
      else await asaasClient.deletePayment(order.providerOrderId);
      const canceled = await store.adminCancelUnpaidOrder(order.id);
      if (canceled) await notifyOnce(order.id, "payment-canceled", "sendPaymentCanceled");
      return response.json({ canceled: Boolean(canceled), order_id: order.id });
    } catch (error) {
      return response.status(error?.status === 404 && order.status === "canceled" ? 200 : 502).json({
        error: error?.code ?? "payment_cancellation_failed", message: "Não foi possível cancelar a cobrança no Asaas.",
      });
    }
  });
  router.post("/orders/:id/payment/refund", requireOwner, allowBodyFields(["confirmation"]), async (request, response) => {
    if (!asaasClient) return response.status(503).json({ error: "payment_unavailable" });
    const order = await store.adminPaymentContext(request.params.id);
    if (!order) return response.status(404).json({ error: "order_not_found" });
    if (clean(request.body?.confirmation, 80) !== order.id) {
      return response.status(400).json({ error: "refund_confirmation_required", message: "Confirme com o número completo do pedido." });
    }
    if (order.status !== "paid") return response.status(409).json({ error: "order_not_paid" });
    try {
      await asaasClient.refundPayment(order.providerOrderId);
      await store.recordOperationalAlert?.({ type: "refund_requested", severity: "info", source: "galatic-admin",
        summary: "Estorno integral solicitado ao Asaas.", context: { orderId: order.id, adminId: request.galaticAdmin.id } });
      await notifyOnce(order.id, "refund-requested", "sendRefundRequested");
      return response.status(202).json({ requested: true, order_id: order.id, message: "Estorno solicitado. A confirmação será conciliada pelo webhook do Asaas." });
    } catch (error) {
      return response.status(502).json({ error: error?.code ?? "refund_failed", message: "O Asaas não aceitou a solicitação de estorno." });
    }
  });
  router.post("/orders/:id/shipping/manual-dispatch", allowBodyFields(["tracking_code"]), async (request, response) => {
    const tracking = clean(request.body?.tracking_code, 100);
    if (!/^[A-Za-z0-9._\-/]{5,100}$/.test(tracking)) return response.status(400).json({ error: "invalid_tracking" });
    const updated = await store.adminUpdateShipping(request.params.id, { status: "posted", trackingCode: tracking, description: "Pedido postado." });
    if (updated) await notifyOnce(request.params.id, `shipping-posted:${tracking}`, "sendShippingUpdate",
      { status: "posted", trackingCode: tracking, description: "Pedido postado." });
    return updated ? response.json({ updated: true, tracking_code: tracking }) : response.status(409).json({ error: "order_not_paid" });
  });
  router.post("/orders/:id/shipping/manual-status", allowBodyFields(["shipping_status", "description"]), async (request, response) => {
    const status = clean(request.body?.shipping_status, 32);
    if (!["in_transit", "out_for_delivery", "delivered", "delivery_exception", "returned"].includes(status)) return response.status(400).json({ error: "invalid_shipping_status" });
    const description = clean(request.body?.description, 500);
    const updated = await store.adminUpdateShipping(request.params.id, { status, description });
    if (updated) await notifyOnce(request.params.id, `shipping-${status}`, "sendShippingUpdate",
      { status, description });
    return updated ? response.json({ updated: true, status }) : response.status(409).json({ error: "order_not_paid" });
  });
  router.post("/orders/:id/shipping/label", allowBodyFields([]), async (request, response) => {
    if (!fulfillment) return response.status(503).json({ error: "shipping_unavailable" });
    try { const result = await fulfillment.createLabel(request.params.id); return response.status(result.created ? 201 : 200).json(result); }
    catch (error) {
      const status = error?.code === "order_not_found" ? 404 : ["order_not_paid", "shipping_service_missing"].includes(error?.code) ? 409
        : error?.code === "shipping_unavailable" ? 503 : 502;
      return response.status(status).json({ error: error?.code ?? "label_generation_failed", message: "Não foi possível gerar a etiqueta de envio." });
    }
  });
  router.post("/orders/:id/shipping/refresh", allowBodyFields([]), async (request, response) => {
    if (!fulfillment) return response.status(503).json({ error: "shipping_unavailable" });
    try { return response.json({ shipment: await fulfillment.refresh(request.params.id) }); }
    catch (error) { return response.status(error?.code === "shipment_not_found" ? 404 : 502).json({ error: error?.code ?? "tracking_failed" }); }
  });
  router.post("/orders/:id/shipping/cancel", allowBodyFields([]), async (request, response) => {
    if (!fulfillment) return response.status(503).json({ error: "shipping_unavailable" });
    try { return response.json(await fulfillment.cancel(request.params.id)); }
    catch (error) { return response.status(error?.code === "shipment_not_found" ? 404 : 502).json({ error: error?.code ?? "shipment_cancel_failed" }); }
  });

  router.get("/customers", async (_request, response) => response.json({ customers: await store.adminListCustomers() }));
  router.get("/customers/:id", async (request, response) => { const result = await store.adminCustomer(request.params.id); return result ? response.json(result) : response.status(404).json({ error: "customer_not_found" }); });
  router.patch("/customers/:id", requireOwner, allowBodyFields(["status"]), async (request, response) => {
    const status = clean(request.body?.status, 24); if (!["active", "blocked", "deleted"].includes(status)) return response.status(400).json({ error: "invalid_status" });
    return (await store.adminUpdateCustomerStatus(request.params.id, status)) ? response.json({ updated: true }) : response.status(404).json({ error: "customer_not_found" });
  });
  router.get("/contacts", async (_request, response) => response.json({ contacts: await store.adminListContacts() }));
  router.get("/contacts/:id", async (request, response) => { const contact = await store.adminContact(request.params.id); return contact ? response.json({ contact }) : response.status(404).json({ error: "contact_not_found" }); });
  router.patch("/contacts/:id", allowBodyFields(["status", "admin_notes"]), async (request, response) => {
    const status = clean(request.body?.status, 24); if (!["new", "open", "in_progress", "resolved", "spam"].includes(status)) return response.status(400).json({ error: "invalid_status" });
    return (await store.adminUpdateContact(request.params.id, status, clean(request.body?.admin_notes, 5000))) ? response.json({ updated: true }) : response.status(404).json({ error: "contact_not_found" });
  });
  router.get("/coupons", async (_request, response) => response.json({ coupons: await store.adminListCoupons() }));
  router.post("/coupons", requireOwner, allowBodyFields(COUPON_FIELDS), async (request, response) => {
    const code = clean(request.body?.code, 40).toUpperCase(); if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return response.status(400).json({ error: "invalid_coupon" });
    try { await store.adminCreateCoupon({ code, ...couponInput(request.body) }); return response.status(201).json({ code }); }
    catch (error) { return response.status(error?.code === "invalid_coupon" ? 400 : 409).json({ error: error?.code ?? "coupon_conflict", message: error.message }); }
  });
  router.patch("/coupons/:code", requireOwner, allowBodyFields(COUPON_FIELDS.filter((field) => field !== "code")), async (request, response) => {
    try { return (await store.adminUpdateCoupon(clean(request.params.code, 40).toUpperCase(), couponInput(request.body))) ? response.json({ updated: true }) : response.status(404).json({ error: "coupon_not_found" }); }
    catch (error) { return response.status(400).json({ error: error?.code ?? "invalid_coupon", message: error.message }); }
  });
  router.delete("/coupons/:code", requireOwner, allowBodyFields([]), async (request, response) => {
    const current = (await store.adminListCoupons()).find((coupon) => coupon.code === clean(request.params.code, 40).toUpperCase());
    if (!current) return response.status(404).json({ error: "coupon_not_found" });
    await store.adminUpdateCoupon(current.code, { description: current.description, type: current.discount_type,
      value: Number(current.discount_value), minimum: Number(current.minimum_subtotal), limit: current.usage_limit,
      perCustomer: Number(current.per_customer_limit), active: false });
    return response.json({ updated: true });
  });
  router.get("/content-fiscal", async (_request, response) => response.json(await store.adminContentFiscal()));
  router.patch("/content-fiscal/:sku", requireOwner, allowBodyFields(["content_status", "fiscal_status", "merchant_identifier_status",
    "fiscal_ncm", "gtin", "seo_title", "seo_description", "fiscal_reference_url", "cest", "origin", "commercial_unit", "notes"]), async (request, response) => {
    const contentStatus = clean(request.body?.content_status, 24); const fiscalStatus = clean(request.body?.fiscal_status, 24);
    const identifierStatus = clean(request.body?.merchant_identifier_status, 24);
    const ncm = clean(request.body?.fiscal_ncm, 8).replace(/\D/g, ""); const gtin = clean(request.body?.gtin, 14).replace(/\D/g, "");
    if (!["draft","review","approved"].includes(contentStatus) || !["pending","review","verified"].includes(fiscalStatus)
      || !["unknown","gtin","none"].includes(identifierStatus) || (ncm && ncm.length !== 8) || (identifierStatus === "gtin" && ![8,12,13,14].includes(gtin.length))) {
      return response.status(400).json({ error: "invalid_content_fiscal", message: "Revise os dados editoriais e fiscais." });
    }
    const updated = await store.adminUpdateContentFiscal(clean(request.params.sku, 80).toUpperCase(), {
      seoTitle: clean(request.body?.seo_title, 70), seoDescription: clean(request.body?.seo_description, 170),
      contentStatus, fiscalStatus, ncm, referenceUrl: clean(request.body?.fiscal_reference_url, 1000), identifierStatus,
      fiscal: { cest: clean(request.body?.cest, 7).replace(/\D/g, ""), origin: clean(request.body?.origin, 1),
        commercial_unit: clean(request.body?.commercial_unit, 6).toUpperCase(), gtin, notes: clean(request.body?.notes, 1000) },
    });
    return updated ? response.json({ updated: true }) : response.status(404).json({ error: "product_not_found" });
  });
  router.get("/integrations", (_request, response) => response.json({ integrations: {
    database: { configured: true, service: "MySQL Galatic isolado" },
    asaas: { configured: Boolean(environment.checkoutEnabled), mode: environment.asaasEnvironment, service: "Pix e cartão" },
    payment_maintenance: { configured: Boolean(environment.galaticPaymentMaintenanceEnabled),
      service: `Expiração Pix ${environment.galaticPixReservationMinutes} min · cartão ${environment.galaticCardReservationMinutes} min` },
    envia: { configured: Boolean(environment.galaticEnviaApiKey && environment.galaticShippingOrigin), mode: environment.galaticEnviaEnvironment,
      webhook: Boolean(environment.galaticEnviaWebhookSecret || environment.galaticEnviaWebhookToken), service: "Envia" },
    mail: { configured: Boolean(notifications?.ready), service: notifications?.provider === "hostinger-mail-api" ? "Hostinger Mail API" : "SMTP Galatic" },
  } }));
  router.get("/readiness", async (_request, response) => {
    const products = await store.adminListProducts();
    const catalog = { active_products: products.filter((item) => item.active === 1).length,
      missing_weight: products.filter((item) => item.active === 1 && !(Number(item.weight_grams) > 0)).length,
      missing_dimensions: products.filter((item) => item.active === 1 && ![item.length_cm,item.width_cm,item.height_cm].every((value) => Number(value) > 0)).length,
      stock_not_managed: products.filter((item) => item.active === 1 && item.manage_stock !== 1).length };
    const checks = [
      { key: "database", label: "Banco Galatic isolado", required: true, passed: true },
      { key: "checkout", label: "Asaas configurado", required: true, passed: Boolean(environment.checkoutEnabled) },
      { key: "payment_environment", label: "Asaas em ambiente de produção", required: true,
        passed: environment.asaasEnvironment === "production" },
      { key: "payment_maintenance", label: "Expiração segura de reservas abandonadas", required: true,
        passed: Boolean(environment.galaticPaymentMaintenanceEnabled) },
      { key: "shipping", label: "Envia e origem de postagem", required: true, passed: Boolean(environment.galaticEnviaApiKey && environment.galaticShippingOrigin) },
      { key: "shipping_webhook", label: "Webhook autenticado de rastreio Envia", required: true,
        passed: Boolean(environment.galaticEnviaWebhookSecret || environment.galaticEnviaWebhookToken) },
      { key: "catalog", label: "Catálogo com logística completa", required: true, passed: catalog.active_products > 0 && catalog.missing_weight === 0 && catalog.missing_dimensions === 0 },
      { key: "email", label: "E-mail transacional", required: true, passed: Boolean(notifications?.ready) },
      { key: "pii_encryption", label: "Criptografia de dados pessoais", required: true,
        passed: Boolean(environment.galaticDataEncryptionKey) },
    ];
    const sandboxReady = checks
      .filter((item) => item.key !== "payment_environment")
      .every((item) => item.passed);
    return response.json({
      production_ready: checks.every((item) => item.passed),
      sandbox_ready: sandboxReady,
      payment_environment: environment.asaasEnvironment,
      checkout_enabled: Boolean(environment.checkoutEnabled),
      checks,
      catalog,
    });
  });
  const emailTemplates = [
    { key: "customer_service", label: "Atendimento ao cliente", subject: "Atendimento Galatic", message: "Olá!\n\nEstamos entrando em contato sobre sua solicitação.\n\nEquipe Galatic" },
    { key: "order_update", label: "Atualização de pedido", subject: "Novidades sobre seu pedido Galatic", message: "Olá!\n\nTemos uma atualização sobre seu pedido.\n\nEquipe Galatic" },
    { key: "general", label: "Mensagem geral", subject: "Uma mensagem da Galatic", message: "Olá!\n\n\n\nEquipe Galatic" },
  ];
  router.get("/emails/templates", (_request, response) => response.json({ templates: emailTemplates }));
  router.get("/emails/history", async (request, response) => {
    const status = clean(request.query?.status, 24); const rows = await store.adminListEmails(status);
    return response.json({ messages: rows.map((row) => ({ ...row, source: "manual", template_label: emailTemplates.find((item) => item.key === row.template)?.label ?? row.template,
      error: row.error_message, resendable: false })) });
  });
  router.post("/emails/preview", allowBodyFields(["subject", "message"]), (request, response) => {
    if (!notifications?.ready) return response.status(503).json({ error: "email_unavailable", message: "Configure o e-mail transacional da Galatic para visualizar e enviar mensagens." });
    const subject = clean(request.body?.subject, 160); const message = clean(request.body?.message, 5000);
    if (!subject || !message) return response.status(400).json({ error: "invalid_email_message" });
    return response.json({ preview: { html: notifications.previewCustom({ subject, message }) } });
  });
  router.post("/emails/send", allowBodyFields(["recipient", "subject", "message", "template"]), async (request, response) => {
    if (!notifications?.ready) return response.status(503).json({ error: "email_unavailable", message: "Configure o e-mail transacional da Galatic antes de enviar." });
    let recipient; try { recipient = normalizeEmail(request.body?.recipient); } catch { return response.status(400).json({ error: "invalid_recipient" }); }
    const subject = clean(request.body?.subject, 160); const message = clean(request.body?.message, 5000); const template = clean(request.body?.template, 48) || "general";
    if (!subject || !message) return response.status(400).json({ error: "invalid_email_message" });
    const id = await store.adminCreateEmail({ recipient, subject, template, message });
    try { await notifications.sendCustom({ recipient, subject, message }); await store.adminFinishEmail(id, "sent"); return response.status(201).json({ id, status: "sent" }); }
    catch (error) { await store.adminFinishEmail(id, "failed", clean(error?.message, 500)); return response.status(502).json({ error: "email_send_failed", message: "O provedor de e-mail não conseguiu enviar a mensagem." }); }
  });
  router.get("/integrations/mail/templates/audit", (_request, response) => response.json({ ready: Boolean(notifications?.ready), templates: emailTemplates.map((item) => item.key) }));
  router.post("/integrations/mail/test", requireOwner, allowBodyFields([]), async (request, response) => {
    if (!notifications?.ready) return response.status(503).json({ error: "email_unavailable" });
    await notifications.sendCustom({ recipient: request.galaticAdmin.email, subject: "Teste operacional Galatic", message: "O e-mail transacional da Galatic está funcionando." });
    return response.json({ sent: true });
  });
  return router;
}
