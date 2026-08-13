function repeatedDigits(value) {
  return /^(\d)\1+$/.test(value);
}

function validCpf(value) {
  if (value.length !== 11 || repeatedDigits(value)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(value[index]) * (length + 1 - index);
    }
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
}

function validCnpj(value) {
  if (value.length !== 14 || repeatedDigits(value)) return false;
  const digit = (length) => {
    const weights = length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce(
      (total, weight, index) => total + Number(value[index]) * weight,
      0,
    );
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return digit(12) === Number(value[12]) && digit(13) === Number(value[13]);
}

export function normalizeBrazilianTaxId(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return validCpf(digits) || validCnpj(digits) ? digits : null;
}
