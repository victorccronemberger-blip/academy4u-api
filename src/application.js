import cors from "cors";
import express from "express";
import helmet from "helmet";
import { applyAsaasRuntimeConfig, getEnvironment } from "./config/environment.js";
import { assertTenantIsolation, getTenantDefinitions } from "./config/tenants.js";
import { createCatalogSnapshot, getCheckoutProduct, replaceCatalogProducts } from "./domain/catalog.js";
import { requestContext } from "./http/request-context.js";
import { jsonErrorHandler } from "./http/error-handler.js";
import { createAsaasClient } from "./integrations/asaas/client.js";
import { createAsaasWebhookHandler } from "./routes/asaas-integration.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createHealthRouter } from "./routes/health.js";
import { createPublicCommerceRouter } from "./routes/public.js";
import { createInstallmentService } from "./services/installment-service.js";
import { createInMemoryStore } from "./store/in-memory-store.js";
import { createMySqlStore } from "./store/mysql-store.js";

function createAccessCallbacks(tenant, store) {
  return {
    async onAccessGranted(orderId) {
      const result = typeof store.grantOrderAccess === "function"
        ? await store.grantOrderAccess(orderId)
        : { granted: true, deliveries: 0 };
      console.log("Payment confirmed; LMS access reconciled.", {
        tenant: tenant.id,
        orderId,
        deliveries: result.deliveries,
      });
      return result;
    },
    async onAccessRevoked(orderId, reason) {
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
  const contexts = new Map();

  for (const tenant of tenants) {
    const tenantEnvironment = {
      ...environment,
      tenantId: tenant.id,
      publicOrigin: tenant.publicOrigin,
      mysqlUrl: tenant.mysqlUrl,
      trustedCheckoutToken: tenant.trustedCheckoutToken,
      paymentReferencePrefix: tenant.referencePrefix,
    };
    const injectedStore = dependencies.stores?.[tenant.id]
      ?? (tenant.isDefault ? dependencies.store : null);
    const store = injectedStore
      ?? (tenant.mysqlUrl ? createMySqlStore(tenant.mysqlUrl) : createInMemoryStore());
    const installmentService = dependencies.installmentServices?.[tenant.id]
      ?? (tenant.isDefault ? dependencies.installmentService : null)
      ?? createInstallmentService({ asaasClient, store });
    const readiness = { status: "connecting", error: null };
    let catalog = null;
    const productResolver = (slug) => catalog?.getCheckoutProduct(slug) ?? getCheckoutProduct(slug);
    const callbacks = createAccessCallbacks(tenant, store);
    const context = {
      tenant,
      environment: tenantEnvironment,
      store,
      installmentService,
      readiness,
      productResolver,
      ...callbacks,
    };
    context.dataReady = Promise.resolve()
      .then(() => store.ensureSchema())
      .then(() => store.listCatalogProducts())
      .then((products) => {
        if (!products.length && environment.nodeEnvironment === "production") {
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
  const ready = Promise.resolve()
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
    .then(() => Promise.all([...contexts.values()].map((context) => context.dataReady)))
    .then((result) => {
      for (const context of contexts.values()) context.readiness.status = "ready";
      return result;
    })
    .catch((error) => {
      for (const context of contexts.values()) {
        if (context.readiness.status !== "error") {
          context.readiness.status = "error";
          context.readiness.error = error?.code || error?.name || "provider_initialization_failed";
        }
      }
      throw error;
    });

  for (const context of contexts.values()) {
    context.ready = ready;
    context.waitForReady = () => {
      if (context.readiness.status === "ready" || context.readiness.status === "error") return Promise.resolve();
      return new Promise((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        const settle = () => {
          clearTimeout(timeout);
          resolve();
        };
        ready.then(settle, settle);
      });
    };
  }

  const app = express();
  const allowedOrigins = new Set(tenants.map((tenant) => tenant.publicOrigin));
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(requestContext);
  app.use(cors({
    origin(received, callback) {
      if (!received || allowedOrigins.has(received)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization", "Idempotency-Key", "asaas-access-token", "x-academy-trusted-token"],
    maxAge: 86_400,
  }));
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", async (_request, response) => {
    await Promise.all([...contexts.values()].map((context) => context.waitForReady()));
    if (contexts.size === 1) {
      const available = defaultContext.readiness.status === "ready";
      return response.status(available ? 200 : 503).json({
        status: available ? "ok" : defaultContext.readiness.status,
        service: "academy-api",
        database: {
          status: defaultContext.readiness.status,
          error: defaultContext.readiness.error,
        },
        capabilities: {
          checkout: available && environment.checkoutEnabled,
        },
      });
    }
    const platforms = Object.fromEntries([...contexts].map(([id, context]) => [id, {
      database: context.readiness.status,
      checkout: context.readiness.status === "ready" && environment.checkoutEnabled,
    }]));
    const available = Object.values(platforms).every((platform) => platform.database === "ready");
    response.status(available ? 200 : 503).json({
      status: available ? "ok" : "error",
      service: "payments-api",
      environment: environment.asaasEnvironment,
      platforms,
    });
  });

  for (const context of contexts.values()) {
    const middleware = [tenantOrigin(context.tenant), tenantReadiness(context)];
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

  app.post("/v1/webhooks/asaas", (request, response) => {
    const externalReference = String(request.body?.payment?.externalReference ?? "").trim();
    const prefix = externalReference.split(":", 1)[0].toLowerCase();
    const context = referenceContexts.get(prefix);
    if (!context) return response.status(400).json({ error: "invalid_webhook" });
    return context.webhookHandler(request, response);
  });

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
    contexts,
    tenants,
    store: defaultContext.store,
    stores: new Map([...contexts].map(([id, context]) => [id, context.store])),
    readiness: defaultContext.readiness,
    ready,
    waitForReady: defaultContext.waitForReady,
  };
}
