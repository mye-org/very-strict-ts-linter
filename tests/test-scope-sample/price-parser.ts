export const parsePrice = (raw: string): number => {
  if (!raw.startsWith("$")) {
    throw new Error("Invalid price");
  }
  const value = Number(raw.slice(1));
  if (Number.isNaN(value) || value < 0) {
    throw new Error("Invalid price");
  }
  return value;
};
