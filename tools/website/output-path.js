import { resolve, sep } from 'path';

// Slugs look like "acme-pizza-90210": lowercase letters, digits and hyphens.
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

// Build a resolver that keeps every path strictly inside outputDir.
export function makeSafeOutputPath(outputDir) {
  const base = resolve(outputDir);
  return function safeOutputPath(slug, ...parts) {
    const p = resolve(base, slug, ...parts);
    if (p === base) throw new Error('Path outside output directory blocked');
    if (!p.startsWith(base + sep)) {
      throw new Error(`Path outside output directory blocked: ${p}`);
    }
    return p;
  };
}
