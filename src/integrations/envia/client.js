function providerError(result, response) {
  const embeddedError = result?.meta === "error" || result?.error;
  if (response.ok && !embeddedError) return null;
  const error = new Error(result?.error?.message || result?.error?.description || "envia_request_failed");
  error.code = "envia_request_failed";
  error.status = response.status;
  error.details = result?.error ?? result;
  return error;
}

async function jsonRequest(url, apiKey, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.json().catch(() => null);
  const error = providerError(result, response);
  if (error) throw error;
  return result;
}

export function createEnviaClient(environment) {
  const apiKey = environment.galaticEnviaApiKey;
  const shipping = environment.galaticEnviaApiOrigin;
  const queries = environment.galaticEnviaQueriesOrigin;
  return {
    ready: Boolean(apiKey),
    environment: environment.galaticEnviaEnvironment,
    quote: (payload) => jsonRequest(`${shipping}/ship/rate/`, apiKey, { method: "POST", body: payload }),
    generateLabel: (payload) => jsonRequest(`${shipping}/ship/generate/`, apiKey, { method: "POST", body: payload }),
    track: (trackingNumbers) => jsonRequest(`${shipping}/ship/generaltrack/`, apiKey, { method: "POST", body: { trackingNumbers } }),
    cancel: ({ carrier, trackingNumber }) => jsonRequest(`${shipping}/ship/cancel/`, apiKey, { method: "POST", body: { carrier, trackingNumber } }),
    listWebhookTypes: () => jsonRequest(`${queries}/webhook-types`, apiKey),
    listWebhooks: () => jsonRequest(`${queries}/webhooks`, apiKey),
    createWebhook: (body) => jsonRequest(`${queries}/webhooks`, apiKey, { method: "POST", body }),
  };
}
