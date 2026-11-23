import { saveOrder } from "./order-repository.js";
import { parsePrice } from "./price-parser.js";
import { calculateTotal } from "./total-calculator.js";

export const checkout = (rawPrice: string) => {
  const price = parsePrice(rawPrice);
  const total = calculateTotal([price]);
  const saved = saveOrder(total);
  return { price, total, saved };
};
