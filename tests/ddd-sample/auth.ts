import { Customer, Order } from "./models.js";

export const readAuthProfile = (customer: Customer) => ({
  passwordHash: customer.passwordHash,
  mfaEnabled: customer.mfaEnabled,
});

export const chargeFee = (amount: number, currency: string) =>
  `${currency}:${String(amount)}`;

export const isOrderReady = (o: Order) =>
  o.status === "OPEN" && o.items.length > 0;
