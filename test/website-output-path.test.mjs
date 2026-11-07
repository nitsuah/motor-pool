import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { resolve, join } from 'node:path';
import { makeSafeOutputPath, SLUG_PATTERN } from '../tools/website/output-path.js';

describe('safeOutputPath', () => {
  const base = resolve('/tmp/site-output');
  const safe = makeSafeOutputPath(base);

  it('resolves normal client paths inside the output dir', () => {
    assert.equal(safe('acme-90210', 'site', 'index.html'), join(base, 'acme-90210', 'site', 'index.html'));
    assert.equal(safe('acme-90210'), join(base, 'acme-90210'));
  });

  it('refuses a sibling directory that shares the base prefix', () => {
    assert.throws(() => safe('..', 'site-output-evil', 'x.txt'));
  });

  it('refuses traversal out of the client folder and the base itself', () => {
    assert.throws(() => safe('acme', '..', '..', 'x'));
    assert.throws(() => safe('acme', '..', '..'));
    assert.throws(() => safe('.'));
  });
});

describe('SLUG_PATTERN', () => {
  it('accepts generated slugs and rejects path-like ones', () => {
    assert.ok(SLUG_PATTERN.test('acme-pizza-90210'));
    for (const bad of ['', '..', '../x', 'a/b', 'A-b', '-a', 'a_b', 'a b', 'a\b']) {
      assert.ok(!SLUG_PATTERN.test(bad), bad);
    }
  });
});
