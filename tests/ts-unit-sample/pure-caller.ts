import { validateZip } from "./barrel.js";
import { usedByMany } from "./test-only-leak.js";

export const validateAddress = (street: string, zip: string) =>
  street.length > 0 && validateZip(zip) && usedByMany(street).length > 0;
