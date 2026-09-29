// Usage: node scripts/new-room.js [code]. Prints the editor secret and the PINNED_ROOMS entry.
import { randomBytes } from 'node:crypto';
import { normalizeCode } from '../public/codes.js';
import { hashSecret, newCode } from '../lib/rooms.js';

const code = process.argv[2] ? normalizeCode(process.argv[2]) : newCode();
if (!code) throw new Error(`invalid code: ${process.argv[2]}`);
const secret = randomBytes(24).toString('base64url');
console.log(`code=${code}\nsecret=${secret}\nPINNED_ROOMS entry=${code}:${hashSecret(secret)}`);
