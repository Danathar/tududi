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

// One Jest run writes one summary; an area with "include" counts only the
// files under its folders. Jest keys per-file entries by absolute path.
function perFile(root, files) {
    const out = { total: summary({ lines: 99 }).total };
    for (const [rel, [covered, total]] of Object.entries(files)) {
        out[path.join(root, rel)] = Object.fromEntries(
            ['lines', 'statements', 'functions', 'branches'].map((m) => [
                m,
                { total, covered, skipped: 0, pct: 0 },
            ])
        );
    }
    return out;
}

function splitThresholds(floor) {
    const summaryPath = 'backend/coverage/coverage-summary.json';
    return {
        areas: {
            backend: {
                summary: summaryPath,
                include: ['backend/services'],
                floor: FLOOR,
            },
            'backend-modules': {
                summary: summaryPath,
                include: ['backend/modules', 'backend/utils'],
                floor,
            },
        },
    };
}

function withSplitRoot(floor, files, fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'coverage-gate-split-'));
    try {
        const write = (rel, body) => {
            const p = path.join(dir, rel);
            mkdirSync(path.dirname(p), { recursive: true });
            writeFileSync(p, JSON.stringify(body));
        };
        write('.coverage-thresholds.json', splitThresholds(floor));
        write('backend/coverage/coverage-summary.json', perFile(dir, files));
        return fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('an area with include is gated on its own files, not the summary total', () => {
    withSplitRoot(
        { lines: 60, statements: 60, functions: 60, branches: 60 },
        {
            'backend/services/a.js': [9, 10],
            // 6 + 0 of 10 + 10 = 30%: below the 60% floor although the
            // summary total says 99% and services alone are at 90%.
            'backend/modules/b.js': [6, 10],
            'backend/utils/c.js': [0, 10],
            // A sibling folder whose name starts with an included one.
            'backend/modules-old/d.js': [10, 10],
        },
        (root) => {
            const r = run([], root);
            assert.equal(r.status, 1);
            assert.match(
                r.stdout,
                /\| backend \| lines \| 90\.00% \| 88% \| ok \|/
            );
            assert.match(
                r.stderr,
                /- backend-modules\.lines: 30% is below the 60% floor/
            );
            assert.doesNotMatch(r.stderr, /- backend\./);
        }
    );
});

test('an include that matches no file fails instead of passing', () => {
    withSplitRoot(
        { lines: 0, statements: 0, functions: 0, branches: 0 },
        { 'backend/services/a.js': [9, 10] },
        (root) => {
            const r = run([], root);
            assert.equal(r.status, 1);
            assert.match(
                r.stderr,
                /- backend-modules: no coverage summary at backend\/coverage\/coverage-summary\.json for files under backend\/modules, backend\/utils/
            );
        }
    );
});

test('totalUnder rounds like Istanbul so it matches the total Jest writes', async () => {
    const { totalUnder } = await import(SCRIPT);
    const root = path.join(tmpdir(), 'root');
    const total = totalUnder(
        perFile(root, { 'x/a.js': [2, 3], 'x/b.js': [0, 0] }),
        ['x'],
        root
    );
    // 2/3 = 66.666...: Istanbul truncates to 66.66, it does not round up.
    assert.deepEqual(total.lines, { total: 3, covered: 2, pct: 66.66 });
    assert.equal(totalUnder(perFile(root, { 'x/b.js': [0, 0] }), ['x'], root).lines.pct, 100);
});
