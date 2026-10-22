/** Local, fake Supabase for manual background-check browser checks.
 * Run: pnpm --config.verify-deps-before-run=false exec tsx tests/e2e/background-check-preview.ts
 * Start Next separately with the three environment values printed below.
 */
import { createHash } from 'node:crypto';
import { createServer, request as proxyRequest } from 'node:http';

const publicId = '11111111-1111-4111-8111-111111111111';
const token = Buffer.alloc(32, 1).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
const objects = [
  '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
  '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
  '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
  '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
];
const content = 'BT /F1 12 Tf 10 100 Td (Fake vehicle history) Tj ET\n';
objects.push(`5 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}endstream endobj`);
let document = '%PDF-1.4\n';
const offsets = [0];
for (const object of objects) {
  offsets.push(Buffer.byteLength(document));
  document += `${object}\n`;
}
const xrefOffset = Buffer.byteLength(document);
document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
document += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
document += `trailer << /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
const pdf = Buffer.from(document);
let state: 'pending' | 'fetched' = 'pending';
let reportComplete = false;
let requestedAt = new Date().toISOString();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:4321');
  const json = (value: unknown) => {
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify(value));
  };
  if (url.pathname === '/state/pending' || url.pathname === '/state/fetched' || url.pathname === '/state/fetched-progress') {
    state = url.pathname.endsWith('/pending') ? 'pending' : 'fetched';
    reportComplete = url.pathname === '/state/fetched';
    requestedAt = new Date().toISOString();
    return json({state});
  }
  if (url.pathname === `/storage/v1/object/analysis-uploads/${publicId}/fake.pdf`) {
    response.writeHead(200, {'Content-Type': 'application/pdf', 'Content-Length': pdf.length});
    return response.end(pdf);
  }
  if (url.pathname === '/rest/v1/analyses') {
    return json({id: publicId, public_id: publicId, access_token_hash: tokenHash,
      current_run_id: null, status: reportComplete ? 'complete' : 'queued',
      locale: 'en', verdict: null, confidence: null, updated_at: requestedAt});
  }
  if (url.pathname === '/rest/v1/analysis_background_checks') {
    return json({analysis_id: publicId, service_job_id: 'fake-job', status: state,
      reason: null, searched_by: 'reg_number', requested_at: requestedAt,
      fetched_at: state === 'fetched' ? requestedAt : null,
      storage_key: state === 'fetched' ? `${publicId}/fake.pdf` : null,
      size_bytes: state === 'fetched' ? pdf.length : null,
      sha256: state === 'fetched' ? createHash('sha256').update(pdf).digest('hex') : null,
      updated_at: requestedAt});
  }
  if (request.method === 'GET' && url.pathname.startsWith('/rest/v1/')) return json([]);
  response.writeHead(404);
  response.end();
});
server.listen(4321, '127.0.0.1', () => {
  console.log('Fake Supabase ready at http://127.0.0.1:4321');
  console.log('NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:4321');
  console.log('SUPABASE_SERVICE_ROLE_KEY=fake');
  console.log('ANALYSIS_COOKIE_SECRET=background-check-preview-secret-32chars');
  console.log(`Preview: http://localhost:3000/en/r/${publicId}#access=${token}`);
  console.log('State: /state/pending, /state/fetched-progress or /state/fetched on http://127.0.0.1:4321');
});

// Force CSS media queries only for browser QA; application sources stay unchanged.
for (const [port, theme] of [[3108, 'light'], [3109, 'dark']] as const) {
  createServer((incoming, outgoing) => {
    const upstream = proxyRequest({
      hostname: '127.0.0.1', port: 3107, path: incoming.url, method: incoming.method,
      headers: {...incoming.headers, 'accept-encoding': 'identity'},
    }, response => {
      const contentType = response.headers['content-type'] ?? '';
      if (!/text\/(css|html)/.test(contentType)) {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
        return;
      }
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').replace(
          /\(prefers-color-scheme:\s*(dark|light)\)/g,
          (_query, scheme: string) => scheme === theme ? '(min-width: 0px)' : '(min-width: 999999px)',
        );
        const headers = {...response.headers};
        delete headers['content-length'];
        delete headers['content-encoding'];
        delete headers.etag;
        headers['cache-control'] = 'no-store';
        outgoing.writeHead(response.statusCode ?? 502, headers);
        outgoing.end(body);
      });
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end('Preview app unavailable');
    });
    incoming.pipe(upstream);
  }).listen(port, '127.0.0.1', () => {
    console.log(`${theme} preview: http://localhost:${port}/en/r/${publicId}#access=${token}`);
  });
}
