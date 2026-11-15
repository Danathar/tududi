// .github/workflows/nightly-compliance.yml counts a failing `npm audit
// --omit=dev` against the nightly only when nightly.audit_blocking is true;
// otherwise a high or critical advisory in a production dependency opens no
// tracking issue. Dependabot alerts are off on this repository, so that run is
// the only notice of one. This pins the setting so it is not switched back to
// report-only without a test change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TUNING = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.github',
    'auto-qa-tuning.json'
);

const { nightly } = JSON.parse(readFileSync(TUNING, 'utf8'));

test('the nightly npm audit fails the run instead of only reporting', () => {
    assert.equal(nightly.audit_blocking, true);
});

test('the nightly npm audit fails on high and critical advisories', () => {
    assert.ok(
        ['low', 'moderate', 'high'].includes(nightly.audit_level),
        `audit_level ${nightly.audit_level} would let a high advisory pass`
    );
});
