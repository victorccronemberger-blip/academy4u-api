function parseBoolean(value) {
  return String(value).trim().toLowerCase() === "true";
}

function parsePort(value) {
  const port = Number(value ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return port;
}

function parseAsaasEnvironment(value) {
  const environment = String(value ?? "sandbox").trim().toLowerCase();
  if (!["sandbox", "production"].includes(environment)) {
    throw new Error("ASAAS_ENVIRONMENT must be sandbox or production.");
  }
  return environment;
}

function parseAsaasApiKey(value) {
  const transported = String(value ?? "").trim();
  const key = transported.startsWith("\\$aact_") ? transported.slice(1) : transported;
  if (!key) return null;
  // Alguns runtimes gerenciados interpolam ou escapam o "$" inicial ao injetar
  // variáveis de ambiente. Normaliza essas formas de transporte e devolve a
  // credencial original ao processo.
  return key.startsWith("aact_") ? `$${key}` : key;
}

export function getEnvironment(source = process.env) {
  const asaasEnvironment = parseAsaasEnvironment(source.ASAAS_ENVIRONMENT);
  const asaasProductionApiKey = parseAsaasApiKey(source.ASAAS_API_KEY);
  const asaasSandboxApiKey = parseAsaasApiKey(source.ASAAS_SANDBOX);
  // Mantém as credenciais isoladas por ambiente. ASAAS_API_KEY continua sendo
  // aceita no sandbox como compatibilidade para instalações antigas, mas uma
  // ASAAS_SANDBOX presente sempre tem precedência durante os testes.
  const asaasApiKey = asaasEnvironment === "production"
    ? asaasProductionApiKey
    : asaasSandboxApiKey ?? asaasProductionApiKey;
  const asaasProductionWebhookToken = source.ASAAS_WEBHOOK_TOKEN?.trim() || null;
  const asaasSandboxWebhookToken = source.ASAAS_SANDBOX_WEBHOOK_TOKEN?.trim() || null;
  const asaasWebhookToken = asaasEnvironment === "production"
    ? asaasProductionWebhookToken
    : asaasSandboxWebhookToken ?? asaasProductionWebhookToken;
  const asaasRequested = parseBoolean(source.ASAAS_ENABLED ?? "false");
  const asaasAvailable = Boolean(asaasApiKey);

  return {
    nodeEnvironment: source.NODE_ENV?.trim().toLowerCase() || "development",
    host: source.HOST?.trim() || "0.0.0.0",
    port: parsePort(source.PORT),
    publicOrigin: source.PUBLIC_ORIGIN?.trim() || "https://academy4u.com.br",
    mysqlUrl: source.MYSQL_URL?.trim() || null,
    // Segredo compartilhado com o frontend (LMS): criação de pedidos via
    // chamada servidor-a-servidor (cabeçalho x-academy-trusted-token).
    trustedCheckoutToken: source.TRUSTED_CHECKOUT_TOKEN?.trim() || null,
    asaasEnvironment,
    asaasRequested,
    asaasProductionApiKey,
    asaasSandboxApiKey,
    asaasProductionWebhookToken,
    asaasSandboxWebhookToken,
    asaasApiOrigin: asaasEnvironment === "production"
      ? "https://api.asaas.com/v3"
      : "https://api-sandbox.asaas.com/v3",
    asaasApiKey,
    asaasWebhookToken,
    asaasWebhookTokenHash: null,
    asaasAvailable,
    checkoutEnabled: asaasRequested && asaasAvailable,
  };
}

export function applyAsaasRuntimeConfig(environment, runtime = {}) {
  const target = parseAsaasEnvironment(runtime.environment ?? environment.asaasEnvironment);
  const productionWebhookTokenHash = String(runtime.productionWebhookTokenHash ?? "").trim().toLowerCase();
  if (productionWebhookTokenHash && !/^[a-f0-9]{64}$/.test(productionWebhookTokenHash)) {
    throw new Error("The production Asaas webhook token hash is invalid.");
  }

  environment.asaasEnvironment = target;
  environment.asaasApiOrigin = target === "production"
    ? "https://api.asaas.com/v3"
    : "https://api-sandbox.asaas.com/v3";
  environment.asaasApiKey = target === "production"
    ? environment.asaasProductionApiKey
    : environment.asaasSandboxApiKey ?? environment.asaasProductionApiKey;
  environment.asaasWebhookToken = target === "production"
    ? environment.asaasProductionWebhookToken
    : environment.asaasSandboxWebhookToken ?? environment.asaasProductionWebhookToken;
  environment.asaasWebhookTokenHash = target === "production"
    ? productionWebhookTokenHash || null
    : null;
  environment.asaasAvailable = Boolean(environment.asaasApiKey);
  environment.checkoutEnabled = environment.asaasRequested && environment.asaasAvailable;
  return environment;
}
