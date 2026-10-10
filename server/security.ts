import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });

function loadKey() {
  const supplied = process.env.APP_ENCRYPTION_KEY;
  if (supplied) return createHash('sha256').update(supplied).digest();
  const keyPath = join(dataDir, '.encryption-key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  return createHash('sha256').update(readFileSync(keyPath)).digest();
}

const key = loadKey();

export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(value: string) {
  const [ivRaw, tagRaw, dataRaw] = value.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, 'base64url')), decipher.final()]).toString('utf8');
}

export function redactCookie(cookie = '') {
  return cookie
    .split(/\s*;\s*/)
    .map(part => part.split('=')[0] + '=••••••')
    .join('; ');
}

export function hashPassword(password: string, salt = randomBytes(16)) {
  return `${salt.toString('base64url')}.${scryptSync(password, salt, 32).toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string) {
  const [saltRaw, digestRaw] = stored.split('.');
  if (!saltRaw || !digestRaw) return false;
  const digest = scryptSync(password, Buffer.from(saltRaw, 'base64url'), 32);
  const expected = Buffer.from(digestRaw, 'base64url');
  return digest.length === expected.length && timingSafeEqual(digest, expected);
}
