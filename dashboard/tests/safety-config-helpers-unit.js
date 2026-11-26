/**
 * Unit tests for the experience / safety-mode lookup helpers in safety.js.
 */
import assert from 'node:assert/strict';
import {
  EXPERIENCE_CONFIGS,
  SAFETY_CONFIGS,
  SAFETY_RANK,
  isKnownExperience,
  isKnownSafetyMode,
  getPublicExperienceConfigs,
  normalizeForMatching,
  outputFiltersActive,
} from '../safety.js';

// ── isKnownExperience ─────────────────────────────────────────────────────────
for (const name of ['developer', 'research', 'safechat', 'content_gen', 'website']) {
  assert.equal(isKnownExperience(name), true, `${name} is a known experience`);
}
for (const name of ['', undefined, 'unknown', '__proto__', 'constructor', 'toString']) {
  assert.equal(isKnownExperience(name), false, `${JSON.stringify(name)} is not a known experience`);
}

// ── isKnownSafetyMode ─────────────────────────────────────────────────────────
for (const mode of ['strict', 'standard', 'research']) {
  assert.equal(isKnownSafetyMode(mode), true, `${mode} is a known safety mode`);
}
for (const mode of ['', undefined, 'loose', '__proto__', 'constructor']) {
  assert.equal(isKnownSafetyMode(mode), false, `${JSON.stringify(mode)} is not a known safety mode`);
}

// ── SAFETY_RANK ───────────────────────────────────────────────────────────────
assert.deepEqual(SAFETY_RANK, { research: 0, standard: 1, strict: 2 }, 'safety rank order');
assert.deepEqual(Object.keys(SAFETY_RANK).sort(), Object.keys(SAFETY_CONFIGS).sort(), 'rank covers every safety mode');

// ── getPublicExperienceConfigs ────────────────────────────────────────────────
assert.equal(getPublicExperienceConfigs(), EXPERIENCE_CONFIGS, 'default returns every experience');
assert.equal(getPublicExperienceConfigs(false), EXPERIENCE_CONFIGS, 'false returns every experience');
{
  const pub = getPublicExperienceConfigs(true);
  assert.deepEqual(Object.keys(pub), ['safechat'], 'public demo mode exposes only safechat');
  assert.equal(pub.safechat, EXPERIENCE_CONFIGS.safechat, 'safechat entry is the same object');
}

// ── normalizeForMatching ──────────────────────────────────────────────────────
assert.equal(normalizeForMatching('HeLLo'), 'hello', 'lower-cases');
assert.equal(normalizeForMatching('a​b‌c‍d﻿e'), 'abcde', 'strips zero-width characters');
assert.equal(normalizeForMatching('a  b\n\tc\r\n d'), 'a b c d', 'collapses whitespace runs to one space');
assert.equal(normalizeForMatching('  A  '), ' a ', 'ends are collapsed but not trimmed');

// ── outputFiltersActive ───────────────────────────────────────────────────────
for (const mode of ['strict', 'standard', 'research']) {
  const cfg = SAFETY_CONFIGS[mode];
  const expected = Boolean(cfg.piiDetection || (cfg.outputHarmKeywords || []).length);
  assert.equal(outputFiltersActive(mode), expected, `${mode} matches its config`);
}
assert.equal(outputFiltersActive('strict'), true, 'strict has output filters active');
assert.equal(outputFiltersActive(), outputFiltersActive('standard'), 'default is standard');
assert.equal(outputFiltersActive('bogus'), outputFiltersActive('standard'), 'unknown mode behaves like standard');

// ── experience configs reference valid data ───────────────────────────────────
for (const [name, cfg] of Object.entries(EXPERIENCE_CONFIGS)) {
  assert.equal(isKnownSafetyMode(cfg.safetyMode), true, `${name} safetyMode is a known mode`);
  assert.ok(Array.isArray(cfg.availableEndpoints) && cfg.availableEndpoints.length > 0, `${name} has endpoints`);
  assert.equal(new Set(cfg.availableEndpoints).size, cfg.availableEndpoints.length, `${name} endpoints are unique`);
}

console.log('safety-config-helpers-unit: all assertions passed');
