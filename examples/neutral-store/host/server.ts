import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfig } from '../shared/config.ts';
import { isOperation, operations } from '../shared/api.ts';
import { isRecord } from '../shared/offer.ts';
import { selectConfiguration } from '../owned/store.config.ts';
import { dispatchAction, pendingBindings, type ApplicationBindings } from './bindings.ts';

const staticRoot = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const config = selectConfiguration(process.env.STORE_CONFIGURATION || undefined);
assertConfig(config);
const configuredPort = Number(process.env.PORT ?? 4319);
if (!Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535) {
  throw new Error('starter_port_invalid');
}

// Container transport may listen on its bridge; Compose publishes to host loopback only.
const host = process.env.STARTER_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1';
const allowedAuthorities = new Set([`127.0.0.1:${configuredPort}`, `localhost:${configuredPort}`]);
const maxBodyBytes = 64 * 1024;
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

export function createApplication(bindings: ApplicationBindings = pendingBindings()) {
  return createServer((request, response) => {
    void handle(request, response, bindings).catch(() => {
      if (!response.headersSent) sendJson(response, 503, { ok: false, code: 'starter_dependency_unavailable' });
      else response.end();
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, bindings: ApplicationBindings): Promise<void> {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (!allowedAuthorities.has(request.headers.host ?? '')) {
    sendJson(response, 403, { ok: false, code: 'starter_local_host_required' });
    return;
  }
  const origin = `http://${request.headers.host}`;
  const url = new URL(request.url ?? '/', origin);
  if (url.origin !== origin) { sendJson(response, 400, { ok: false, code: 'starter_request_invalid' }); return; }
  if (url.pathname === '/api/config' && request.method === 'GET') {
    sendJson(response, 200, { config, artifact: { kind: 'local-candidate', setVersion: null, verified: false } });
    return;
  }
  if (url.pathname.startsWith('/api/actions/')) {
    if (request.method !== 'POST') { sendJson(response, 405, { ok: false, code: 'method_not_allowed' }); return; }
    if (request.headers.origin !== origin || request.headers['x-starter-request'] !== '1'
      || request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
      sendJson(response, 403, { ok: false, code: 'starter_same_origin_required' }); return;
    }
    const operation = url.pathname.slice('/api/actions/'.length);
    if (!isOperation(operation)) { sendJson(response, 404, { ok: false, code: 'starter_operation_unknown' }); return; }
    const commandKey = request.headers['idempotency-key'];
    if (typeof commandKey !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(commandKey)) {
      sendJson(response, 400, { ok: false, code: 'starter_command_identity_required' }); return;
    }
    const input = await body(request);
    if (!isRecord(input)) { sendJson(response, 400, { ok: false, code: 'starter_input_invalid' }); return; }
    if (operation === 'application.status') {
      sendJson(response, 200, { ok: true, value: {
        artifact: 'local-candidate', installation: 'unknown', risk: 'off',
        bindings: operations.map(name => ({ operation: name, declared: true,
          bound: name === 'offer.validate' || name === 'application.status' || Boolean(bindings.actions[name]), checked: false })),
      } });
      return;
    }
    const actor = await bindings.authenticate(request);
    const result = await dispatchAction(bindings, operation, input, { actor, commandKey, config });
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }
  if (url.pathname.startsWith('/api/')) { sendJson(response, 404, { ok: false, code: 'starter_route_unknown' }); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { ok: false, code: 'method_not_allowed' }); return;
  }
  let path: string;
  try { path = decodeURIComponent(url.pathname); }
  catch { sendJson(response, 400, { ok: false, code: 'starter_path_invalid' }); return; }
  const candidate = resolve(staticRoot, `.${path}`);
  if (!candidate.startsWith(staticRoot + sep) && candidate !== resolve(staticRoot)) {
    sendJson(response, 403, { ok: false, code: 'starter_path_invalid' }); return;
  }
  const extension = extname(candidate);
  const target = extension ? candidate : resolve(staticRoot, 'index.html');
  try {
    const bytes = await readFile(target);
    response.setHeader('Content-Type', contentTypes[extname(target)] ?? 'application/octet-stream');
    response.statusCode = 200;
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    sendJson(response, 404, { ok: false, code: 'starter_asset_unavailable' });
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBodyBytes) throw new Error('starter_request_too_large');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return null; }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bindings = pendingBindings();
  const server = createApplication(bindings);
  server.requestTimeout = 25000;
  server.headersTimeout = 10000;
  server.listen(configuredPort, host, () => {
    process.stdout.write(`Neutral store local candidate: http://127.0.0.1:${configuredPort}\n`);
  });
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    server.close(() => { void bindings.close().finally(() => { process.exitCode = 0; }); });
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
