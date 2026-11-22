import * as OrderQueries from "./order-queries.js";
import type { Order } from "./order-queries.js";
import { formatMoney } from "./small-adt.js";

export const buildShipmentManifest = (order: Order) => ({
  weight: OrderQueries.getWeight(order),
  dims: OrderQueries.getDimensions(order),
  label: OrderQueries.getShippingLabel(order),
  fee: formatMoney({ amount: 10, currency: "USD" }),
});
