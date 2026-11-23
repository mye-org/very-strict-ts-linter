import { decodePayload, encodePayload } from "./codec.js";
import { formatEmail } from "./email-formatter.js";
import { parsePrice } from "./price-parser.js";
import { computeShipping } from "./shipping-calculator.js";
import { calculateTotal } from "./total-calculator.js";

describe("test responsibility examples", () => {
  it("mixes unrelated price parsing, email formatting, and shipping", () => {
    expect(parsePrice("$10")).toBe(10);
    expect(formatEmail("User@Example.COM")).toBe("user@example.com");
    expect(computeShipping(5)).toBe(12);
  });

  it("round-trips codec payload", () => {
    const encoded = encodePayload("hello");
    expect(decodePayload(encoded)).toBe("hello");
  });

  it("pipes parsed price into total calculation", () => {
    const price = parsePrice("$10");
    expect(calculateTotal([price])).toBe(11);
  });
});
