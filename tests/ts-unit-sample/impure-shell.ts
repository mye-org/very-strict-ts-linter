import { calculateDiscount } from "./pure-core.js";
import { usedByMany } from "./test-only-leak.js";

export const checkoutOrder = (amount: number, rate: number) => {
  const discounted = calculateDiscount(amount, rate);
  const label = usedByMany(String(discounted));
  console.log(label);
  return Date.now() + discounted;
};
