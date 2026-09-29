import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalListingUrl } from '../listings/contracts';
import { cookieSecret } from '../config/env';
export const ACCESS_TTL = 86400;
export const cookieName = (jobId: string) => `kontroll_access_${jobId}`;
const signature = (jobId: string, expires: string, source = '') => createHmac('sha256', cookieSecret()).update(`${jobId}:${expires}${source ? `:${source}` : ''}`).digest('hex');
export function issueAccess(jobId: string, now = Math.floor(Date.now()/1000), sourceUrl?: string) {
  const source = sourceUrl ? Buffer.from(canonicalListingUrl(sourceUrl)).toString('base64url') : '';
  const expires = String(now + ACCESS_TTL);
  return `${expires}.${signature(jobId, expires, source)}${source ? `.${source}` : ''}`;
}
export function verifyAccess(jobId: string, token: string | undefined, now = Math.floor(Date.now()/1000)) {
  if (!token) return false;
  const [expires, signed, source = ''] = token.split('.');
  if (!expires || !/^\d{1,12}$/.test(expires) || Number(expires) <= now || !signed || !/^[a-f0-9]{64}$/.test(signed) || token !== `${expires}.${signed}${source ? `.${source}` : ''}` || (source !== '' && !/^[A-Za-z0-9_-]+$/.test(source))) return false;
  return timingSafeEqual(Buffer.from(signed, 'hex'), Buffer.from(signature(jobId, expires, source), 'hex'));
}

export function readAccessSourceUrl(jobId: string, token: string | undefined): string | undefined {
  if (!verifyAccess(jobId, token)) return undefined;
  const source = token?.split('.')[2];
  if (!source) return undefined;
  try { return canonicalListingUrl(Buffer.from(source, 'base64url').toString('utf8')); }
  catch { return undefined; }
}
