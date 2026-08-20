const digits = (value) => String(value ?? "").replace(/\D/g, "");

export class CreditCardInputError extends Error {
  constructor(message, code = "invalid_credit_card") {
    super(message);
    this.name = "CreditCardInputError";
    this.code = code;
  }
}

function text(value, minimum, maximum, label) {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new CreditCardInputError(`${label} inválido.`);
  }
  return normalized;
}

export function parseCreditCard(input) {
  if (!input || Array.isArray(input) || typeof input !== "object") {
    throw new CreditCardInputError("Informe os dados do cartão.");
  }
  const allowed = new Set(["holderName", "number", "expiryMonth", "expiryYear", "ccv"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new CreditCardInputError("Os dados do cartão contêm campos não permitidos.", "unexpected_fields");
  }
  const number = digits(input.number);
  const expiryMonth = digits(input.expiryMonth);
  let expiryYear = digits(input.expiryYear);
  const ccv = digits(input.ccv);
  if (number.length < 13 || number.length > 19) {
    throw new CreditCardInputError("Número do cartão inválido.");
  }
  if (expiryYear.length === 2) expiryYear = `20${expiryYear}`;
  const month = Number(expiryMonth);
  const year = Number(expiryYear);
  const now = new Date();
  if (month < 1 || month > 12 || year < now.getUTCFullYear() || year > now.getUTCFullYear() + 25) {
    throw new CreditCardInputError("Validade do cartão inválida.");
  }
  if (year === now.getUTCFullYear() && month < now.getUTCMonth() + 1) {
    throw new CreditCardInputError("O cartão está vencido.");
  }
  if (ccv.length < 3 || ccv.length > 4) {
    throw new CreditCardInputError("Código de segurança inválido.");
  }
  return {
    holderName: text(input.holderName, 3, 100, "Nome impresso no cartão"),
    number,
    expiryMonth: String(month).padStart(2, "0"),
    expiryYear: String(year),
    ccv,
  };
}

export function cardHolderInfo(buyer) {
  const address = buyer.address ?? {};
  return {
    name: buyer.name,
    email: buyer.email,
    cpfCnpj: buyer.cpfCnpj,
    postalCode: address.postCode ?? undefined,
    addressNumber: address.number ?? "S/N",
    addressComplement: address.complement ?? undefined,
    phone: buyer.mobilePhone,
    mobilePhone: buyer.mobilePhone,
  };
}
