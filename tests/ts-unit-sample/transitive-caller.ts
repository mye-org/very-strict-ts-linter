import { logAudit } from "./transitive-impure-leaf.js";

export const computePure = (n: number) => n + 1;
export const runAction = (label: string) => logAudit(label);
