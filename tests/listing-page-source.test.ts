import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cookies } from 'next/headers';
import ListingPage from '../src/app/[locale]/a/[jobId]/page';
import { cookieName, issueAccess } from '../src/server/access';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), notFound: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
const jobId = 'job-123';
const sourceUrl = 'https://www.auto24.ee/soidukid/123';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe('fresh dashboard source address', () => {
  it('renders the signed submitted address before any successful poll or session storage', async () => {
    vi.stubEnv('ANALYSIS_COOKIE_SECRET', 'x'.repeat(32));
    const token = issueAccess(jobId, undefined, sourceUrl);
    vi.mocked(cookies).mockResolvedValue({ get: (name: string) => name === cookieName(jobId) ? {value: token} : undefined } as Awaited<ReturnType<typeof cookies>>);
    const fetcher = vi.fn(async () => new Response(null, {status: 503}));
    vi.stubGlobal('fetch', fetcher);
    const page = await ListingPage({params: Promise.resolve({locale: 'en', jobId})});
    const html = renderToStaticMarkup(page);
    expect(html).toContain(`href="${sourceUrl}"`);
    expect(html).toContain(sourceUrl);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not expose a source address from a tampered cookie on the access fallback', async () => {
    vi.stubEnv('ANALYSIS_COOKIE_SECRET', 'x'.repeat(32));
    const token = issueAccess(jobId, undefined, sourceUrl) + 'x';
    vi.mocked(cookies).mockResolvedValue({ get: () => ({value: token}) } as Awaited<ReturnType<typeof cookies>>);
    const page = await ListingPage({params: Promise.resolve({locale: 'en', jobId})});
    expect(renderToStaticMarkup(page)).not.toContain(sourceUrl);
  });
});
