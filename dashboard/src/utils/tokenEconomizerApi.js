/**
 * Read-only TokenEconomizer status through the dashboard plugin invoke route.
 * Never throws and never computes a savings figure.
 */
const STATUS_URL = '/api/plugins/tokeneconomizer/tools/status/invoke';

export async function getStatus(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(STATUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: { json: true } }),
    });
    if (res.status === 409) return { ok: false, reason: 'disabled' };
    if (res.status === 404) return { ok: false, reason: 'not installed' };
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) return { ok: false, reason: 'unreachable' };

    // data.result is the wrapper: { success: true, command: "status", output: "..." }
    // Parse the output JSON if it's valid; otherwise fall back to raw string.
    let parsed = data.result;
    if (data.result?.output && typeof data.result.output === 'string') {
      try {
        parsed = JSON.parse(data.result.output);
      } catch {
        parsed = data.result.output; // fallback to raw string
      }
    }
    return { ok: true, status: parsed ?? null };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/** Short lines for the panel: only top-level scalar fields the backend reported. */
export function summarizeStatus(status, limit = 6) {
  if (typeof status === 'string') return status.trim() ? [status.trim().slice(0, 200)] : [];
  if (!status || typeof status !== 'object') return [];
  return Object.entries(status)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, limit)
    .map(([key, value]) => `${key}: ${String(value).slice(0, 120)}`);
}