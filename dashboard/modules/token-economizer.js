/**
 * Small client around the TokenEconomizer plugin's status and microskills tools.
 * The caller supplies invoke(toolName, body). It never throws and never computes
 * a "tokens saved" figure.
 */
export function createTokenEconomizer({ invoke, isEnabled }) {
  async function call(tool, body) {
    const result = await invoke(tool, body);
    if (result && result.ok === false) {
      throw new Error(result.reason || result.error || `${tool} failed`);
    }
    return result;
  }

  async function getStatus() {
    if (!(typeof isEnabled === 'function' ? isEnabled() : isEnabled)) return { ok: false, reason: 'disabled' };
    try {
      return { ok: true, status: await call('status', { json: true }) };
    } catch (err) {
      return { ok: false, reason: err?.message || 'status failed' };
    }
  }

  async function getMicroskillsForInjection() {
    if (!(typeof isEnabled === 'function' ? isEnabled() : isEnabled)) return '';
    try {
      const result = await call('microskills', {});
      if (typeof result === 'string') return result.trim();
      const list = Array.isArray(result?.microskills) ? result.microskills : [];
      return list
        .map((item) => (typeof item === 'string' ? item : item?.text))
        .filter((text) => typeof text === 'string' && text.trim())
        .map((text) => `- ${text.trim()}`)
        .join('\n');
    } catch {
      return '';
    }
  }

  return { getStatus, getMicroskillsForInjection };
}
