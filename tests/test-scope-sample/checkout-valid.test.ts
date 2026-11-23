import { checkout } from "./checkout.js";
import * as priceParser from "./price-parser.js";

describe("checkout valid tests", () => {
  it("composes parsing, total calculation, and order saving", () => {
    expect(checkout("$10")).toEqual({ price: 10, total: 11, saved: true });
  });

  it("preserves invariant that total is at least parsed price", () => {
    const res = checkout("$20");
    expect(res.total).toBeGreaterThanOrEqual(res.price);
  });

  it("isolates checkout when parsePrice is stubbed", () => {
    vi.spyOn(priceParser, "parsePrice").mockReturnValue(42);
    expect(checkout("$10").price).toBe(42);
  });
});
