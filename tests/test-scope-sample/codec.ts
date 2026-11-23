export const encodePayload = (text: string): string => `ENC:${text}`;

export const decodePayload = (raw: string): string =>
  raw.startsWith("ENC:") ? raw.slice(4) : raw;
