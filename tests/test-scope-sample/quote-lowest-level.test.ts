import { quoteOrder } from "./discount-engine.js";

describe("quoteOrder delegated discount cases", () => {
  it("applies twenty percent discount via quoteOrder", () => {
    expect(quoteOrder(100, 0.2).discount).toBe(80);
  });

  it("applies ten percent discount via quoteOrder", () => {
    expect(quoteOrder(50, 0.1).discount).toBe(45);
  });
});
