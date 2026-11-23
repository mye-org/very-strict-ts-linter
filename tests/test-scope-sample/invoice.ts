import { computeTax } from "./tax-calculator.js";

const formatLabel = (amount: number): string => `INV-${String(amount)}`;

export const createInvoice = (amount: number) => {
  const tax = computeTax(amount);
  const label = formatLabel(amount);
  return { tax, label };
};
