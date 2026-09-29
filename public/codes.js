// Random codes skip look-alike chars (0/o, 1/i/l), e.g. k7f2qm.
export const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const RANDOM_LENGTH = 6;
export const MAX_CODE = 24;
const CODE = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/;

export function normalizeCode(input) {
  const code = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return CODE.test(code) && !code.includes('--') ? code : null;
}
