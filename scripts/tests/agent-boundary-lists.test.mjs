// docs/agent-boundaries.md "Files that bound agents" is the full list of files
// whose change relaxes the agent boundary. Two shorter copies of it had each
// lost entries with every check green: the Tier 1 row of the "By tier" table
// left out `.github/workflows/`, a Tier 1 path in risk-config.json, and
// docs/security/SECURITY-AI.md section 5 left out `.github/workflows/` and
// `scripts/check-policies.mjs`, which .github/CODEOWNERS names for the
// owner's review. These tests hold each copy to the full list and to the file
// that decides it, so a file added to one has to be added to the others in
// the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const BOUNDARIES = 'docs/agent-boundaries.md';
const SECURITY = 'docs/security/SECURITY-AI.md';
const CODEOWNERS = '.github/CODEOWNERS';
const config = JSON.parse(read('risk-config.json'));

const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

function section(page, heading) {
    const lines = read(page).split('\n');
    const start = lines.indexOf(heading);
    assert.notEqual(
        start,
        -1,
        `${page} has no ${JSON.stringify(heading)} heading`
    );
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// The text inside the parentheses that follow `phrase`, newlines folded.
function parenthetical(text, phrase) {
    const flat = text.replace(/\s*\n\s*/g, ' ');
    const at = flat.indexOf(`${phrase} (`);
    assert.notEqual(at, -1, `no "${phrase} (" in the section`);
    const open = at + phrase.length + 1;
    return flat.slice(open + 1, flat.indexOf(')', open));
}

// The full list, as the page writes it.
function boundingFiles() {
    const body = section(BOUNDARIES, '## Files that bound agents');
    const bullets = body.split('\n\n').find((block) => block.startsWith('- '));
    assert.ok(bullets, 'no bullet list in the section');
    return [...new Set(codeSpans(bullets))].sort();
}

// Tier 1 paths as the pages write them: a directory glob is its directory.
const tier1 = config.tiers
    .find((t) => t.tier === 1)
    .paths.map((p) => p.replace(/\/\*\*$/, '/'));

// The paths CODEOWNERS names one by one rather than through `*`, without the
// leading slash that anchors them to the repository root.
function namedForOwner() {
    return read(CODEOWNERS)
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[0])
        .filter((p) => p && !p.startsWith('#') && p !== '*')
        .map((p) => p.replace(/^\//, ''));
}

test(`every file ${BOUNDARIES} says bounds agents exists`, () => {
    assert.deepEqual(
        boundingFiles().filter((p) => !fs.existsSync(path.join(repoRoot, p))),
        []
    );
});

test(`${BOUNDARIES} Tier 1 row names every Tier 1 file that bounds agents`, () => {
    const row = section(BOUNDARIES, '## By tier')
        .split('\n')
        .find((l) => l.startsWith('| 1 critical |'));
    assert.ok(row, 'no Tier 1 row in the tier table');
    assert.deepEqual(
        codeSpans(parenthetical(row, 'edit files that bound agents')).sort(),
        boundingFiles().filter((p) => tier1.includes(p))
    );
});

test(`${SECURITY} section 5 names every file that bounds agents ${CODEOWNERS} names for the owner`, () => {
    const body = section(SECURITY, '## 5. What agents must never do');
    const owned = new Set(namedForOwner());
    assert.deepEqual(
        codeSpans(
            parenthetical(body, 'relaxes any file that bounds agents')
        ).sort(),
        boundingFiles().filter((p) => owned.has(p))
    );
});
