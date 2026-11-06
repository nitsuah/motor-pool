// Pure helpers for TokenEconomizerPanel, kept free of React so node unit tests
// can import them.

const API_BASE = '/api/tokeneconomizer';

/**
 * Build a TokenEconomizer API URL. Empty/null params are dropped, and the query
 * string always starts with "?" (never a bare "&").
 */
export function teUrl(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return `${API_BASE}${path}${query ? `?${query}` : ''}`;
}

// Settings the panel edits. Keys are the flat keys GET/POST /config use, and
// bounds mirror CONFIG_SCHEMA in modules/token-economizer.js (a unit test keeps
// them in sync). Only settings the backend actually reads are listed.
export const TE_SETTINGS_SECTIONS = [
  {
    title: 'Tool Pruning Settings',
    fields: [
      { key: 'toolprune_evidence', label: 'Min Evidence (Prompts)', min: 1, max: 1000, step: 1 },
      { key: 'toolprune_min_sessions', label: 'Min Sessions', min: 1, max: 100, step: 1 },
      { key: 'toolprune_sessions', label: 'Quiet Period (Days)', min: 1, max: 365, step: 1 },
    ],
  },
  {
    title: 'Loop Guard Settings',
    fields: [
      { key: 'loopguard_nudges', label: 'Min Turns Before Nudge', min: 1, max: 1000, step: 1 },
      { key: 'loopguard_backstop_mult', label: 'Idle Minutes Before Nudge', min: 0.1, max: 1440, step: 0.1 },
      { key: 'loopguard_judge_confidence', label: 'Reported Confidence', min: 0, max: 1, step: 0.05 },
    ],
  },
];

/** Parse a settings input value; returns null when it is not a usable number. */
export function parseSettingValue(field, raw) {
  const n = field.step >= 1 ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < field.min || n > field.max) return null;
  return n;
}
