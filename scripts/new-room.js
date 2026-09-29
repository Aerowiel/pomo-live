// Prints a fresh room code, editor secret and secret hash, for PINNED_ROOMS.
import { randomBytes } from 'node:crypto';
import { hashSecret, newCode } from '../lib/rooms.js';

const code = newCode();
const secret = randomBytes(24).toString('base64url');
console.log(`code=${code}\nsecret=${secret}\nPINNED_ROOMS entry=${code}:${hashSecret(secret)}`);
