export type Customer = {
  readonly id: string;
  readonly taxId: string;
  readonly billingAddress: string;
  readonly passwordHash: string;
  readonly mfaEnabled: boolean;
};

export type OrderItem = {
  readonly sku: string;
  readonly quantity: number;
};

/** @aggregateRoot */
export type Order = {
  readonly id: string;
  readonly status: string;
  readonly items: ReadonlyArray<OrderItem>;
};
