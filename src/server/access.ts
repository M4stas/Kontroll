import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookieSecret } from '../config/env';
export const ACCESS_TTL = 86400;
export const cookieName = (jobId: string) => `kontroll_access_${jobId}`;
const signature = (jobId: string, expires: string) => createHmac('sha256', cookieSecret()).update(`${jobId}:${expires}`).digest('hex');
export function issueAccess(jobId: string, now = Math.floor(Date.now()/1000)) {
  const expires = String(now + ACCESS_TTL);
  return `${expires}.${signature(jobId, expires)}`;
}
export function verifyAccess(jobId: string, token: string | undefined, now = Math.floor(Date.now()/1000)) {
  if (!token) return false;
  const [expires, signed] = token.split('.');
  if (!expires || !/^\d{1,12}$/.test(expires) || Number(expires) <= now || !signed || !/^[a-f0-9]{64}$/.test(signed) || token !== `${expires}.${signed}`) return false;
  return timingSafeEqual(Buffer.from(signed, 'hex'), Buffer.from(signature(jobId, expires), 'hex'));
}
