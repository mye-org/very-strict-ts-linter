export type Order = {
  readonly total: number;
  readonly tax: number;
  readonly billingAddress: string;
  readonly weightKg: number;
  readonly dimensionsCm: string;
  readonly shippingLabel: string;
};

export const getInvoiceTotal = (o: Order) => o.total + o.tax;
export const getTaxBreakdown = (o: Order) => o.tax;
export const getBillingAddress = (o: Order) => o.billingAddress;
export const getWeight = (o: Order) => o.weightKg;
export const getDimensions = (o: Order) => o.dimensionsCm;
export const getShippingLabel = (o: Order) => o.shippingLabel;
