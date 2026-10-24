import cors from "cors";
import express from "express";
import helmet from "helmet";
import { applyAsaasRuntimeConfig, getEnvironment } from "./config/environment.js";
import { assertTenantIsolation, getTenantDefinitions } from "./config/tenants.js";
import { createCatalogSnapshot, getCheckoutProduct, replaceCatalogProducts } from "./domain/catalog.js";
import { requestContext } from "./http/request-context.js";
import { jsonErrorHandler } from "./http/error-handler.js";
import { createFixedWindowLimiter } from "./http/fixed-window-limiter.js";
import { enforceHttps, privateResponseHeaders, rejectUnsupportedBodies } from "./http/request-security.js";
import { createBotChallenge } from "./http/bot-challenge.js";
import { createAsaasClient } from "./integrations/asaas/client.js";
import { createArtClient } from "./integrations/art/client.js";
import { createGalaticNotifications } from "./integrations/email/galatic-notifications.js";
import { createEnviaClient } from "./integrations/envia/client.js";
import { createAsaasWebhookHandler } from "./routes/asaas-integration.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createHealthRouter } from "./routes/health.js";
import { createPublicCommerceRouter } from "./routes/public.js";
import { createGalaticCheckoutRouter } from "./routes/galatic-checkout.js";
import { createGalaticShippingRouter } from "./routes/galatic-shipping.js";
import { createGalaticCustomerRouter } from "./routes/galatic-customer.js";
import { createGalaticPublicRouter } from "./routes/galatic-public.js";
import { createGalaticAdminRouter } from "./routes/galatic-admin.js";
import { createEnviaWebhookHandler } from "./routes/envia-webhook.js";
import { createArtAdminRouter } from "./routes/art-admin.js";
import { createGalaticFulfillmentService } from "./services/galatic-fulfillment.js";
import { createInstallmentService } from "./services/installment-service.js";
import { createArtActivationService } from "./services/art-activation.js";
import { createArtRetryWorker } from "./services/art-retry-worker.js";
import { createInMemoryStore } from "./store/in-memory-store.js";
import { createGalaticMySqlStore } from "./store/galatic-mysql-store.js";
import { createMySqlStore } from "./store/mysql-store.js";

function createAccessCallbacks(tenant, store, notifications = null, artActivation = null) {
  // Lock em memória por pedido: dois gatilhos concorrentes (ex.: Asaas
  // reenviando PAYMENT_CONFIRMED + PAYMENT_RECEIVED) NÃO podem rodar a
  // ativação ART em paralelo — logins/checkouts dobrados na mesma conta
  // quebram a conta do aluno na plataforma.
  const accessGrantInFlight = new Set();
  return {
    async onAccessGranted(orderId) {
      if (tenant.id === "galatic") {
        if (store.enqueueNotification) return { granted: true, deliveries: 0 };
        if (!notifications) return { granted: true, deliveries: 0 };
        const order = typeof store.getOrderNotification === "function" ? await store.getOrderNotification(orderId) : null;
        const claimed = order && typeof store.claimNotification === "function"
          ? await store.claimNotification(`payment-confirmed:${orderId}`)
          : Boolean(order);
        if (claimed) notifications?.sendPaymentConfirmed?.(order).catch(async (error) => {
          await store.releaseNotification?.(`payment-confirmed:${orderId}`).catch(() => {});
          console.error("Could not send Galatic payment email", { type: error?.name, code: error?.code });
        });
        return { granted: true, deliveries: 0 };
      }
      // Matrícula principal no ART: tenta ativar cada curso do pedido na conta
      // ART do aluno. Itens sem mapping ou com falha caem no LMS abaixo.
      if (accessGrantInFlight.has(orderId)) {
        console.log("Access grant already in flight; skipping duplicate trigger.", { tenant: tenant.id, orderId });
        return { granted: false, deliveries: 0, artMode: "already_in_flight" };
      }
      accessGrantInFlight.add(orderId);
      let artMode = "art";
      let allArt = false;
      try {
        if (artActivation?.isEnabled?.()) {
          try {
            const outcome = await artActivation.activateOrder(orderId);
            artMode = outcome.mode;
            allArt = outcome.mode === "art";
            console.log("ART activation attempted.", {
              tenant: tenant.id,
              orderId,
              mode: outcome.mode,
              results: outcome.results?.map((result) => ({ itemId: result.itemId, courseId: result.courseId, mode: result.mode, reason: result.reason ?? null })),
            });
          } catch (error) {
            // A ativação ART nunca pode derrubar a entrega: em erro, segue LMS.
            artMode = "lms_fallback";
            allArt = false;
            console.error("ART activation orchestration failed; falling back to LMS.", {
              tenant: tenant.id,
              orderId,
              type: error?.name,
            });
          }
        } else {
          artMode = "lms_fallback";
          allArt = false;
        }
        // Quando TODOS os itens foram ativados na ART, a matrícula LMS não é
        // necessária (evita duplicação e o grantOrderAccess pularia tudo). Se
        // qualquer item caiu no LMS, roda o fluxo local normal.
        let result = { granted: false, deliveries: 0 };
        if (!allArt && typeof store.grantOrderAccess === "function") {
          result = await store.grantOrderAccess(orderId);
        }
        console.log("Payment confirmed; access reconciled.", {
          tenant: tenant.id,
          orderId,
          artMode,
          deliveries: result.deliveries,
        });
        return { ...result, artMode };
      } finally {
        accessGrantInFlight.delete(orderId);
      }
    },
    async onAccessRevoked(orderId, reason) {
      if (tenant.id === "galatic") {
        if (store.enqueueNotification) return { revoked: true };
        const order = notifications && typeof store.getOrderNotification === "function"
          ? await store.getOrderNotification(orderId) : null;
        const key = `payment-reversed:${reason}:${orderId}`;
        const claimed = order && typeof store.claimNotification === "function" ? await store.claimNotification(key) : Boolean(order);
        if (claimed) notifications?.sendPaymentReversed?.({ ...order, reason }).catch(async (error) => {
          await store.releaseNotification?.(key).catch(() => {});
          console.error("Could not send Galatic reversal email", { type: error?.name, code: error?.code });
        });
        return { revoked: true, deliveries: 0 };
      }
      if (typeof store.revokeOrderAccess !== "function") return { revoked: false, deliveries: 0 };
      const result = await store.revokeOrderAccess(orderId, reason);
      console.log("Payment reversed; LMS access reconciled.", {
        tenant: tenant.id,
        orderId,
        reason,
        deliveries: result.deliveries,
      });
      return result;
    },
  };
}

function tenantOrigin(tenant) {
  return function validateTenantOrigin(request, response, next) {
    const received = request.get("origin");
    if (!received || received === tenant.publicOrigin) return next();
    return response.status(403).json({
      error: "tenant_origin_mismatch",
      message: "A origem desta requisição não pertence à plataforma informada.",
    });
  };
}

function tenantReadiness(context) {
  return async function requireTenantReadiness(_request, response, next) {
    await context.waitForReady();
    if (context.readiness.status === "ready") return next();
    return response.status(503).json({
      error: "service_initializing",
      message: `O serviço de dados de ${context.tenant.id} ainda não está disponível.`,
    });
  };
}

export function createApp(overrides = {}, dependencies = {}) {
  const source = { ...process.env, ...overrides };
  const environment = getEnvironment(source);
  const tenants = assertTenantIsolation(getTenantDefinitions(source, environment));
  const asaasClient = dependencies.asaasClient ?? createAsaasClient(environment);
  const enviaClient = dependencies.enviaClient ?? createEnviaClient(environment);
  const galaticNotifications = dependencies.galaticNotifications ?? createGalaticNotifications(source);
  const botChallenge = dependencies.botChallenge ?? createBotChallenge({ enabled: environment.galaticBotProtectionEnabled });
  const contexts = new Map();

  for (const tenant of tenants) {
    const tenantEnvironment = {
      ...environment,
      tenantId: tenant.id,
      publicOrigin: tenant.publicOrigin,
      mysqlUrl: tenant.mysqlUrl,
      trustedCheckoutToken: tenant.trustedCheckoutToken,
      paymentReferencePrefix: tenant.referencePrefix,
      successOrigin: source[`${tenant.variablePrefix}_SUCCESS_ORIGIN`]?.trim() || tenant.publicOrigin,
      galaticEnviaApiKey: environment.galaticEnviaApiKey,
      galaticEnviaEnvironment: environment.galaticEnviaEnvironment,
      galaticEnviaApiOrigin: environment.galaticEnviaApiOrigin,
      galaticEnviaQueriesOrigin: environment.galaticEnviaQueriesOrigin,
      galaticEnviaWebhookSecret: environment.galaticEnviaWebhookSecret,
      galaticEnviaWebhookToken: environment.galaticEnviaWebhookToken,
      galaticShippingOrigin: environment.galaticShippingOrigin,
    };
    const injectedStore = dependencies.stores?.[tenant.id]
      ?? (tenant.isDefault ? dependencies.store : null);
    let store;
    try { store = injectedStore
      ?? (tenant.mysqlUrl
        ? (tenant.id === "galatic" ? createGalaticMySqlStore(tenant.mysqlUrl, {
          dataEncryptionKey: environment.galaticDataEncryptionKey,
          requireEncryption: environment.nodeEnvironment === "production",
        }) : createMySqlStore(tenant.mysqlUrl))
        : createInMemoryStore());
    } catch (error) {
      if (tenant.id !== "galatic") throw error;
      store = { ensureSchema: async () => { throw error; }, close: async () => {} };
    }
    const installmentService = dependencies.installmentServices?.[tenant.id]
      ?? (tenant.isDefault ? dependencies.installmentService : null)
      ?? createInstallmentService({ asaasClient, store });
    const readiness = { status: "connecting", error: null };
    let catalog = null;
    const productResolver = (slug) => catalog?.getCheckoutProduct(slug) ?? getCheckoutProduct(slug);
    const artClient = tenant.isDefault
      ? dependencies.artClient ?? createArtClient(tenantEnvironment)
      : null;
    const artActivation = artClient
      ? dependencies.artActivation ?? createArtActivationService({ environment: tenantEnvironment, store, artClient })
      : null;
    const artRetryWorker = artClient
      ? dependencies.artRetryWorker ?? createArtRetryWorker({ store, artClient, maxRetries: Number(tenantEnvironment.artRetryMaxTries) || 8 })
      : null;
    const callbacks = createAccessCallbacks(tenant, store, galaticNotifications, artActivation);
    const context = {
      tenant,
      environment: tenantEnvironment,
      store,
      installmentService,
      readiness,
      productResolver,
      ...(artActivation ? { artActivation } : {}),
      ...(artRetryWorker ? { artRetryWorker } : {}),
      ...callbacks,
    };
    context.dataReady = Promise.resolve()
      .then(() => {
        if (tenant.id === "galatic" && environment.nodeEnvironment === "production" && !environment.galaticDataEncryptionKey) {
          throw new Error("GALATIC_DATA_ENCRYPTION_KEY is required before Galatic can start in production.");
        }
        return store.ensureSchema();
      })
      .then(() => tenant.id === "galatic" ? [] : store.listCatalogProducts())
      .then((products) => {
        if (tenant.id !== "galatic" && !products.length && environment.nodeEnvironment === "production") {
          throw new Error(`O catálogo de ${tenant.id} está vazio.`);
        }
        if (products.length) {
          catalog = createCatalogSnapshot(products);
          if (tenant.isDefault) replaceCatalogProducts(products);
        }
        readiness.status = "database_ready";
        return store;
      })
      .catch((error) => {
        readiness.status = "error";
        readiness.error = error?.code || error?.name || "database_initialization_failed";
        throw error;
      });
    context.dataReady.catch(() => {});
    context.webhookHandler = createAsaasWebhookHandler({
      environment: tenantEnvironment,
      store,
      onAccessGranted: context.onAccessGranted,
      onAccessRevoked: context.onAccessRevoked,
      referencePrefix: tenant.referencePrefix,
    });
    contexts.set(tenant.id, context);
  }

  const defaultContext = contexts.get(tenants[0].id);
  const referenceContexts = new Map(
    [...contexts.values()].map((context) => [context.tenant.referencePrefix, context]),
  );
  const providerReady = Promise.resolve()
    .then(async () => {
      // A single-tenant deployment keeps compatibility with the existing LMS
      // runtime switch. In multi-tenant mode the provider environment is a
      // backend-wide setting and must come only from deployment secrets.
      if (contexts.size === 1 && typeof defaultContext.store.getPaymentRuntimeConfig === "function") {
        const runtime = await defaultContext.store.getPaymentRuntimeConfig();
        if (runtime?.environment) applyAsaasRuntimeConfig(environment, runtime);
        Object.assign(defaultContext.environment, environment, {
          tenantId: defaultContext.tenant.id,
          publicOrigin: defaultContext.tenant.publicOrigin,
          mysqlUrl: defaultContext.tenant.mysqlUrl,
          trustedCheckoutToken: defaultContext.tenant.trustedCheckoutToken,
          paymentReferencePrefix: defaultContext.tenant.referencePrefix,
        });
      }
      if (
        environment.nodeEnvironment === "production"
        && environment.checkoutEnabled
        && !environment.asaasWebhookToken
        && !environment.asaasWebhookTokenHash
      ) {
        throw new Error("An Asaas webhook credential is required when checkout is enabled in production.");
      }
      if (
        environment.nodeEnvironment === "production"
        && environment.checkoutEnabled
        && typeof asaasClient?.verifyCredentials === "function"
      ) {
        await asaasClient.verifyCredentials();
      }
    })

    .catch((error) => {
      // Provider credentials/environment are global; database readiness is not.
      for (const context of contexts.values()) {
        context.readiness.status = "error";
        context.readiness.error = error?.code || error?.name || "provider_initialization_failed";
      }
      throw error;
    });

  for (const context of contexts.values()) {
    context.ready = Promise.all([providerReady, context.dataReady]).then(() => {
      context.readiness.status = "ready";
      if (context === defaultContext && context.artRetryWorker && environment.artEnabled) {
        context.artRetryWorker.start(Number(environment.artRetryIntervalMs) || 5 * 60_000);
      }
      return context.store;
    }).catch((error) => {
      context.readiness.status = "error";
      context.readiness.error = error?.code || error?.name || "initialization_failed";
      throw error;
    });
    context.ready.catch(() => {});
  }
  const ready = Promise.allSettled([...contexts.values()].map((context) => context.ready)).then((results) => {
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return results.map((result) => result.value);
  });
  ready.catch(() => {});

  for (const context of contexts.values()) {
    context.waitForReady = () => {
      if (context.readiness.status === "ready" || context.readiness.status === "error") return Promise.resolve();
      return new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        const settle = () => {
          clearTimeout(timeout);
          resolve();
        };
        context.ready.then(settle, settle);
      });
    };
  }

  const app = express();
  const allowedOrigins = new Set(tenants.map((tenant) => tenant.publicOrigin));
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(enforceHttps(environment.nodeEnvironment));
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } },
    crossOriginResourcePolicy: false,
    referrerPolicy: { policy: "no-referrer" },
  }));
  app.use(privateResponseHeaders);
  app.use(requestContext);
  app.use(cors({
    origin(received, callback) {
      if (!received || allowedOrigins.has(received)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization", "Idempotency-Key", "X-Galatic-Bot-Proof", "asaas-access-token", "x-academy-trusted-token"],
    credentials: true,
    maxAge: 86_400,
  }));
  app.use(rejectUnsupportedBodies);
  app.use(express.json({ limit: "32kb", verify(request, _response, buffer) { request.rawBody = buffer.toString("utf8"); } }));

  app.get("/health", async (_request, response) => {
    await Promise.all([...contexts.values()].map((context) => context.waitForReady()));
    const available = [...contexts.values()].every((context) => context.readiness.status === "ready");
    response.status(available ? 200 : 503).json({
      status: available ? "ok" : "unavailable",
      service: contexts.size === 1 ? "academy-api" : "payments-api",
    });
  });

  for (const context of contexts.values()) {
    const middleware = [tenantOrigin(context.tenant), tenantReadiness(context)];
    if (context.tenant.id === "galatic") {
      const fulfillment = createGalaticFulfillmentService({ environment: context.environment, store: context.store,
        enviaClient, asaasClient, notifications: galaticNotifications });
      app.use("/v1/galatic/checkout", ...middleware, createGalaticCheckoutRouter(express, {
        environment: context.environment,
        asaasClient,
        store: context.store,
        notifications: galaticNotifications,
        botChallenge,
      }));
      app.use("/v1/galatic/admin", ...middleware, createGalaticAdminRouter(express, {
        environment: context.environment, store: context.store, notifications: galaticNotifications, fulfillment, asaasClient, botChallenge,
      }));
      const shippingRouter = createGalaticShippingRouter(express, {
        environment: context.environment,
        store: context.store,
        enviaClient,
        botChallenge,
      });
      app.use("/v1/galatic/quote", ...middleware, shippingRouter);
      app.use("/v1/galatic/shipping", ...middleware, shippingRouter);
      app.use("/v1/galatic", ...middleware, createGalaticCustomerRouter(express, {
        store: context.store,
        notifications: galaticNotifications,
        botChallenge,
      }));
      app.use("/v1/galatic", ...middleware, createGalaticPublicRouter(express, {
        store: context.store,
        notifications: galaticNotifications,
        botChallenge,
      }));
      app.use(`/health/${context.tenant.id}`, createHealthRouter(
        express,
        context.environment,
        context.readiness,
        context.waitForReady,
      ));
      continue;
    }
    const base = `/v1/platforms/${context.tenant.id}`;
    app.use(`${base}/checkout`, ...middleware, createCheckoutRouter(express, {
      environment: context.environment,
      asaasClient,
      installmentService: context.installmentService,
      store: context.store,
      productResolver: context.productResolver,
      onAccessGranted: context.onAccessGranted,
    }));
    app.use(`${base}/public`, ...middleware, createPublicCommerceRouter(express, {
      store: context.store,
      productResolver: context.productResolver,
    }));
    app.use(`${base}/art`, ...middleware, createArtAdminRouter(express, {
      environment: context.environment,
      store: context.store,
      artRetryWorker: context.artRetryWorker ?? null,
    }));
    app.use(`/health/${context.tenant.id}`, createHealthRouter(
      express,
      context.environment,
      context.readiness,
      context.waitForReady,
    ));
  }

  // Backwards compatibility for the existing Academy4u frontend.
  const defaultMiddleware = [tenantOrigin(defaultContext.tenant), tenantReadiness(defaultContext)];
  app.use("/v1/checkout", ...defaultMiddleware, createCheckoutRouter(express, {
    environment: defaultContext.environment,
    asaasClient,
    installmentService: defaultContext.installmentService,
    store: defaultContext.store,
    productResolver: defaultContext.productResolver,
    onAccessGranted: defaultContext.onAccessGranted,
  }));
  app.use("/v1/public", ...defaultMiddleware, createPublicCommerceRouter(express, {
    store: defaultContext.store,
    productResolver: defaultContext.productResolver,
  }));
  app.use("/v1/art", ...defaultMiddleware, createArtAdminRouter(express, {
    environment: defaultContext.environment,
    store: defaultContext.store,
    artRetryWorker: defaultContext.artRetryWorker ?? null,
  }));

  // O webhook é a única rota exposta à internet sem CORS/origem. Sem limite,
  // um flood de POSTs (mesmo autenticados) martelaria o banco na deduplicação.
  // Teto generoso por IP: a Asaas reenvia eventos, nunca em rajada contínua.
  const webhookLimiter = createFixedWindowLimiter({ limit: 240, windowMs: 60_000 });
  app.post("/v1/webhooks/asaas", webhookLimiter, (request, response) => {
    const externalReference = String(request.body?.payment?.externalReference ?? "").trim();
    const prefix = externalReference.split(":", 1)[0].toLowerCase();
    const context = referenceContexts.get(prefix);
    if (!context) return response.status(400).json({ error: "invalid_webhook" });
    return context.webhookHandler(request, response);
  });
  const galaticContext = contexts.get("galatic");
  if (galaticContext) app.post("/v1/webhooks/envia", webhookLimiter,
    createEnviaWebhookHandler({ environment: galaticContext.environment, store: galaticContext.store,
      notifications: galaticNotifications }));

  app.use((_request, response) => {
    response.status(404).json({
      error: "not_found",
      message: "Esta API é reservada aos serviços de pagamento configurados.",
    });
  });
  app.use(jsonErrorHandler);

  return {
    app,
    environment,
    asaasClient,
    galaticNotifications,
    contexts,
    tenants,
    store: defaultContext.store,
    stores: new Map([...contexts].map(([id, context]) => [id, context.store])),
    readiness: defaultContext.readiness,
    ready,
    waitForReady: defaultContext.waitForReady,
  };
}
