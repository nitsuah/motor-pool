import axios from 'axios';
import { randomUUID } from 'crypto';

// Streamable HTTP MCP responses arrive either as plain JSON or as an SSE
// stream with the JSON-RPC payload in `data:` lines. Returns the parsed
// JSON-RPC message carrying a result/error, or null if unparseable.
export function parseMcpRpcResponse(rawBody, contentType = '') {
  const body = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody ?? '');
  if (String(contentType).includes('text/event-stream')) {
    const messages = body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((chunk) => {
        try { return JSON.parse(chunk); } catch { return null; }
      })
      .filter(Boolean);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].result !== undefined || messages[i].error !== undefined) {
        return messages[i];
      }
    }
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// The shared MCP token is only sent to the bundled tool servers (never to
// third-party servers); MCP_AUTH_HOSTS (comma-separated) overrides the host list.
export function mcpAuthHeaders(baseUrl, env = process.env) {
  const token = String(env.MCP_AUTH_TOKEN ?? '');
  if (!token) return {};
  const hosts = String(env.MCP_AUTH_HOSTS ?? 'tool-content-gen,tool-website,localhost,127.0.0.1')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  let host;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return {}; }
  return hosts.includes(host) ? { Authorization: `Bearer ${token}` } : {};
}

export async function mcpRequest(baseUrl, method, params = {}, timeoutMs = 15000) {
  const response = await axios.post(
    `${baseUrl}/mcp`,
    { jsonrpc: '2.0', id: randomUUID(), method, params },
    {
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...mcpAuthHeaders(baseUrl) },
      responseType: 'text',
      transformResponse: [(data) => data],
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    throw new Error(`tool server responded ${response.status} for ${method}`);
  }
  const rpc = parseMcpRpcResponse(response.data, response.headers?.['content-type']);
  if (!rpc) {
    throw new Error(`tool server returned an unparseable MCP response for ${method}`);
  }
  if (rpc.error) {
    throw new Error(rpc.error.message || `MCP error for ${method}`);
  }
  return rpc.result;
}
