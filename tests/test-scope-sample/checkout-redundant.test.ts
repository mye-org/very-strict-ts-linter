import { checkout, parsePrice } from "./barrel.js";

describe("checkout redundant tests", () => {
  it("checkout parses price via barrel", () => {
    expect(checkout("$10").price).toBe(10);
  });

  it("checkout rejects invalid price error", () => {
    expect(() => checkout("bad")).toThrow("Invalid price");
  });

  it("checkout parses price using node assert", () => {
    assert.strictEqual(checkout("$25").price, 25);
  });

  it("parses ninety nine dollars first", () => {
    expect(parsePrice("$99")).toBe(99);
  });

  it("parses ninety nine dollars duplicate", () => {
    expect(parsePrice("$99")).toBe(99);
  });
});
