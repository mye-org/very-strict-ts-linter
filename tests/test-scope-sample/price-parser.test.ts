import { parsePrice } from "./price-parser.js";

describe("parsePrice", () => {
  it("parses valid dollar amounts", () => {
    expect(parsePrice("$10")).toBe(10);
  });

  it("throws on invalid price input", () => {
    expect(() => parsePrice("bad")).toThrow("Invalid price");
  });
});
