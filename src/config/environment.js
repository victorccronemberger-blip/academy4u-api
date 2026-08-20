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

function parsePositiveInteger(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseAsaasEnvironment(value) {
  const environment = String(value ?? "sandbox").trim().toLowerCase();
  if (!["sandbox", "production"].includes(environment)) {
    throw new Error("ASAAS_ENVIRONMENT must be sandbox or production.");
  }
  return environment;
}

function parseEnviaEnvironment(value) {
  const environment = String(value ?? "sandbox").trim().toLowerCase();
  if (!['sandbox', 'production'].includes(environment)) {
    throw new Error("GALATIC_ENVIA_ENVIRONMENT must be sandbox or production.");
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

// Remetente/origem das cotações de frete da Galatic. Os dados comerciais
// ficam exclusivamente nas variáveis de ambiente; sem o conjunto completo a
// cotação falha fechada (503) em vez de usar valores embutidos no código.
function parseGalaticShippingOrigin(source) {
  const value = (key) => source[`GALATIC_SHIPPING_${key}`]?.trim();
  const digits = (key) => value(key)?.replace(/\D/g, "");
  const origin = {
    name: value("NAME"),
    email: value("EMAIL"),
    phone: digits("PHONE"),
    street: value("STREET"),
    number: value("NUMBER"),
    district: value("DISTRICT"),
    city: value("CITY"),
    state: value("STATE")?.toUpperCase(),
    postalCode: digits("POSTAL_CODE"),
    taxId: digits("TAX_ID"),
  };
  return Object.values(origin).every(Boolean) ? origin : null;
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

  const galaticEnviaEnvironment = parseEnviaEnvironment(source.GALATIC_ENVIA_ENVIRONMENT);
  return {
    nodeEnvironment: source.NODE_ENV?.trim().toLowerCase() || "development",
    host: source.HOST?.trim() || "0.0.0.0",
    port: parsePort(source.PORT),
    // A primeira instalação na Hostinger usava os prefixos ACADEMY4U_ e
    // GALATIC_. Mantemos esses nomes como aliases para que uma implantação
    // nova possa reaproveitar o ambiente existente sem copiar ou revelar
    // credenciais no repositório.
    publicOrigin: source.PUBLIC_ORIGIN?.trim()
      || source.ACADEMY4U_ORIGIN?.trim()
      || source.ACADEMY4U_SUCCESS_ORIGIN?.trim()
      || "https://academy4u.com.br",
    mysqlUrl: source.MYSQL_URL?.trim()
      || (!source.PAYMENT_TENANTS ? source.GALATIC_DATABASE_URL?.trim() : null)
      || null,
    // Segredo compartilhado com o frontend (LMS): criação de pedidos via
    // chamada servidor-a-servidor (cabeçalho x-academy-trusted-token).
    trustedCheckoutToken: source.TRUSTED_CHECKOUT_TOKEN?.trim()
      || source.ACADEMY4U_TRUSTED_CHECKOUT_TOKEN?.trim()
      || null,
    paymentReferencePrefix: "academy",
    galaticEnviaApiKey: source.GALATIC_ENVIA_API_KEY?.trim() || null,
    galaticEnviaEnvironment,
    galaticEnviaApiOrigin: galaticEnviaEnvironment === "production"
      ? "https://api.envia.com"
      : "https://api-test.envia.com",
    galaticEnviaQueriesOrigin: galaticEnviaEnvironment === "production"
      ? "https://queries.envia.com"
      : "https://queries-test.envia.com",
    galaticEnviaWebhookSecret: source.GALATIC_ENVIA_WEBHOOK_SECRET?.trim() || null,
    galaticEnviaWebhookToken: source.GALATIC_ENVIA_WEBHOOK_TOKEN?.trim() || null,
    galaticShippingOrigin: parseGalaticShippingOrigin(source),
    galaticPaymentMaintenanceEnabled: parseBoolean(source.GALATIC_PAYMENT_MAINTENANCE_ENABLED ?? "true"),
    galaticPixReservationMinutes: parsePositiveInteger(source.GALATIC_PIX_RESERVATION_MINUTES, 60, "GALATIC_PIX_RESERVATION_MINUTES"),
    galaticCardReservationMinutes: parsePositiveInteger(source.GALATIC_CARD_RESERVATION_MINUTES, 4320, "GALATIC_CARD_RESERVATION_MINUTES"),
    galaticAdminEmail: source.GALATIC_ADMIN_EMAIL?.trim().toLowerCase() || null,
    galaticAdminPassword: source.GALATIC_ADMIN_PASSWORD || null,
    galaticDataEncryptionKey: source.GALATIC_DATA_ENCRYPTION_KEY?.trim() || null,
    galaticBotProtectionEnabled: parseBoolean(source.GALATIC_BOT_PROTECTION_ENABLED
      ?? (String(source.NODE_ENV).trim().toLowerCase() === "production" ? "true" : "false")),
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
    // Integração ART (matrícula principal). ART_ENABLED=false desliga sem
    // quebrar o fallback LMS. As demais variáveis têm defaults seguros.
    artEnabled: parseBoolean(source.ART_ENABLED ?? "false"),
    artApiOrigin: source.ART_API_ORIGIN?.trim() || "https://api.academiarafaeltoro.com.br",
    artIdmOrigin: source.ART_IDM_ORIGIN?.trim() || "https://ms-idm.academiarafaeltoro.com.br",
    artPublicKey: source.ART_PUBLIC_KEY || null,
    artFakeIp: source.ART_FAKE_IP?.trim() || "203.0.113.50",
    artRequestTimeoutMs: parsePositiveInteger(source.ART_REQUEST_TIMEOUT_MS, 8000, "ART_REQUEST_TIMEOUT_MS"),
    artRetryIntervalMs: parsePositiveInteger(source.ART_RETRY_INTERVAL_MS, 300000, "ART_RETRY_INTERVAL_MS"),
    artRetryMaxTries: parsePositiveInteger(source.ART_RETRY_MAX_TRIES, 8, "ART_RETRY_MAX_TRIES"),
    // Piso (não teto) da varredura de orders ART: o topo é descoberto
    // dinamicamente a partir daqui. Só precisa subir se um dia o topo já
    // estiver muito acima (performance da primeira sonda do processo).
    artScanFloor: parsePositiveInteger(source.ART_SCAN_FLOOR, 3180000, "ART_SCAN_FLOOR"),
    // Delays do fluxo de ativação (ms) — defaults são os valores validados.
    artProvisionPollMs: parsePositiveInteger(source.ART_PROVISION_POLL_MS, 4000, "ART_PROVISION_POLL_MS"),
    artPhase2WaitMs: parsePositiveInteger(source.ART_PHASE2_WAIT_MS, 5000, "ART_PHASE2_WAIT_MS"),
    artLoginPollMs: parsePositiveInteger(source.ART_LOGIN_POLL_MS, 3000, "ART_LOGIN_POLL_MS"),
    artVerifyWaitMs: parsePositiveInteger(source.ART_VERIFY_WAIT_MS, 25000, "ART_VERIFY_WAIT_MS"),
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
