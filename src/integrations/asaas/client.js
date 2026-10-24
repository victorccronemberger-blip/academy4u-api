const USER_AGENT = "Academy4u/1.0 (api.academy4u.com.br)";

export class AsaasApiError extends Error {
  constructor(message, { endpoint, status, code, retryable = false } = {}) {
    super(message);
    this.name = "AsaasApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function asaasError(body) {
  const first = Array.isArray(body?.errors) ? body.errors[0] : null;
  return {
    code: typeof first?.code === "string" ? first.code : "asaas_request_failed",
    message: typeof first?.description === "string"
      ? first.description
      : "A Asaas não conseguiu processar a solicitação.",
  };
}

export function createAsaasClient(environment, fetchImplementation = fetch) {
  if (!environment.asaasAvailable) return null;

  // Semáforo de saída: sem ele, um pico de checkouts dispara chamadas
  // simultâneas ilimitadas à Asaas, estoura sockets/memória do processo e
  // provoca 429 no provedor. O excesso falha rápido como erro recuperável.
  const MAX_CONCURRENT = 8;
  const MAX_QUEUED = 100;
  let inFlight = 0;
  const waitQueue = [];

  function acquireSlot() {
    if (inFlight < MAX_CONCURRENT) {
      inFlight += 1;
      return Promise.resolve();
    }
    if (waitQueue.length >= MAX_QUEUED) {
      return Promise.reject(new AsaasApiError(
        "O serviço de pagamento está saturado; tente novamente em instantes.",
        // Saturação local: falha rápida ao chamador (backpressure), sem retry —
        // re-tentar só aumentaria a pressão sobre a fila.
        { code: "asaas_overloaded", retryable: false },
      ));
    }
    return new Promise((resolve) => waitQueue.push(resolve));
  }

  function releaseSlot() {
    inFlight -= 1;
    const next = waitQueue.shift();
    if (next) {
      inFlight += 1;
      next();
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function request(pathname, { method = "GET", body, timeoutMs = 65_000 } = {}) {
    await acquireSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImplementation(`${environment.asaasApiOrigin}${pathname}`, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          access_token: environment.asaasApiKey,
          "user-agent": USER_AGENT,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AsaasApiError("A Asaas não respondeu a tempo.", {
        endpoint: pathname,
        code: error?.name === "AbortError" ? "asaas_timeout" : "asaas_network_error",
        retryable: true,
      });
    } finally {
      clearTimeout(timeout);
      releaseSlot();
    }

    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = asaasError(result);
      throw new AsaasApiError(parsed.message, {
        endpoint: pathname,
        status: response.status,
        code: parsed.code,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return result;
  }

  // Retry só em leituras (GET): criar/cobrar não é idempotente na Asaas e uma
  // repetição poderia gerar cobrança dupla. Backoff exponencial com jitter
  // evita que clientes sincronizados retentem todos no mesmo instante.
  const RETRY_DELAYS_MS = [400, 1_200];
  async function requestWithRetry(pathname, options = {}) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(pathname, options);
      } catch (error) {
        const canRetry = error instanceof AsaasApiError && error.retryable && attempt < RETRY_DELAYS_MS.length;
        if (!canRetry) throw error;
        await sleep(RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 200));
      }
    }
  }

  return Object.freeze({
    verifyCredentials: () => requestWithRetry("/myAccount/accountNumber", { timeoutMs: 15_000 }),
    getAccountFees: () => requestWithRetry("/myAccount/fees/", { timeoutMs: 15_000 }),
    simulatePayment: (payload) => request("/payments/simulate", { method: "POST", body: payload, timeoutMs: 15_000 }),
    findCustomersByDocument: (cpfCnpj) => requestWithRetry(`/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}&limit=1`),
    createCustomer: (payload) => request("/customers", { method: "POST", body: payload }),
    findPaymentsByExternalReference: (reference) => requestWithRetry(`/payments?externalReference=${encodeURIComponent(reference)}&limit=100`),
    createPayment: (payload) => request("/payments", { method: "POST", body: payload }),
    updatePayment: (paymentId, payload) => request(`/payments/${encodeURIComponent(paymentId)}`, { method: "PUT", body: payload }),
    deletePayment: (paymentId) => request(`/payments/${encodeURIComponent(paymentId)}`, { method: "DELETE" }),
    refundPayment: (paymentId) => request(`/payments/${encodeURIComponent(paymentId)}/refund`, { method: "POST" }),
    refundInstallment: (installmentId) => request(`/installments/${encodeURIComponent(installmentId)}/refund`, { method: "POST" }),
    deleteInstallment: (installmentId) => request(`/installments/${encodeURIComponent(installmentId)}`, { method: "DELETE" }),
    getPayment: (paymentId) => requestWithRetry(`/payments/${encodeURIComponent(paymentId)}`),
    getPixQrCode: (paymentId) => requestWithRetry(`/payments/${encodeURIComponent(paymentId)}/pixQrCode`),
    listInstallmentPayments: (installmentId) => requestWithRetry(
      `/installments/${encodeURIComponent(installmentId)}/payments?limit=100`,
    ),
  });
}
