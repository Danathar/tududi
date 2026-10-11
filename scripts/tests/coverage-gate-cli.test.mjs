import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'coverage-gate.mjs'
);

// The CI gate is the script's exit status, not evaluate()'s return value:
// coverage-gate.yml fails the PR check only when the process exits non-zero.
// Each case lays out a throwaway root with a thresholds file and Jest
// json-summary files, then runs the script the way the workflow does.
const FLOOR = { lines: 88, statements: 87, functions: 87, branches: 79 };

function summary(pct) {
    return {
        total: Object.fromEntries(
            ['lines', 'statements', 'functions', 'branches'].map((m) => [
                m,
                { pct: pct[m] ?? 90 },
            ])
        ),
    };
}

function layout(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'coverage-gate-'));
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(dir, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(body));
    }
    return dir;
}

function thresholds(areas) {
    return {
        areas: Object.fromEntries(
            areas.map((a) => [
                a,
                {
                    summary: `coverage/${a}/coverage-summary.json`,
                    floor: FLOOR,
                },
            ])
        ),
    };
}

function run(args, cwd) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd,
        encoding: 'utf8',
    });
}

function withRoot(files, fn) {
    const dir = layout(files);
    try {
        return fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('exits 0 and prints the table when every area is at or above its floor', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend', 'frontend']),
            'coverage/backend/coverage-summary.json': summary({ lines: 88 }),
            'coverage/frontend/coverage-summary.json': summary({
                branches: 79,
            }),
        },
        (root) => {
            const r = run([], root);
            assert.equal(r.status, 0, r.stderr);
            assert.match(
                r.stdout,
                /\| backend \| lines \| 88\.00% \| 88% \| ok \|/
            );
            assert.match(
                r.stdout,
                /\| frontend \| branches \| 79\.00% \| 79% \| ok \|/
            );
            assert.match(r.stdout, /Coverage gate passed\./);
            assert.equal(r.stderr, '');
        }
    );
});

test('exits 1 and names the metric when one area drops below its floor', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend', 'frontend']),
            'coverage/backend/coverage-summary.json': summary({}),
            'coverage/frontend/coverage-summary.json': summary({
                functions: 86.5,
            }),
        },
        (root) => {
            const r = run([], root);
            assert.equal(r.status, 1);
            assert.match(r.stderr, /Coverage gate FAILED:/);
            assert.match(
                r.stderr,
                /- frontend\.functions: 86\.5% is below the 87% floor/
            );
            assert.doesNotMatch(r.stderr, /backend/);
            assert.doesNotMatch(r.stdout, /Coverage gate passed/);
            // The table still goes to stdout, so the workflow's tee captures it.
            assert.match(
                r.stdout,
                /\| frontend \| functions \| 86\.50% \| 87% \| BELOW FLOOR \|/
            );
        }
    );
});

test('exits 1 when a summary file is missing on disk', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend', 'frontend']),
            'coverage/backend/coverage-summary.json': summary({}),
        },
        (root) => {
            const r = run([], root);
            assert.equal(r.status, 1);
            assert.match(
                r.stderr,
                /- frontend: no coverage summary at coverage\/frontend\/coverage-summary\.json/
            );
            assert.doesNotMatch(r.stdout, /Coverage gate passed/);
        }
    );
});

test('--root resolves the config and summary paths against that directory, not the cwd', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'coverage/backend/coverage-summary.json': summary({ lines: 50 }),
        },
        (root) => {
            const elsewhere = mkdtempSync(
                path.join(tmpdir(), 'coverage-gate-cwd-')
            );
            try {
                const r = run(['--root', root], elsewhere);
                assert.equal(r.status, 1);
                assert.match(
                    r.stderr,
                    /- backend\.lines: 50% is below the 88% floor/
                );
            } finally {
                rmSync(elsewhere, { recursive: true, force: true });
            }
        }
    );
});

test('--config reads floors from the named file instead of .coverage-thresholds.json', () => {
    const strict = thresholds(['backend']);
    strict.areas.backend.floor = { ...FLOOR, lines: 95 };
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'alt/strict.json': strict,
            'coverage/backend/coverage-summary.json': summary({}),
        },
        (root) => {
            assert.equal(run([], root).status, 0);
            const r = run(['--config', 'alt/strict.json'], root);
            assert.equal(r.status, 1);
            assert.match(
                r.stderr,
                /- backend\.lines: 90% is below the 95% floor/
            );
        }
    );
});

test('a missing thresholds file fails instead of passing', () => {
    withRoot({}, (root) => {
        const r = run([], root);
        assert.notEqual(r.status, 0);
        assert.doesNotMatch(r.stdout, /Coverage gate passed/);
    });
});

test('importing the module does not run the gate', async () => {
    const mod = await import(SCRIPT);
    assert.equal(typeof mod.loadSummaries, 'function');
});

test('loadSummaries returns null for a missing file and the parsed summary otherwise', async () => {
    const { loadSummaries } = await import(SCRIPT);
    withRoot(
        { 'coverage/backend/coverage-summary.json': summary({ lines: 91 }) },
        (root) => {
            const out = loadSummaries(
                thresholds(['backend', 'frontend']),
                root
            );
            assert.equal(out.backend.total.lines.pct, 91);
            assert.equal(out.frontend, null);
        }
    );
});
