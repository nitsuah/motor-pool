import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { resolve, join } from 'node:path';
import { makeSafeOutputPath, leadsFileName, SLUG_PATTERN } from '../tools/website/output-path.js';

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
    for (const bad of ['', '..', '../x', 'a/b', 'A-b', '-a', 'a_b', 'a b', 'a\\b']) {
      assert.ok(!SLUG_PATTERN.test(bad), bad);
    }
  });
});

describe('leadsFileName', () => {
  it('builds the expected name for plain inputs', () => {
    assert.equal(leadsFileName('90210', 'Restaurants', '2026-01-02'), 'leads-90210-restaurants-2026-01-02.json');
    assert.equal(leadsFileName('90210', 'auto body', '20260102'), 'leads-90210-auto body-20260102.json');
  });

  it('rejects path-like or malformed parts', () => {
    assert.equal(leadsFileName('90210', 'restaurants', '../../secrets'), null);
    assert.equal(leadsFileName('90210', 'restaurants', '2026-0102'), null);
    assert.equal(leadsFileName('90210', 'bars,french', '20260102'), 'leads-90210-bars,french-20260102.json');
    assert.equal(leadsFileName('90210', 'restaurants', '2026-01-02/../../x'), null);
    assert.equal(leadsFileName('90210', 'restaurants', '2026-01-02.json'), null);
    assert.equal(leadsFileName('../x', 'restaurants', '2026-01-02'), null);
    assert.equal(leadsFileName('90210', '../x', '2026-01-02'), null);
    assert.equal(leadsFileName('90210', 'a/b', '2026-01-02'), null);
  });
});
