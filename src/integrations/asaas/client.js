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

  async function request(pathname, { method = "GET", body, timeoutMs = 65_000 } = {}) {
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

  return Object.freeze({
    verifyCredentials: () => request("/myAccount/accountNumber", { timeoutMs: 15_000 }),
    findCustomersByDocument: (cpfCnpj) => request(`/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}&limit=1`),
    createCustomer: (payload) => request("/customers", { method: "POST", body: payload }),
    createPayment: (payload) => request("/payments", { method: "POST", body: payload }),
    updatePayment: (paymentId, payload) => request(`/payments/${encodeURIComponent(paymentId)}`, { method: "PUT", body: payload }),
    getPayment: (paymentId) => request(`/payments/${encodeURIComponent(paymentId)}`),
    getPixQrCode: (paymentId) => request(`/payments/${encodeURIComponent(paymentId)}/pixQrCode`),
    listInstallmentPayments: (installmentId) => request(
      `/installments/${encodeURIComponent(installmentId)}/payments?limit=100`,
    ),
  });
}
