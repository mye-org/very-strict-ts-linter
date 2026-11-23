import { computeTax } from "./tax-calculator.js";

describe("computeTax", () => {
  it("computes ten percent tax", () => {
    expect(computeTax(100)).toBe(10);
  });
});
