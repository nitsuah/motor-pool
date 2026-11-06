#!/usr/bin/env node
/**
 * Test: OpenTelemetry export end to end
 *
 * Starts tracing against a local OTLP/HTTP receiver, makes an HTTP request, and
 * asserts that both a manual span (withSpan) and an auto-instrumented HTTP span
 * are exported. Guards the OpenTelemetry package family against version skew.
 */

import assert from 'assert';
import { createRequire } from 'module';
import http from 'http';

const received = [];
const collector = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    if (req.url === '/v1/traces') received.push(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'application/json');
    res.end('{}');
  });
});
await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
const collectorPort = collector.address().port;

process.env.OTEL_ENABLED = 'true';
process.env.OTEL_ENDPOINT = `http://127.0.0.1:${collectorPort}`;

const { initTracing, withSpan, shutdown, getStatus } = await import('../tracing.js');
await initTracing();
assert.strictEqual(getStatus().enabled, true, 'tracing should be enabled');

await withSpan('tracing-export.manual', { 'test.attr': 'manual' }, async () => 'ok');

// Load http after the SDK started so the auto-instrumentation can patch it.
const patchedHttp = createRequire(import.meta.url)('http');
const target = http.createServer((req, res) => res.end('pong'));
await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
await new Promise((resolve, reject) => {
  patchedHttp.get({ host: '127.0.0.1', port: target.address().port, path: '/ping' }, res => {
    res.resume();
    res.on('end', resolve);
  }).on('error', reject);
});

await shutdown();
target.close();
collector.close();

const all = received.join('\n');
assert.ok(received.length > 0, 'collector should receive at least one OTLP export');
assert.ok(all.includes('tracing-export.manual'), 'manual span should be exported');
assert.ok(/"name":"(GET|HTTP GET)[^"]*"/.test(all), 'auto-instrumented HTTP client span should be exported');
console.log('Tracing export test passed.');
