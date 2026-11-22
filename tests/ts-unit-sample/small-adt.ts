export type Money = { readonly amount: number; readonly currency: string };

export const createMoney = (amount: number, currency: string): Money => ({ amount, currency });
export const addMoney = (a: Money, b: Money): Money => ({ amount: a.amount + b.amount, currency: a.currency });
export const formatMoney = (m: Money) => `${String(m.amount)} ${m.currency}`;
export const isZeroMoney = (m: Money) => m.amount === 0;
