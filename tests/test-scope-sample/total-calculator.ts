export const calculateTotal = (prices: ReadonlyArray<number>): number =>
  prices.reduce((acc, p) => acc + p, 0) + 1;
