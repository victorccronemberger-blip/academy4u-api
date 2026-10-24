const REFUND_STATUSES = new Set(["PENDING", "AWAITING_CRITICAL_ACTION_AUTHORIZATION",
  "AWAITING_CUSTOMER_EXTERNAL_AUTHORIZATION", "CANCELLED", "DONE"]);

// This is an indication in the related payment/group response, never a current
// provider query, proof about this new refund or evidence of financial completion.
export function refundRequestReason(response, providerReference) {
  if (!response || typeof response !== "object" || Array.isArray(response)
    || typeof providerReference !== "string" || !providerReference || response.id !== providerReference
    || !Array.isArray(response.refunds) || response.refunds.length !== 1
    || response.refunds.some((refund) => !refund || typeof refund !== "object" || Array.isArray(refund)
      || !REFUND_STATUSES.has(refund.status))) return null;
  return response.refunds[0].status === "AWAITING_CRITICAL_ACTION_AUTHORIZATION"
    ? "refund_authorization_required" : null;
}

export function refundOperationView(row) {
  if (!row) return null;
  const authorizationRequired = row.state === "requested" && row.error_code === "refund_authorization_required";
  return { state: row.state, attempt_version: Number(row.attempt_version), error_code: row.error_code ?? null,
    authorization_required: authorizationRequired,
    authorization_source: authorizationRequired ? "refund_request_response" : null };
}
