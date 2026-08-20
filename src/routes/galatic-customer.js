import { hashPassword, normalizeEmail, opaqueToken, tokenHash, validatePassword, verifyPassword } from "../domain/password.js";
import { normalizeBrazilianTaxId } from "../domain/brazilian-tax-id.js";
import { createFixedWindowLimiter } from "../http/fixed-window-limiter.js";
import { allowBodyFields } from "../http/request-security.js";
import { CUSTOMER_SESSION_COOKIE, clearSessionCookie, sessionCredential, setSessionCookie } from "../http/session-cookie.js";

const text = (value, maximum = 180) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maximum);
const digits = (value) => String(value ?? "").replace(/\D/g, "");

function expiresIn(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString().slice(0, 23).replace("T", " ");
}

function parseName(body) {
  let firstName = text(body?.first_name, 90);
  let lastName = text(body?.last_name, 90);
  if (!firstName || !lastName) {
    const parts = text(body?.name).split(" ").filter(Boolean);
    firstName ||= parts.shift() ?? "";
    lastName ||= parts.join(" ");
  }
  if (firstName.length < 2 || lastName.length < 2) throw Object.assign(new Error("Informe nome e sobrenome."), { code: "invalid_name" });
  return { firstName, lastName };
}

async function session(store, customerId) {
  const token = opaqueToken();
  await store.createCustomerSession({ customerId, tokenHash: tokenHash(token), expiresAt: expiresIn(30 * 86400000) });
  return token;
}

export function createGalaticCustomerRouter(express, { store, notifications = null, botChallenge = { verify: (_request, _response, next) => next() } }) {
  const router = express.Router();
  const authLimiter = createFixedWindowLimiter({ limit: 20, windowMs: 60_000, prefix: "galatic-auth-ip" });
  const credentialLimiter = createFixedWindowLimiter({
    limit: 6,
    windowMs: 15 * 60_000,
    prefix: "galatic-auth-identity",
    keyGenerator: (request) => `${request.ip}:${tokenHash(String(request.body?.email ?? "").trim().toLowerCase())}`,
  });
  const dummyPasswordHash = hashPassword("GalaticDummyPassword2026");

  async function authenticate(request, response, next) {
    const credential = sessionCredential(request, CUSTOMER_SESSION_COOKIE);
    const authenticated = credential ? await store.customerForSession(tokenHash(credential.token)) : null;
    if (!authenticated) return response.status(401).json({ error: "unauthorized", message: "Entre na sua conta para continuar." });
    request.galaticCustomer = authenticated.customer;
    request.galaticSessionId = authenticated.sessionId;
    request.galaticSessionTokenHash = tokenHash(credential.token);
    request.galaticSessionTransport = credential.transport;
    return next();
  }

  router.post("/auth/register", authLimiter, credentialLimiter, botChallenge.verify,
    allowBodyFields(["name", "first_name", "last_name", "email", "phone", "password", "marketing_consent", "website"]),
    async (request, response) => {
    try {
      const { firstName, lastName } = parseName(request.body);
      const email = normalizeEmail(request.body?.email);
      const phone = digits(request.body?.phone).slice(0, 13);
      if (phone && phone.length < 10) throw Object.assign(new Error("Informe um celular válido."), { code: "invalid_phone" });
      const passwordHash = await hashPassword(request.body?.password);
      const customer = await store.createCustomer({ firstName, lastName, email, phone, passwordHash, marketingConsent: request.body?.marketing_consent === true });
      const verification = opaqueToken();
      await store.createCustomerToken({ customerId: customer.id, purpose: "verify_email", tokenHash: tokenHash(verification), expiresAt: expiresIn(24 * 3600000) });
      notifications?.sendEmailVerification?.({ customer, token: verification }).catch((error) => {
        console.error("Could not send Galatic verification email", { type: error?.name, code: error?.code });
      });
      const accessToken = await session(store, customer.id);
      setSessionCookie(response, CUSTOMER_SESSION_COOKIE, accessToken, 30 * 86400);
      return response.status(201).json({ customer, access_token: accessToken, token_type: "Bearer", expires_in: 30 * 86400,
        message: "Conta criada. Confira seu e-mail para confirmar o cadastro." });
    } catch (error) {
      if (["email_exists", "invalid_email", "invalid_password", "invalid_name", "invalid_phone"].includes(error?.code)) {
        return response.status(error.code === "email_exists" ? 409 : 400).json({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  router.post("/auth/login", authLimiter, credentialLimiter, botChallenge.verify, allowBodyFields(["email", "password", "website"]), async (request, response) => {
    if (request.body?.website) return response.status(401).json({ error: "invalid_credentials", message: "E-mail ou senha incorretos." });
    let email;
    try { email = normalizeEmail(request.body?.email); }
    catch { return response.status(401).json({ error: "invalid_credentials", message: "E-mail ou senha incorretos." }); }
    const customer = await store.getCustomerByEmail(email, { includePassword: true });
    const validPassword = await verifyPassword(request.body?.password, customer?.password_hash ?? await dummyPasswordHash);
    if (!customer || !validPassword || customer.status === "blocked" || customer.status === "deleted") {
      return response.status(401).json({ error: "invalid_credentials", message: "E-mail ou senha incorretos." });
    }
    delete customer.password_hash;
    const accessToken = await session(store, customer.id);
    setSessionCookie(response, CUSTOMER_SESSION_COOKIE, accessToken, 30 * 86400);
    return response.json({ customer, access_token: accessToken, token_type: "Bearer", expires_in: 30 * 86400 });
  });

  router.get("/auth/me", authenticate, (request, response) => response.json({ customer: request.galaticCustomer }));
  router.post("/auth/logout", authenticate, async (request, response) => {
    await store.revokeCustomerSession(request.galaticSessionTokenHash);
    clearSessionCookie(response, CUSTOMER_SESSION_COOKIE);
    return response.json({ logged_out: true });
  });
  router.post("/auth/verify-email", authLimiter, allowBodyFields(["token"]), async (request, response) => {
    const customerId = await store.consumeCustomerToken(tokenHash(request.body?.token), "verify_email");
    if (!customerId) return response.status(400).json({ error: "invalid_token", message: "O link expirou ou já foi utilizado." });
    const customer = await store.getCustomerById(customerId);
    notifications?.sendWelcome?.({ customer }).catch((error) => {
      console.error("Could not send Galatic welcome email", { type: error?.name, code: error?.code });
    });
    return response.json({ message: "E-mail confirmado com sucesso." });
  });
  router.post("/auth/forgot-password", authLimiter, credentialLimiter, botChallenge.verify, allowBodyFields(["email", "website"]), async (request, response) => {
    if (request.body?.website) return response.json({ message: "Se a conta existir, enviaremos as instruções para redefinir a senha." });
    try {
      const email = normalizeEmail(request.body?.email);
      const customer = await store.getCustomerByEmail(email);
      if (customer) {
        const reset = opaqueToken();
        await store.createCustomerToken({ customerId: customer.id, purpose: "reset_password", tokenHash: tokenHash(reset), expiresAt: expiresIn(3600000) });
        await notifications?.sendPasswordReset?.({ customer, token: reset });
      }
    } catch {}
    return response.json({ message: "Se a conta existir, enviaremos as instruções para redefinir a senha." });
  });
  router.post("/auth/reset-password", authLimiter, allowBodyFields(["token", "password"]), async (request, response) => {
    try { validatePassword(request.body?.password); }
    catch (error) { return response.status(400).json({ error: error.code, message: error.message }); }
    const customerId = await store.consumeCustomerToken(tokenHash(request.body?.token), "reset_password");
    if (!customerId) return response.status(400).json({ error: "invalid_token", message: "O link expirou ou já foi utilizado." });
    await store.updateCustomerPassword(customerId, await hashPassword(request.body.password));
    await store.revokeOtherCustomerSessions(customerId);
    const customer = await store.getCustomerById(customerId);
    notifications?.sendPasswordChanged?.({ customer }).catch((error) => {
      console.error("Could not send Galatic password confirmation", { type: error?.name, code: error?.code });
    });
    return response.json({ message: "Senha atualizada. Entre novamente com sua nova senha." });
  });

  router.patch("/account/profile", authenticate, allowBodyFields(["name", "first_name", "last_name", "phone"]), async (request, response) => {
    try {
      const { firstName, lastName } = parseName(request.body);
      const phone = digits(request.body?.phone).slice(0, 13);
      if (phone && phone.length < 10) throw Object.assign(new Error("Informe um celular válido."), { code: "invalid_phone" });
      const customer = await store.updateCustomerProfile(request.galaticCustomer.id, { firstName, lastName, phone });
      return response.json({ customer });
    } catch (error) { return response.status(400).json({ error: error.code ?? "invalid_profile", message: error.message }); }
  });
  router.post("/account/change-password", authLimiter, authenticate, allowBodyFields(["current_password", "new_password"]), async (request, response) => {
    const customer = await store.getCustomerById(request.galaticCustomer.id, { includePassword: true });
    if (!(await verifyPassword(request.body?.current_password, customer?.password_hash))) {
      return response.status(400).json({ error: "invalid_current_password", message: "A senha atual está incorreta." });
    }
    try { validatePassword(request.body?.new_password); }
    catch (error) { return response.status(400).json({ error: error.code, message: error.message }); }
    await store.updateCustomerPassword(customer.id, await hashPassword(request.body.new_password));
    await store.revokeOtherCustomerSessions(customer.id, request.galaticSessionId);
    notifications?.sendPasswordChanged?.({ customer }).catch((error) => {
      console.error("Could not send Galatic password confirmation", { type: error?.name, code: error?.code });
    });
    return response.json({ updated: true });
  });
  router.get("/account/orders", authenticate, async (request, response) => response.json({ orders: await store.listCustomerOrders(request.galaticCustomer) }));
  router.get("/account/orders/:orderId", authenticate, async (request, response) => {
    const order = await store.getCustomerOrder(request.galaticCustomer, request.params.orderId);
    return order ? response.json(order) : response.status(404).json({ error: "order_not_found", message: "Pedido não encontrado." });
  });
  router.get("/account/addresses", authenticate, async (request, response) => response.json({ addresses: await store.listCustomerAddresses(request.galaticCustomer.id) }));
  router.post("/account/addresses", authenticate, async (request, response) => {
    try {
      const address = {
        label: text(request.body?.label, 80), recipientName: text(request.body?.recipient_name),
        federalTaxId: request.body?.federal_tax_id ? normalizeBrazilianTaxId(request.body.federal_tax_id) : "",
        postalCode: digits(request.body?.postal_code), street: text(request.body?.street), number: text(request.body?.number, 30),
        complement: text(request.body?.complement, 120), district: text(request.body?.district, 120),
        city: text(request.body?.city, 120), state: text(request.body?.state, 2).toUpperCase(), isDefault: request.body?.is_default === true,
      };
      if (!address.label || !address.recipientName || address.postalCode.length !== 8 || !address.street || !address.number || !address.district || !address.city || !/^[A-Z]{2}$/.test(address.state)) throw new Error("Complete o endereço de entrega.");
      const id = await store.createCustomerAddress(request.galaticCustomer.id, address);
      return response.status(201).json({ id });
    } catch (error) { return response.status(400).json({ error: "invalid_address", message: error.message }); }
  });
  router.delete("/account/addresses/:addressId", authenticate, async (request, response) => {
    const deleted = await store.deleteCustomerAddress(request.galaticCustomer.id, request.params.addressId);
    return deleted ? response.json({ deleted: true }) : response.status(404).json({ error: "address_not_found", message: "Endereço não encontrado." });
  });
  router.get("/account/preferences", authenticate, async (request, response) => response.json({ preferences: await store.getCustomerPreferences(request.galaticCustomer.id) }));
  router.patch("/account/preferences", authenticate, async (request, response) => {
    const enabled = request.body?.newsletter_enabled === true;
    const preferences = await store.setCustomerPreferences(request.galaticCustomer.id, enabled);
    await store.upsertNewsletter(request.galaticCustomer.email, enabled, request.galaticCustomer.id);
    return response.json({ preferences, message: enabled ? "Newsletter ativa." : "Newsletter desativada." });
  });

  return router;
}
