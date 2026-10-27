// Acceptance-only correlation for the fixed new-origin T1 chain.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const traceHeader = 'x-silverhand-acceptance-trace';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const tracedHeaders = (headers, trace) => trace ? { ...headers, [traceHeader]: trace.id } : headers;

export class T1TlsEvidence {
  constructor(file, { attempt } = {}) {
    assert(!existsSync(file), 'TLS evidence output occupied');
    this.file = file; this.attempt = attempt;
    this.requests = 0;
    this.bytes = 0;
  }
  begin(req) {
    if (req.method !== 'GET' || req.url !== '/api/me') return null;
    assert(++this.requests <= 64, 'TLS evidence request bound');
    const socket = req.socket;
    return { id: randomUUID(), ...(this.attempt ? { attempt: this.attempt } : {}), startedAt: Date.now(), method: 'GET', pathname: '/api/me',
      host: req.headers.host, tls: { encrypted: socket.encrypted === true,
        protocol: socket.getProtocol?.() ?? null,
        localAddress: socket.localAddress, localPort: socket.localPort,
        remoteAddress: socket.remoteAddress, remotePort: socket.remotePort,
        serverCertificateSha256: socket.getCertificate?.().raw ? hash(socket.getCertificate().raw) : null } };
  }
  publish(context, status, body, fixtureUsers) {
    if (!context || status !== 200) return;
    assert(body.length <= 65536, 'TLS me body bound');
    const user = JSON.parse(body).id;
    // Before PRE declares its fixture, the ordinary login remains transparent.
    if (!fixtureUsers.includes(user)) return;
    const row = { event: 'fixture_me_tls_response', ...context, endedAt: Date.now(),
      fixtureUserId: user, upstream: { host: '127.0.0.1', port: 18480, status },
      bodyBytes: body.length, bodySha256: hash(body) };
    const line = JSON.stringify(row) + '\n';
    assert(this.bytes + Buffer.byteLength(line) <= 131072, 'TLS evidence byte bound');
    appendFileSync(this.file, line, { mode: 0o600 });
    this.bytes += Buffer.byteLength(line);
  }
}

// Absence is pending; malformed/mismatched evidence is an immediate rejection.
export function nativeTlsMatch(native, expected, file) {
  assert.equal(native.serverUrl, 'https://localhost:29443', 'Native target origin differs');
  assert.equal(native.info?.status, 200, 'Native server-info failed');
  assert.equal(native.me?.status, 200, 'Native me failed');
  assert.equal(JSON.parse(native.me.bodyText).id, expected.userId, 'Native fixture differs');
  const header = Object.entries(native.me.headers ?? {}).filter(([key]) => key.toLowerCase() === traceHeader);
  assert(header.length === 1 && typeof header[0][1] === 'string' &&
    /^[0-9a-f-]{36}$/.test(header[0][1]), 'Native response trace missing or ambiguous');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  assert(Buffer.byteLength(text) <= 131072 && text.endsWith('\n'), 'TLS evidence bytes/incomplete line');
  const rows = text.trimEnd().split('\n').map(JSON.parse);
  assert(rows.length <= 64, 'TLS evidence row bound');
  const matches = rows.filter(row => row.id === header[0][1]);
  if (!matches.length) return null;
  assert.equal(matches.length, 1, 'TLS trace repeated');
  const row = matches[0];
  if (expected.attempt !== undefined) assert.equal(row.attempt, expected.attempt, 'TLS attempt differs');
  assert(row.event === 'fixture_me_tls_response' && row.method === 'GET' && row.pathname === '/api/me' &&
    row.host === 'localhost:29443' && row.fixtureUserId === expected.userId &&
    row.upstream?.host === '127.0.0.1' && row.upstream.port === 18480 && row.upstream.status === 200,
    'TLS response source differs');
  assert(row.tls?.encrypted === true && /^TLSv1\.[23]$/.test(row.tls.protocol) &&
    row.tls.localPort === 29443 && row.tls.serverCertificateSha256 === expected.serverCertificateSha256,
    'TLS connection metadata differs');
  assert.equal(row.bodySha256, hash(Buffer.from(native.me.bodyText)), 'Native response body differs');
  assert.equal(row.bodyBytes, Buffer.byteLength(native.me.bodyText), 'Native response size differs');
  return { status: 'passed', nativeServerUrl: native.serverUrl, infoStatus: native.info.status,
    meStatus: native.me.status, fixtureUserId: expected.userId, nativeTraceId: header[0][1],
    nativeBodySha256: hash(Buffer.from(native.me.bodyText)), nativeBodyBytes: Buffer.byteLength(native.me.bodyText), response: row,
    boundary: 'Correlated current native response and TLS proxy observation;client verification path is separately sourced;no TLS negative or trust-env sample' };
}
