import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'version-plan.js'
);

// version-plan.js reads the tags of its working directory when it loads, so
// each case builds a throwaway repository carrying exactly the given tags and
// parses the KEY='value' lines the script prints for create-version.sh.
function plan(tags) {
    const dir = mkdtempSync(path.join(tmpdir(), 'version-plan-'));
    const git = (...args) =>
        execFileSync(
            'git',
            [
                '-c',
                'user.name=test',
                '-c',
                'user.email=test@example.com',
                '-c',
                'commit.gpgsign=false',
                '-c',
                'tag.gpgsign=false',
                ...args,
            ],
            { cwd: dir, stdio: 'pipe' }
        );
    try {
        git('init', '-q');
        git('commit', '-q', '--allow-empty', '-m', 'init');
        for (const tag of tags) git('tag', tag);
        const stdout = execFileSync(process.execPath, [SCRIPT], {
            cwd: dir,
            encoding: 'utf8',
        });
        const result = {};
        for (const line of stdout.split('\n').filter(Boolean)) {
            const m = /^([A-Z_]+)='(.*)'$/.exec(line);
            assert.ok(m, `unexpected output line: ${line}`);
            result[m[1]] = m[2];
        }
        return result;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const KEYS = [
    'LATEST_STABLE',
    'LATEST_RC',
    'LATEST_DEV',
    'PROMOTE_STABLE',
    'NEXT_RC',
    'NEXT_DEV',
    'STABLE_FIX',
    'RC_FIX',
    'DEV_FIX',
    'STABLE_MINOR',
    'RC_MINOR',
    'DEV_MINOR',
    'STABLE_MAJOR',
    'RC_MAJOR',
    'DEV_MAJOR',
];

test('prints exactly the keys create-version.sh reads', () => {
    assert.deepEqual(Object.keys(plan([])).sort(), [...KEYS].sort());
});

test('with no tags the first versions are 0.1.0 and 1.0.0', () => {
    assert.deepEqual(plan([]), {
        LATEST_STABLE: '',
        LATEST_RC: '',
        LATEST_DEV: '',
        PROMOTE_STABLE: '',
        NEXT_RC: 'v0.1.0-rc.1',
        NEXT_DEV: 'v0.1.0-dev.1',
        STABLE_FIX: 'v0.1.0',
        RC_FIX: 'v0.1.0-rc.1',
        DEV_FIX: 'v0.1.0-dev.1',
        STABLE_MINOR: 'v0.1.0',
        RC_MINOR: 'v0.1.0-rc.1',
        DEV_MINOR: 'v0.1.0-dev.1',
        STABLE_MAJOR: 'v1.0.0',
        RC_MAJOR: 'v1.0.0-rc.1',
        DEV_MAJOR: 'v1.0.0-dev.1',
    });
});

test('stable releases compare numerically and drive the fix/minor/major bumps', () => {
    const p = plan(['v1.9.0', 'v1.10.0', 'v1.2.0']);
    assert.equal(p.LATEST_STABLE, 'v1.10.0');
    assert.equal(p.PROMOTE_STABLE, '');
    assert.equal(p.STABLE_FIX, 'v1.10.1');
    assert.equal(p.STABLE_MINOR, 'v1.11.0');
    assert.equal(p.STABLE_MAJOR, 'v2.0.0');
    assert.equal(p.NEXT_RC, 'v1.10.1-rc.1');
    assert.equal(p.NEXT_DEV, 'v1.10.1-dev.1');
    assert.equal(p.RC_MAJOR, 'v2.0.0-rc.1');
    assert.equal(p.DEV_MINOR, 'v1.11.0-dev.1');
});

test('rc.10 sorts above rc.9 and the next rc continues from it', () => {
    const p = plan(['v1.5.0', 'v1.6.0-rc.9', 'v1.6.0-rc.10', 'v1.6.0-rc.2']);
    assert.equal(p.LATEST_RC, 'v1.6.0-rc.10');
    assert.equal(p.NEXT_RC, 'v1.6.0-rc.11');
    assert.equal(p.PROMOTE_STABLE, 'v1.6.0');
});

test('a higher minor outranks a lower one with more digits (1.10.0 over 1.9.0)', () => {
    const p = plan(['v1.9.0', 'v1.10.0-rc.1']);
    assert.equal(p.LATEST_STABLE, 'v1.9.0');
    assert.equal(p.PROMOTE_STABLE, 'v1.10.0');
    assert.equal(p.NEXT_RC, 'v1.10.0-rc.2');
});

test('a fresh dev channel joins the version already in RC', () => {
    const p = plan(['v1.4.0', 'v1.5.0-rc.1']);
    assert.equal(p.PROMOTE_STABLE, 'v1.5.0');
    assert.equal(p.NEXT_RC, 'v1.5.0-rc.2');
    assert.equal(p.NEXT_DEV, 'v1.5.0-dev.1');
});

test('a dev line already ahead of stable continues its own numbering', () => {
    const p = plan(['v1.4.0', 'v1.5.0-rc.2', 'v1.5.0-dev.4']);
    assert.equal(p.LATEST_DEV, 'v1.5.0-dev.4');
    assert.equal(p.NEXT_DEV, 'v1.5.0-dev.5');
    assert.equal(p.NEXT_RC, 'v1.5.0-rc.3');
});

test('pre-releases of an already shipped version are behind it, not in flight', () => {
    const p = plan(['v1.5.0-rc.7', 'v1.5.0', 'v1.5.0-dev.3']);
    assert.equal(p.LATEST_STABLE, 'v1.5.0');
    assert.equal(p.LATEST_RC, 'v1.5.0-rc.7');
    assert.equal(p.LATEST_DEV, 'v1.5.0-dev.3');
    assert.equal(p.PROMOTE_STABLE, '');
    assert.equal(p.NEXT_RC, 'v1.5.1-rc.1');
    assert.equal(p.NEXT_DEV, 'v1.5.1-dev.1');
});

test('the highest unshipped base is promoted, whichever channel holds it', () => {
    const p = plan(['v1.4.0', 'v1.5.0-rc.3', 'v1.6.0-dev.2']);
    assert.equal(p.PROMOTE_STABLE, 'v1.6.0');
    assert.equal(p.NEXT_RC, 'v1.5.0-rc.4');
    assert.equal(p.NEXT_DEV, 'v1.6.0-dev.3');
});

test('explicit-version pre-releases number one past the highest on that exact version', () => {
    const p = plan(['v1.4.0', 'v1.5.0-rc.3', 'v1.6.0-dev.2']);
    // minor bump of 1.4.0 is 1.5.0: rc.3 exists, no dev has been cut there.
    assert.equal(p.STABLE_MINOR, 'v1.5.0');
    assert.equal(p.RC_MINOR, 'v1.5.0-rc.4');
    assert.equal(p.DEV_MINOR, 'v1.5.0-dev.1');
    // fix bump of 1.4.0 is 1.4.1: nothing cut yet on either channel.
    assert.equal(p.STABLE_FIX, 'v1.4.1');
    assert.equal(p.RC_FIX, 'v1.4.1-rc.1');
    assert.equal(p.DEV_FIX, 'v1.4.1-dev.1');
    assert.equal(p.RC_MAJOR, 'v2.0.0-rc.1');
});

test('explicit-version numbering is numeric and per channel', () => {
    const p = plan(['v1.0.0', 'v1.1.0-rc.9', 'v1.1.0-rc.10', 'v1.1.0-dev.2']);
    assert.equal(p.RC_MINOR, 'v1.1.0-rc.11');
    assert.equal(p.DEV_MINOR, 'v1.1.0-dev.3');
});

test('tags outside vX.Y.Z[-rc.N|-dev.N] are ignored', () => {
    const p = plan([
        'v1.0.0',
        'v1.2',
        'v1.2.3-beta.1',
        'v1.2.3-rc',
        'v1.2.3-rc.1-x',
        'v1.2.3+build',
        'vfoo',
    ]);
    assert.equal(p.LATEST_STABLE, 'v1.0.0');
    assert.equal(p.LATEST_RC, '');
    assert.equal(p.LATEST_DEV, '');
    assert.equal(p.PROMOTE_STABLE, '');
    assert.equal(p.NEXT_RC, 'v1.0.1-rc.1');
});
