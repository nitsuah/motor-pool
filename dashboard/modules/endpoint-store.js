/**
 * Persistent encrypted store for custom LLM endpoints.
 *
 * API keys are encrypted with AES-256-GCM before writing to disk.
 * The encryption key is derived via scrypt from ENDPOINT_STORE_SECRET (env), or
 * from a random per-install secret stored beside the store (endpoints.key, 0600).
 * Endpoints without API keys are stored as-is.
 *
 * Storage: ENDPOINT_STORE_PATH env (default /data/endpoints.json)
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const STORE_PATH = process.env.ENDPOINT_STORE_PATH || '/data/endpoints.json';
// NOTE: SALT and LEGACY_SECRET are key-derivation material (scrypt input), not
// display branding — do not rename them. They are needed to read a store written
// by an older version that used the built-in default secret.
const ALGO = 'aes-256-gcm';
const SALT = Buffer.from('motor-pool-ep-v1');
// Key material of installs that never set ENDPOINT_STORE_SECRET. Kept only to
// read (and then re-encrypt) a store written by an older version.
const LEGACY_SECRET = 'motor-pool-default-secret-change-me';
const LEGACY_KEY = scryptSync(LEGACY_SECRET, SALT, 32);

// ENDPOINT_STORE_SECRET when set; otherwise a random per-install secret kept
// next to the store (mode 0600). Returns null when neither is available, in
// which case API keys are not persisted.
function resolveSecret() {
  const fromEnv = process.env.ENDPOINT_STORE_SECRET;
  if (fromEnv && fromEnv !== LEGACY_SECRET) return fromEnv;
  if (fromEnv === LEGACY_SECRET) {
    // The old built-in default is public, so it is never used as a key. Keys
    // stored under it are still read and re-encrypted with the per-install key.
    console.warn('[endpoint-store] ENDPOINT_STORE_SECRET is the old public default; ignoring it and using the per-install key file. Set a unique value or unset it.');
  }
  const keyPath = join(dirname(STORE_PATH), 'endpoints.key');
  try {
    if (existsSync(keyPath)) {
      const existing = readFileSync(keyPath, 'utf8').trim();
      if (existing.length >= 32) return existing;
    }
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const generated = randomBytes(32).toString('hex');
    writeFileSync(keyPath, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch (e) {
    console.error('[endpoint-store] No encryption secret available:', e.message);
    return null;
  }
}

const RAW_SECRET = resolveSecret();
// Derive a 32-byte key once at startup
const ENC_KEY = RAW_SECRET ? scryptSync(RAW_SECRET, SALT, 32) : null;

function encrypt(plaintext) {
  if (!ENC_KEY) throw new Error('no encryption key available');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(ciphertext, key = ENC_KEY) {
  if (!key) throw new Error('no encryption key available');
  const parts = ciphertext.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unrecognised ciphertext format');
  const [, ivHex, tagHex, dataHex] = parts;
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(dataHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

export function loadEndpoints() {
  if (!existsSync(STORE_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    if (!Array.isArray(raw)) return [];
    let migrated = false;
    const loaded = raw.map(ep => {
      if (ep._encryptedApiKey) {
        try {
          return { ...ep, apiKey: decrypt(ep._encryptedApiKey), _encryptedApiKey: undefined };
        } catch (e) {
          try {
            const apiKey = decrypt(ep._encryptedApiKey, LEGACY_KEY);
            migrated = true;
            return { ...ep, apiKey, _encryptedApiKey: undefined };
          } catch (legacyErr) {
            console.error(`[endpoint-store] Failed to decrypt apiKey for "${ep.key}":`, e.message, `(legacy key: ${legacyErr.message})`);
            return { ...ep, apiKey: '', _encryptedApiKey: undefined };
          }
        }
      }
      return ep;
    });
    // Re-encrypt anything that was readable only with the old built-in key.
    if (migrated && ENC_KEY) saveEndpoints(loaded);
    return loaded;
  } catch (e) {
    console.error('[endpoint-store] Failed to load endpoints:', e.message);
    return [];
  }
}

export function saveEndpoints(endpoints) {
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const serializable = endpoints.map(ep => {
      const { apiKey, ...rest } = ep;
      if (apiKey) {
        // Never write a key in the clear: without an encryption key it is dropped.
        return ENC_KEY ? { ...rest, _encryptedApiKey: encrypt(apiKey) } : rest;
      }
      return rest;
    });
    writeFileSync(STORE_PATH, JSON.stringify(serializable, null, 2), 'utf8');
  } catch (e) {
    console.error('[endpoint-store] Failed to save endpoints:', e.message);
  }
}
