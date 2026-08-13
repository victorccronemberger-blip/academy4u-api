export const MAX_INTEREST_FREE_INSTALLMENTS = 10;
export const MAX_PIX_INSTALLMENTS = 6;
export const MIN_CARD_INSTALLMENT_CENTS = 500;
export const MIN_PIX_INSTALLMENT_CENTS = 1_000;
export const MIN_INSTALLMENT_CENTS = MIN_CARD_INSTALLMENT_CENTS;

export function allocateInstallmentCents(totalCents, count) {
  if (
    !Number.isSafeInteger(totalCents)
    || totalCents < 1
    || !Number.isSafeInteger(count)
    || count < 1
  ) {
    return [];
  }
  const base = Math.floor(totalCents / count);
  const remainder = totalCents % count;
  return Array.from(
    { length: count },
    (_, index) => base + (index < remainder ? 1 : 0),
  );
}

export function createInterestFreeInstallments(
  totalCents,
  {
    maximum = MAX_INTEREST_FREE_INSTALLMENTS,
    minimumInstallmentCents = MIN_INSTALLMENT_CENTS,
  } = {},
) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 1) return [];

  const safeMaximum = Math.min(
    MAX_INTEREST_FREE_INSTALLMENTS,
    Number.isSafeInteger(maximum) ? Math.max(1, maximum) : MAX_INTEREST_FREE_INSTALLMENTS,
  );
  const safeMinimum = Number.isSafeInteger(minimumInstallmentCents)
    ? Math.max(1, minimumInstallmentCents)
    : MIN_INSTALLMENT_CENTS;
  if (totalCents < safeMinimum) return [];
  const availableMaximum = Math.max(1, Math.min(safeMaximum, Math.floor(totalCents / safeMinimum)));

  return Array.from({ length: availableMaximum }, (_, index) => {
    const number = index + 1;
    const installmentAmountsCents = allocateInstallmentCents(totalCents, number);
    return {
      number,
      totalCents,
      installmentCents: installmentAmountsCents[0],
      lastInstallmentCents: installmentAmountsCents.at(-1),
      installmentAmountsCents,
      interestFree: true,
    };
  });
}

export function interestFreeInstallment(totalCents, number, options) {
  return createInterestFreeInstallments(totalCents, options)
    .find((option) => option.number === number) ?? null;
}
