// Room codes: 6 characters without look-alikes (no 0/O, no 1/I/L), displayed as K7F-2QM.
export const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;

export function normalizeCode(input) {
  const code = String(input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((char) => ALPHABET.includes(char)) ? code : null;
}

export function formatCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
