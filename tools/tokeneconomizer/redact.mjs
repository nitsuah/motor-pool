// Mask secrets in TokenEconomizer CLI output before it leaves the HTTP wrapper
// (#168). The wrapper returns `te` stdout, and whether a command prints
// credentials is outside its control, so every success response is redacted:
// - whole-JSON output: every value (any type) under a secret-named key
// - key = value / key: value lines, including YAML block scalars (| and >)
// - JSON pairs embedded in text (string, number, boolean, null values)
// - credentials in URL userinfo (scheme://user:pass@host)
// - bearer tokens and common provider key shapes anywhere
// Token *counters* (max_tokens, tokens_saved, ...) are measurements, not secrets.

const MASK = '[REDACTED]';

const SECRET_WORD = /(key|secret|passw(?:or)?d|credential|auth|token|cookie|session)/i;
// Counters: max_tokens, input_tokens, tokens_saved, token_count... but NOT
// auth_token / access_token / refresh_token, which are credentials.
const COUNTER = /^(?:max|input|output|prompt|completion|total|cached)[_.-]?tokens?$|^tokens?[_.-]?(?:saved|used|count|counts|in|out|total|limit|budget)$/i;

/** True for a key whose value should never be shown. */
export function isSecretKey(key) {
    const k = String(key);
    return SECRET_WORD.test(k) && !COUNTER.test(k);
}

function maskDeep(value) {
    if (Array.isArray(value)) return value.map(maskDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = isSecretKey(k) ? MASK : maskDeep(v);
        return out;
    }
    // Strings under ordinary keys can still carry a bearer token or URL credentials.
    return typeof value === 'string' ? maskInline(value) : value;
}

const KEY_CHARS = '[A-Za-z0-9_.-]+';
// "key": <string | number | true | false | null>
const JSON_PAIR = new RegExp(`"(${KEY_CHARS})"(\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d[\\d.eE+-]*|true|false|null)`, 'g');
// key = value / key: value at line start (INI, YAML, env, CLI tables)
// The optional "- " prefix covers YAML sequence items (`  - api_key: x`).
const PLAIN_PAIR = /^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(\s*[:=]\s*)(.*)$/;
// Block scalar header, optionally followed by a comment (`| # note`).
const YAML_BLOCK = /^[|>][+-]?\d*\s*(?:#.*)?$/;
// Userinfo never crosses "/", "?" or "#", so a query like ?next=a:b@host is left alone.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]+:[^\s/?#@]+@/gi;
const TOKEN_SHAPES = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

function redactLines(text) {
    const lines = text.split(/(\r?\n)/); // keep separators at odd indexes
    let blockIndent = -1; // >= 0 while inside a secret YAML block scalar
    for (let i = 0; i < lines.length; i += 2) {
        const line = lines[i];
        const indent = line.length - line.trimStart().length;
        if (blockIndent >= 0) {
            if (line.trim() === '' || indent > blockIndent) {
                if (line.trim() !== '') lines[i] = `${line.slice(0, indent)}${MASK}`;
                continue;
            }
            blockIndent = -1;
        }
        const m = PLAIN_PAIR.exec(line);
        if (!m || !isSecretKey(m[2]) || m[4].trim() === '') continue;
        if (YAML_BLOCK.test(m[4].trim())) {
            blockIndent = m[1].length; // mask the indented lines that follow
            continue;
        }
        lines[i] = `${m[1]}${m[2]}${m[3]}${MASK}`;
    }
    return lines.join('');
}

/** Return `text` with secret values masked. Non-strings are returned unchanged. */
export function redactSecrets(text) {
    if (typeof text !== 'string' || !text) return text;
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            const parsed = JSON.parse(trimmed);
            return JSON.stringify(maskDeep(parsed), null, trimmed.includes('\n') ? 2 : 0);
        } catch { /* not JSON after all: fall through to text rules */ }
    }
    let out = text.replace(JSON_PAIR, (whole, key, sep) => (isSecretKey(key) ? `"${key}"${sep}"${MASK}"` : whole));
    out = redactLines(out);
    return maskInline(out);
}

/** Rules that apply anywhere in a string: URL credentials and token shapes. */
function maskInline(text) {
    let out = text.replace(URL_USERINFO, `$1${MASK}@`);
    for (const re of TOKEN_SHAPES) out = out.replace(re, MASK);
    return out;
}

export { MASK };
