// Canonical persisted field is postCode. Accept historical/browser aliases at
// boundaries, but reject conflicting aliases instead of silently changing destination.
export function galaticPostcode(address = {}) {
  address ??= {};
  const values = [address.postCode, address.postalCode, address.postal_code, address.cep]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => String(value).replace(/\D/g, ""));
  if (new Set(values).size > 1) throw Object.assign(new Error("shipping_destination_mismatch"), { code: "shipping_destination_mismatch" });
  return values[0] ?? "";
}

export function assertShippingAddress(address) {
  if (!/^\d{8}$/.test(address.postalCode) || !/^[A-Z]{2}$/.test(address.state)
      || !address.street || !address.number || !address.district || !address.city) {
    throw Object.assign(new Error("invalid_shipping_address"), { code: "invalid_shipping_address" });
  }
}
