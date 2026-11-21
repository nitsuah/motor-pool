// Mask secrets in TokenEconomizer CLI output before it leaves the HTTP wrapper
// (#168). The wrapper returns `te` stdout as-is, and whether `config show`
// prints credentials is not something the wrapper controls, so every success
// response is redacted: values of secret-named keys, and anything that looks
// like a bearer token or provider API key.

const MASK = '[REDACTED]';
const SECRET_KEY = '[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|auth|credential)[A-Za-z0-9_.-]*';

// "key": "value"  (JSON)
const JSON_PAIR = new RegExp(`("${SECRET_KEY}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi');
// key = value  /  key: value  (INI, YAML, env, CLI tables)
const PLAIN_PAIR = new RegExp(`^(\\s*${SECRET_KEY}\\s*[:=]\\s*)(?!\\s*$)(.+)$`, 'gim');
// Bearer tokens and common provider key shapes anywhere in the text.
const TOKEN_SHAPES = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g,
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

/** Return `text` with secret values masked. Non-strings are returned unchanged. */
export function redactSecrets(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = text.replace(JSON_PAIR, (_m, prefix) => `${prefix}"${MASK}"`);
    out = out.replace(PLAIN_PAIR, (_m, prefix) => `${prefix}${MASK}`);
    for (const re of TOKEN_SHAPES) out = out.replace(re, MASK);
    return out;
}

export { MASK };
