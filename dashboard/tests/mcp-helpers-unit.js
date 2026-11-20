/**
 * Unit tests for modules/mcp-helpers.js
 *
 * parseMcpRpcResponse() is pure, so it is exercised directly.
 * mcpRequest() is exercised against a real local MCP-shaped server rather than
 * a mocking library, so the JSON-RPC framing, SSE handling, and error mapping
 * are all verified end to end over HTTP.
 */
import assert from 'node:assert/strict';
import express from 'express';
import { parseMcpRpcResponse, mcpRequest, mcpAuthHeaders } from '../modules/mcp-helpers.js';

// ── parseMcpRpcResponse: plain JSON ──────────────────────────────────────────
assert.deepStrictEqual(
  parseMcpRpcResponse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'),
  { jsonrpc: '2.0', id: 1, result: { ok: true } },
  'parses a plain JSON body'
);
assert.deepStrictEqual(
  parseMcpRpcResponse({ result: { ok: true } }),
  { result: { ok: true } },
  'accepts an already-parsed object'
);
assert.strictEqual(parseMcpRpcResponse('not json'), null, 'unparseable body → null');
assert.strictEqual(parseMcpRpcResponse(''), null, 'empty string body → null');
// Quirk worth pinning: a non-string body goes through JSON.stringify first, so
// null becomes '""' and parses back to an empty string rather than null.
// mcpRequest still treats that as unusable because '' is falsy.
assert.strictEqual(parseMcpRpcResponse(null), '', 'null body stringifies to "" and parses to an empty string');
assert.strictEqual(parseMcpRpcResponse(undefined), '', 'undefined body behaves the same');
console.log('  ✅ parseMcpRpcResponse handles plain JSON, objects, and garbage');

// ── parseMcpRpcResponse: SSE framing ─────────────────────────────────────────
const sse = [
  'event: message',
  'data: {"jsonrpc":"2.0","id":1,"method":"notify"}',
  '',
  'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
  '',
].join('\n');
assert.deepStrictEqual(
  parseMcpRpcResponse(sse, 'text/event-stream'),
  { jsonrpc: '2.0', id: 2, result: { tools: [] } },
  'returns the last data: frame carrying a result'
);

// CRLF line endings are handled, and the *last* result wins.
const crlf = 'data: {"result":{"n":1}}\r\ndata: {"result":{"n":2}}\r\n';
assert.deepStrictEqual(
  parseMcpRpcResponse(crlf, 'text/event-stream').result, { n: 2 },
  'CRLF framing parsed, last result wins'
);

// An error frame counts as a terminal message too.
assert.deepStrictEqual(
  parseMcpRpcResponse('data: {"error":{"message":"nope"}}', 'text/event-stream').error,
  { message: 'nope' },
  'error frames are returned'
);

// Frames with neither result nor error are skipped; malformed frames ignored.
assert.strictEqual(
  parseMcpRpcResponse('data: {"method":"ping"}', 'text/event-stream'), null,
  'no result/error frame → null'
);
assert.strictEqual(
  parseMcpRpcResponse('data: {broken\ndata: also broken', 'text/event-stream'), null,
  'malformed frames are skipped, not thrown'
);
assert.deepStrictEqual(
  parseMcpRpcResponse('data: {broken\ndata: {"result":5}', 'text/event-stream').result, 5,
  'a good frame after a malformed one is still found'
);
console.log('  ✅ parseMcpRpcResponse handles SSE framing, CRLF, errors, and bad frames');

// ── mcpRequest against a real local server ───────────────────────────────────
const received = [];
const app = express();
app.use(express.json());
app.post('/mcp', (req, res) => {
  received.push(req.body);
  const { method } = req.body;
  if (method === 'ok') return res.json({ jsonrpc: '2.0', id: req.body.id, result: { tools: ['a'] } });
  if (method === 'sse') {
    res.set('Content-Type', 'text/event-stream');
    return res.send('data: {"jsonrpc":"2.0","result":{"via":"sse"}}\n\n');
  }
  if (method === 'rpcError') {
    return res.json({ jsonrpc: '2.0', id: req.body.id, error: { message: 'tool exploded' } });
  }
  if (method === 'rpcErrorNoMessage') {
    return res.json({ jsonrpc: '2.0', id: req.body.id, error: { code: -1 } });
  }
  if (method === 'garbage') return res.send('definitely not json');
  return res.status(500).json({ error: 'boom' });
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

try {
  const result = await mcpRequest(base, 'ok', { a: 1 });
  assert.deepStrictEqual(result, { tools: ['a'] }, 'returns the JSON-RPC result');
  assert.strictEqual(received[0].jsonrpc, '2.0', 'sends a JSON-RPC 2.0 envelope');
  assert.strictEqual(received[0].method, 'ok', 'sends the method');
  assert.deepStrictEqual(received[0].params, { a: 1 }, 'sends params');
  assert.ok(received[0].id, 'sends a request id');

  assert.deepStrictEqual(await mcpRequest(base, 'sse'), { via: 'sse' }, 'unwraps an SSE-framed result');

  await assert.rejects(
    () => mcpRequest(base, 'rpcError'),
    /tool exploded/,
    'a JSON-RPC error becomes a thrown Error with its message'
  );
  await assert.rejects(
    () => mcpRequest(base, 'rpcErrorNoMessage'),
    /MCP error for rpcErrorNoMessage/,
    'an error without a message falls back to a generic message naming the method'
  );
  await assert.rejects(
    () => mcpRequest(base, 'garbage'),
    /unparseable MCP response for garbage/,
    'an unparseable body is reported as such'
  );
  await assert.rejects(
    () => mcpRequest(base, 'boom'),
    /responded 500 for boom/,
    'an HTTP error status is reported with the status and method'
  );
  console.log('  ✅ mcpRequest: envelope, SSE unwrap, RPC errors, bad body, HTTP errors');

  // params defaults to {} when omitted.
  received.length = 0;
  await mcpRequest(base, 'ok');
  assert.deepStrictEqual(received[0].params, {}, 'params defaults to an empty object');
  console.log('  ✅ mcpRequest defaults params to {}');
} finally {
  server.close();
}

console.log('MCP helper tests passed.');

// mcpAuthHeaders: the token goes only to the bundled tool servers.
assert.deepStrictEqual(mcpAuthHeaders('http://tool-website:3201', { MCP_AUTH_TOKEN: 'tok-123' }), { Authorization: 'Bearer tok-123' });
assert.deepStrictEqual(mcpAuthHeaders('https://third-party.example/x', { MCP_AUTH_TOKEN: 'tok-123' }), {});
assert.deepStrictEqual(mcpAuthHeaders('http://tool-website:3201', {}), {});
