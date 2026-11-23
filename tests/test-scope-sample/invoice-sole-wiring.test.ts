import { createInvoice } from "./invoice.js";

describe("createInvoice sole wiring and private helper", () => {
  it("wires computeTax into createInvoice", () => {
    expect(createInvoice(100).tax).toBe(10);
  });

  it("formats invoice label for small amount", () => {
    expect(createInvoice(100).label).toBe("INV-100");
  });

  it("formats invoice label for large amount", () => {
    expect(createInvoice(200).label).toBe("INV-200");
  });
});
