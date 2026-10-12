import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'auto-qa-tuner.mjs'
);

// auto-qa.yml runs the tuner, tees its stdout into the step summary, and opens
// or edits the tracking issue only when the step wrote raise=true to
// $GITHUB_OUTPUT, using auto-qa-out/issue-body.md as the issue body. Each case
// lays out a throwaway root with the two config files and Jest json-summary
// files, then runs the script the way the workflow does.
const RULES = {
    coverage: {
        raise_floor_when_headroom_exceeds: 5,
        buffer_below_measured: 3,
    },
};
const FLOOR = { lines: 88, statements: 87, functions: 87, branches: 79 };
const MEASURED = { lines: 91, statements: 90, functions: 90, branches: 82 };

function summary(pct) {
    return {
        total: Object.fromEntries(
            Object.keys(FLOOR).map((m) => [m, { pct: pct[m] ?? MEASURED[m] }])
        ),
    };
}

function thresholds(areas) {
    return {
        areas: Object.fromEntries(
            areas.map((a) => [
                a,
                {
                    summary: `coverage/${a}/coverage-summary.json`,
                    measured: MEASURED,
                    floor: FLOOR,
                },
            ])
        ),
    };
}

function layout(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'auto-qa-tuner-'));
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(dir, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(body, null, 4) + '\n');
    }
    return dir;
}

function withRoot(files, fn) {
    const dir = layout({ '.github/auto-qa-tuning.json': RULES, ...files });
    try {
        return fn(dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// The test runner itself may be inside GitHub Actions, so GITHUB_OUTPUT is
// always set (or removed) explicitly rather than inherited.
function run(args, cwd, githubOutput) {
    const env = { ...process.env };
    delete env.GITHUB_OUTPUT;
    if (githubOutput) env.GITHUB_OUTPUT = githubOutput;
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd,
        env,
        encoding: 'utf8',
    });
}

const read = (...p) => readFileSync(path.join(...p), 'utf8');

test('a warranted raise writes the report, a diff issue body and raise=true', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'coverage/backend/coverage-summary.json': summary({ lines: 95.5 }),
        },
        (root) => {
            const out = path.join(root, 'gh-output');
            writeFileSync(out, 'earlier=1\n');
            const r = run(['--out-dir', 'out'], root, out);
            assert.equal(r.status, 0, r.stderr);

            const report = read(root, 'out', 'report.md');
            assert.equal(r.stdout, report);
            assert.match(report, /^## Auto-QA coverage tuning\n/);
            assert.match(
                report,
                /\| backend \| lines \| 95\.5% \| 88% \| 92% \|/
            );
            assert.doesNotMatch(
                report,
                /\| backend \| (statements|functions|branches) \|/
            );

            const body = read(root, 'out', 'issue-body.md');
            assert.ok(
                body.startsWith(report),
                'issue body opens with the report'
            );
            assert.match(body, /apply by hand in a pull request/);
            assert.match(body, /```diff\n[\s\S]*\n```\n$/);
            assert.match(body, /\n-\s+"lines": 88,\n\+\s+"lines": 92,\n/);
            assert.match(body, /\n-\s+"lines": 91,\n\+\s+"lines": 95\.5,\n/);

            // Appends to the step's output file; earlier outputs survive.
            assert.equal(read(out), 'earlier=1\nraise=true\n');
        }
    );
});

test('no raise writes an empty issue body and raise=false', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'coverage/backend/coverage-summary.json': summary({ lines: 93 }),
        },
        (root) => {
            const out = path.join(root, 'gh-output');
            const r = run(['--out-dir', 'out'], root, out);
            assert.equal(r.status, 0, r.stderr);
            assert.match(r.stdout, /No floor raise warranted\./);
            assert.equal(read(root, 'out', 'report.md'), r.stdout);
            assert.equal(read(root, 'out', 'issue-body.md'), '');
            assert.equal(read(out), 'raise=false\n');
        }
    );
});

test('an area with no summary on disk is skipped, not raised and not fatal', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend', 'frontend']),
            'coverage/backend/coverage-summary.json': summary({}),
        },
        (root) => {
            const out = path.join(root, 'gh-output');
            const r = run(['--out-dir', 'out'], root, out);
            assert.equal(r.status, 0, r.stderr);
            assert.match(
                r.stdout,
                /Skipped - frontend: no coverage summary, left unchanged/
            );
            assert.equal(read(out), 'raise=false\n');
        }
    );
});

test('never writes the repository threshold file', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'coverage/backend/coverage-summary.json': summary(
                Object.fromEntries(Object.keys(FLOOR).map((m) => [m, 99]))
            ),
        },
        (root) => {
            const before = read(root, '.coverage-thresholds.json');
            const r = run(['--out-dir', 'out'], root);
            assert.equal(r.status, 0, r.stderr);
            assert.match(
                r.stdout,
                /\| backend \| branches \| 99% \| 79% \| 96% \|/
            );
            assert.equal(read(root, '.coverage-thresholds.json'), before);
        }
    );
});

test('without GITHUB_OUTPUT it still succeeds and writes no output file', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'coverage/backend/coverage-summary.json': summary({ lines: 95.5 }),
        },
        (root) => {
            const r = run(['--out-dir', 'out'], root);
            assert.equal(r.status, 0, r.stderr);
            assert.match(r.stdout, /\| backend \| lines \|/);
            assert.equal(r.stderr, '');
        }
    );
});

test('--root reads config from that directory; the default out dir is under the cwd', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'coverage/backend/coverage-summary.json': summary({ lines: 95.5 }),
        },
        (root) => {
            const cwd = mkdtempSync(path.join(tmpdir(), 'auto-qa-tuner-cwd-'));
            try {
                const r = run(['--root', root], cwd);
                assert.equal(r.status, 0, r.stderr);
                assert.match(
                    r.stdout,
                    /\| backend \| lines \| 95\.5% \| 88% \| 92% \|/
                );
                assert.equal(read(cwd, 'auto-qa-out', 'report.md'), r.stdout);
                assert.match(
                    read(cwd, 'auto-qa-out', 'issue-body.md'),
                    /```diff/
                );
                assert.equal(existsSync(path.join(root, 'auto-qa-out')), false);
            } finally {
                rmSync(cwd, { recursive: true, force: true });
            }
        }
    );
});

test('--out-dir creates nested directories', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'coverage/backend/coverage-summary.json': summary({}),
        },
        (root) => {
            const r = run(['--out-dir', 'a/b/c'], root);
            assert.equal(r.status, 0, r.stderr);
            assert.equal(read(root, 'a', 'b', 'c', 'report.md'), r.stdout);
        }
    );
});

test('a missing rules file fails instead of reporting no raise', () => {
    withRoot(
        {
            '.coverage-thresholds.json': thresholds(['backend']),
            'coverage/backend/coverage-summary.json': summary({ lines: 95.5 }),
        },
        (root) => {
            rmSync(path.join(root, '.github'), { recursive: true });
            const out = path.join(root, 'gh-output');
            const r = run(['--out-dir', 'out'], root, out);
            assert.notEqual(r.status, 0);
            assert.equal(existsSync(out), false);
            assert.equal(existsSync(path.join(root, 'out')), false);
        }
    );
});

test('a missing thresholds file fails', () => {
    withRoot({}, (root) => {
        const r = run(['--out-dir', 'out'], root);
        assert.notEqual(r.status, 0);
        assert.equal(r.stdout, '');
    });
});

test('importing the module does not run the tuner', async () => {
    // Import from an empty cwd: if main() ran it would throw on the missing
    // config or leave an auto-qa-out directory behind.
    const cwd = mkdtempSync(path.join(tmpdir(), 'auto-qa-tuner-import-'));
    const prev = process.cwd();
    process.chdir(cwd);
    try {
        const mod = await import(SCRIPT);
        assert.equal(typeof mod.propose, 'function');
        assert.equal(existsSync(path.join(cwd, 'auto-qa-out')), false);
    } finally {
        process.chdir(prev);
        rmSync(cwd, { recursive: true, force: true });
    }
});
