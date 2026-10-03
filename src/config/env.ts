import 'server-only';
import { ApiError } from '../server/errors';
export function serviceConfig() {
    try {
        const raw = process.env.AUTO24_SERVICE_URL ?? '';
        const url = new URL(raw);
        const key = process.env.AUTO24_SERVICE_API_KEY;
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !key?.trim())
            throw Error();
        cookieSecret();
        return { origin: url.origin, key };
    }
    catch {
        throw new ApiError('configuration_error', 503);
    }
}
export function cookieSecret() {
    const secret = process.env.ANALYSIS_COOKIE_SECRET;
    if (!secret || secret.length < 32)
        throw new ApiError('configuration_error', 503);
    return secret;
}
import { parseApplicationEnv } from './application';
export type ServerEnv = ReturnType<typeof parseApplicationEnv>;
export function getServerEnv(): ServerEnv { return parseApplicationEnv(process.env); }
import { resolveReviewConfig } from "./review";
export function getReviewConfig() { return resolveReviewConfig(process.env); }
