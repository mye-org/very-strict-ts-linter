import { computeTax } from "./tax-calculator.js";

export const applyDiscount = (amount: number, pct: number): number => amount * (1 - pct);

export const quoteOrder = (amount: number, pct: number) => {
  const discount = applyDiscount(amount, pct);
  const tax = computeTax(discount);
  return { discount, tax };
};
