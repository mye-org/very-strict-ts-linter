import { Customer, Order } from "./models.js";

export const readBillingProfile = (customer: Customer) => ({
  taxId: customer.taxId,
  billingAddress: customer.billingAddress,
});

export const formatInvoiceAmount = (amount: number, currency: string) =>
  `${String(amount)} ${currency}`;

export const canInvoiceOrder = (order: Order) =>
  order.status === "OPEN" && order.items.length > 0;
