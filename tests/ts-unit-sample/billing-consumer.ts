import { getBillingAddress, getInvoiceTotal, getTaxBreakdown } from "./barrel.js";
import type { Order } from "./order-queries.js";
import { createMoney } from "./small-adt.js";

export const buildInvoiceSummary = (order: Order) => ({
  total: createMoney(getInvoiceTotal(order), "USD"),
  tax: getTaxBreakdown(order),
  address: getBillingAddress(order),
});
