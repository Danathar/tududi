import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'mutation-check.mjs'
);

// The CI job reads the script's exit status: 0 nothing new, 1 a new
// survivor, 2 the check could not run. These cases run the script the way the
// workflow does, against Stryker JSON reports written to a throwaway root
// (--report), or against a throwaway git repository (--dry-run and the
// nothing-to-mutate path), so no Stryker run is needed. The Stryker runs and
// the time budget (--budget-minutes) are tested with a stand-in for Stryker
// at the end of this file.

function layout(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mutation-check-'));
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(dir, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    }
    return dir;
}

// The runner sets GITHUB_ACTIONS and GITHUB_STEP_SUMMARY for this test run
// too; a test that wants them passes them in extraEnv.
function childEnv(extraEnv = {}) {
    const env = { ...process.env, ...extraEnv };
    for (const k of ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY']) if (!(k in extraEnv)) delete env[k];
    return env;
}

function run(args, cwd, extraEnv = {}) {
    // The timeout stops a script that hangs, well after every budget these
    // tests use and the 5 s grace before SIGKILL.
    return spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd,
        env: childEnv(extraEnv),
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 64 * 1024 * 1024,
    });
}

const SOURCE = 'function f(x) {\n    return x > 0;\n}\n';
const mutant = (status, mutatorName = 'EqualityOperator', replacement = 'x >= 0') => ({
    id: `${status}-${mutatorName}`,
    mutatorName,
    replacement,
    status,
    location: { start: { line: 2, column: 12 }, end: { line: 2, column: 17 } },
});
const report = (...mutants) => ({
    schemaVersion: '2',
    files: { 'backend/services/a.js': { language: 'javascript', source: SOURCE, mutants } },
});
const ACCEPT = {
    file: 'backend/services/a.js',
    mutator: 'EqualityOperator',
    original: 'x > 0',
    replacement: 'x >= 0',
    reason: 'x is never 0 here',
};

test('exits 0 when every mutant in the report is killed', () => {
    const dir = layout({ 'r.json': report(mutant('Killed'), mutant('Timeout')) });
    try {
        const r = run(['--report', 'r.json'], dir);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /No new surviving mutants \(0 accepted in the ledger\)/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 1 on a survivor that is not in the ledger and prints a ledger entry for it', () => {
    const dir = layout({ 'r.json': report(mutant('Survived')) });
    try {
        const r = run(['--report', 'r.json'], dir);
        assert.equal(r.status, 1, r.stderr);
        assert.match(r.stdout, /backend\/services\/a\.js:2:12 EqualityOperator \(Survived\): `x > 0` -> `x >= 0`/);
        assert.match(r.stdout, /"reason": "TODO/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 1 on a changed line no test runs at all (NoCoverage)', () => {
    const dir = layout({ 'r.json': report(mutant('NoCoverage')) });
    try {
        assert.equal(run(['--report', 'r.json'], dir).status, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 0 when the only survivor is accepted in the default ledger', () => {
    const dir = layout({
        'r.json': report(mutant('Survived')),
        '.mutation-survivors.json': { survivors: [ACCEPT] },
    });
    try {
        const r = run(['--report', 'r.json'], dir);
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stdout, /1 accepted in the ledger/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('still exits 1 when one survivor is accepted and another is not', () => {
    const dir = layout({
        'r.json': report(mutant('Survived'), mutant('Survived', 'ConditionalExpression', 'true')),
        'ledger.json': { survivors: [ACCEPT] },
    });
    try {
        const r = run(['--report', 'r.json', '--ledger', 'ledger.json'], dir);
        assert.equal(r.status, 1);
        assert.match(r.stdout, /ConditionalExpression/);
        assert.doesNotMatch(r.stdout, /EqualityOperator \(Survived\)/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('reads several reports and fails on a survivor in any of them', () => {
    const dir = layout({ 'a.json': report(mutant('Killed')), 'b.json': report(mutant('Survived')) });
    try {
        assert.equal(run(['--report', 'a.json', '--report', 'b.json'], dir).status, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 2 on a malformed ledger, a missing report and bad arguments', () => {
    const dir = layout({
        'r.json': report(mutant('Killed')),
        'bad.json': { survivors: [{ ...ACCEPT, reason: '' }] },
        'broken.json': '{ not json',
    });
    try {
        const bad = run(['--report', 'r.json', '--ledger', 'bad.json'], dir);
        assert.equal(bad.status, 2);
        assert.match(bad.stderr, /bad\.json is malformed/);
        assert.equal(run(['--report', 'r.json', '--ledger', 'broken.json'], dir).status, 2);
        assert.equal(run(['--report', 'missing.json'], dir).status, 2);
        const unknown = run(['--frobnicate'], dir);
        assert.equal(unknown.status, 2);
        assert.match(unknown.stderr, /unknown argument --frobnicate/);
        assert.equal(run(['--base'], dir).status, 2);
        const noBudget = run(['--budget-minutes'], dir);
        assert.equal(noBudget.status, 2);
        assert.match(noBudget.stderr, /--budget-minutes needs a value/);
        for (const bad of ['0', '0.0', 'abc', '1e3', '1.', '-5', '']) {
            const r = run(['--budget-minutes', bad, '--report', 'r.json'], dir);
            assert.equal(r.status, 2, bad);
            assert.ok(
                r.stderr.includes(`--budget-minutes needs a positive number of minutes, got ${bad}\n`),
                `${bad}: ${r.stderr}`
            );
        }
        for (const good of ['50', '0.5']) {
            const r = run(['--budget-minutes', good, '--report', 'r.json'], dir);
            assert.equal(r.status, 0, `${good}: ${r.stderr}`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const git = (cwd, ...args) =>
    execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
        { cwd, encoding: 'utf8' }
    );

function repo() {
    const dir = layout({
        'backend/services/a.js': 'const a = 1;\nconst b = 2;\n',
        'docs/x.md': 'one\n',
    });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'pr');
    return dir;
}

test('--dry-run prints the Stryker ranges for the lines the branch changed', () => {
    const dir = repo();
    try {
        writeFileSync(path.join(dir, 'backend/services/a.js'), 'const a = 1;\nconst b = 3;\nconst c = 4;\n');
        writeFileSync(path.join(dir, 'backend/services/a.test.js'), 'test();\n');
        mkdirSync(path.join(dir, 'frontend/components'), { recursive: true });
        writeFileSync(path.join(dir, 'frontend/components/X.tsx'), 'export const x = 1;\n');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'change');
        const r = run(['--base', 'main', '--dry-run'], dir);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(r.stdout), {
            backend: ['backend/services/a.js:2-3'],
            frontend: ['frontend/components/X.tsx:1-1'],
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 0 without running Stryker when no backend or frontend source changed', () => {
    const dir = repo();
    try {
        writeFileSync(path.join(dir, 'docs/x.md'), 'two\n');
        git(dir, 'commit', '-q', '-am', 'docs');
        const r = run(['--base', 'main'], dir);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /nothing to mutate/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('exits 2 when the base ref does not exist', () => {
    const dir = repo();
    try {
        const r = run(['--base', 'no-such-ref'], dir);
        assert.equal(r.status, 2);
        assert.match(r.stderr, /git diff against no-such-ref failed/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ------------------------------------------------------------ Stryker runs and the time budget (#435)

// A stand-in for Stryker, installed where the script looks for it. It logs
// each start with its suite and process group. For the suite named in
// FAKE_HANG it starts a child process of its own (as Stryker starts Jest
// workers), records that child's pid once its signal handlers are in place,
// and does not finish: SIGTERM or SIGINT is logged and ends it, or with
// FAKE_IGNORE_TERM is only logged. Every other suite prints an error line to
// stdout and one to stderr and exits with FAKE_EXIT when that is set, and
// otherwise writes a report (one survivor, or with FAKE_CLEAN one killed
// mutant) after FAKE_DELAY_MS, if set, and exits 0. It
// logs the test command a tooling suite gets; with FAKE_ORPHAN it first starts
// a child that ignores SIGTERM and outlives it. For the suite named in
// FAKE_OOM it prints Stryker's out-of-memory warning in two pieces and exits
// 1, or with FAKE_OOM_RECOVERS writes its report and exits 0 as a Stryker run
// whose restarted test runner finished would. Nothing it starts lives longer
// than 30 s, so a broken kill cannot leave processes behind for long.
const FAKE_STRYKER = `
const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const project = process.env.MUTATION_PROJECT;
const stat = readFileSync('/proc/self/stat', 'utf8');
const group = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2];
appendFileSync('stryker-starts.log', project + ' ' + group + ' ' + process.env.NODE_ENV + '\\n');
appendFileSync('stryker-commands.log', project + ': ' + (process.env.MUTATION_TEST_COMMAND ?? '-') + '\\n');
appendFileSync('stryker-jest-tests.log', project + ': ' + (process.env.MUTATION_JEST_TESTS ?? '-') + '\\n');
const SOURCE = ${JSON.stringify(SOURCE)};
const FILES = {
    backend: 'backend/services/a.js',
    'backend-unit': 'backend/services/a.js',
    frontend: 'frontend/components/X.tsx',
    hooks: '.claude/hooks/guard.mjs',
    'scripts-tool': 'scripts/tool.mjs',
    'scripts-lonely': 'scripts/lonely.mjs',
};
function writeReport() {
    mkdirSync('reports/mutation', { recursive: true });
    const m = {
        id: '1',
        mutatorName: 'EqualityOperator',
        replacement: 'x >= 0',
        status: process.env.FAKE_CLEAN ? 'Killed' : 'Survived',
        location: { start: { line: 2, column: 12 }, end: { line: 2, column: 17 } },
    };
    const files = { [FILES[project]]: { language: 'javascript', source: SOURCE, mutants: [m] } };
    writeFileSync('reports/mutation/' + project + '.json', JSON.stringify({ schemaVersion: '2', files }));
}
if (project === process.env.FAKE_HANG) {
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => {
            appendFileSync('signals.log', sig + '\\n');
            if (!process.env.FAKE_IGNORE_TERM) process.exit(128 + require('node:os').constants.signals[sig]);
        });
    }
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    writeFileSync('child.pid', String(child.pid));
    setTimeout(() => {
        appendFileSync('signals.log', 'gave up\\n');
        process.exit(0);
    }, 30000);
} else if (project === process.env.FAKE_OOM) {
    process.stdout.write('WARN ChildProcessProxy Child process [pid 1] ran out ');
    setTimeout(() => {
        process.stdout.write('of memory.\\n');
        if (process.env.FAKE_OOM_RECOVERS) writeReport();
        else process.exitCode = 1;
    }, 200);
} else if (process.env.FAKE_EXIT) {
    process.stdout.write('ERROR Stryker Unexpected error occurred while running Stryker\\n');
    process.stderr.write('Error: Something went wrong in the initial test run\\n');
    process.exitCode = Number(process.env.FAKE_EXIT);
} else if (process.env.FAKE_ORPHAN) {
    // It ignores SIGTERM, so only a SIGKILL to the group ends it; wait until
    // its handler is in place.
    const orphan = spawn(
        process.execPath,
        ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 30000)"],
        { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    writeFileSync('orphan.pid', String(orphan.pid));
    orphan.stdout.once('data', () => {
        orphan.stdout.destroy();
        orphan.unref();
        writeReport();
    });
} else {
    setTimeout(writeReport, Number(process.env.FAKE_DELAY_MS ?? 0));
}
`;

const STRYKER_BIN = 'node_modules/@stryker-mutator/core/bin/stryker.js';

const installFakeStryker = (dir) => {
    mkdirSync(path.join(dir, path.dirname(STRYKER_BIN)), { recursive: true });
    writeFileSync(path.join(dir, STRYKER_BIN), FAKE_STRYKER);
};

// A branch that changes one backend and one frontend line, with the fake
// Stryker installed (untracked, as node_modules is).
function strykerRepo() {
    const dir = repo();
    writeFileSync(path.join(dir, 'backend/services/a.js'), 'const a = 1;\nconst b = 3;\n');
    mkdirSync(path.join(dir, 'frontend/components'), { recursive: true });
    writeFileSync(path.join(dir, 'frontend/components/X.tsx'), 'export const x = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'change');
    installFakeStryker(dir);
    return dir;
}

const strykerArgs = (dir, budget) => [
    '--root',
    dir,
    '--base',
    'main',
    ...(budget === null ? [] : ['--budget-minutes', budget]),
];
const strykerRun = (dir, budget, env = {}) => run(strykerArgs(dir, budget), tmpdir(), env);

const startLog = (dir) =>
    readFileSync(path.join(dir, 'stryker-starts.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => l.split(' '));
const starts = (dir) => startLog(dir).map(([project]) => project);
const signals = (dir) => readFileSync(path.join(dir, 'signals.log'), 'utf8');
const pidIn = (dir, file) => Number(readFileSync(path.join(dir, file), 'utf8'));
const ownGroup = () => {
    const stat = readFileSync('/proc/self/stat', 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2];
};

const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function assertGone(pid, what) {
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
    assert.equal(alive(pid), false, `${what} is still running`);
}

const killIfAlive = (dir, file) => {
    if (!existsSync(path.join(dir, file))) return;
    try {
        process.kill(pidIn(dir, file), 'SIGKILL');
    } catch {
        // Already gone.
    }
};

const cleanup = (dir) => {
    killIfAlive(dir, 'child.pid');
    killIfAlive(dir, 'orphan.pid');
    rmSync(dir, { recursive: true, force: true });
};

// The fake reads its process group from /proc.
const linuxOnly = { skip: !existsSync('/proc/self/stat') && 'needs /proc' };

test('runs Stryker for the backend, then the frontend, and reports the survivors of both', linuxOnly, () => {
    const dir = strykerRepo();
    try {
        const r = strykerRun(dir, null);
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(startLog(dir), [
            ['backend', ownGroup(), 'test'],
            ['frontend', ownGroup(), process.env.NODE_ENV ?? 'undefined'],
        ]);
        assert.match(r.stdout, /== backend: mutating 1 range\(s\)\n {3}backend\/services\/a\.js:2-2\n/);
        assert.match(r.stdout, /== frontend: mutating 1 range\(s\)\n {3}frontend\/components\/X\.tsx:1-1\n/);
        assert.match(r.stdout, /backend\/services\/a\.js:2:12 EqualityOperator \(Survived\)/);
        assert.match(r.stdout, /frontend\/components\/X\.tsx:2:12 EqualityOperator \(Survived\)/);
        assert.doesNotMatch(r.stdout, /time budget|incomplete/);
        // A run with nothing incomplete prints no notice or annotation at all.
        const ci = strykerRun(dir, null, { GITHUB_ACTIONS: 'true' });
        assert.equal(ci.status, 1, ci.stdout + ci.stderr);
        assert.doesNotMatch(ci.stdout, /::warning::/);
        assert.ok(
            ci.stdout.trimEnd().endsWith(']'),
            'the ledger entries end the output, with no notice after them'
        );
    } finally {
        cleanup(dir);
    }
});

test('runs a changed script and the guard hook against their own node --test files', linuxOnly, () => {
    const dir = repo();
    try {
        const files = {
            'backend/services/a.js': 'const a = 1;\nconst b = 3;\n',
            'scripts/tool.mjs': 'export const a = 1;\n',
            'scripts/lonely.mjs': 'export const c = 1;\n',
            'scripts/tests/tool.test.mjs': '',
            'scripts/tests/other.test.mjs': '',
            'scripts/tests/helpers.mjs': '',
            '.claude/hooks/guard.mjs': 'export const b = 1;\n',
            '.claude/hooks/tests/shell-reader.test.mjs': '',
        };
        for (const [rel, body] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            writeFileSync(path.join(dir, rel), body);
        }
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'change');
        installFakeStryker(dir);
        // A command left in the environment must not turn the Jest suite into
        // a command-runner suite.
        const r = strykerRun(dir, null, { MUTATION_TEST_COMMAND: 'node --test leaked.test.mjs' });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(starts(dir), ['backend', 'hooks', 'scripts-lonely', 'scripts-tool']);
        const commands = readFileSync(path.join(dir, 'stryker-commands.log'), 'utf8').trim().split('\n');
        assert.deepEqual(commands.filter((c) => !c.startsWith('scripts-lonely:')), [
            'backend: -',
            'hooks: node --test .claude/hooks/tests/guard-bash.test.mjs .claude/hooks/tests/gate-refusal-corpus.test.mjs',
            'scripts-tool: node --test scripts/tests/tool.test.mjs',
        ]);
        // A script with no test file of its own runs every scripts/tests
        // file, in whatever order the directory lists them.
        const lonely = commands.find((c) => c.startsWith('scripts-lonely: node --test '));
        assert.deepEqual(lonely.split(' ').slice(3).sort(), [
            'scripts/tests/other.test.mjs',
            'scripts/tests/tool.test.mjs',
        ]);
        assert.match(r.stdout, /== hooks: mutating 1 range\(s\)\n {3}\.claude\/hooks\/guard\.mjs:1-1\n/);
        assert.match(r.stdout, /== scripts-tool: mutating 1 range\(s\)\n {3}scripts\/tool\.mjs:1-1\n/);
        for (const file of ['backend/services/a.js', '.claude/hooks/guard.mjs', 'scripts/lonely.mjs', 'scripts/tool.mjs']) {
            assert.ok(r.stdout.includes(`${file}:2:12 EqualityOperator (Survived)`), file);
        }
    } finally {
        cleanup(dir);
    }
});

test('runs a backend file with its own unit test against that test alone', linuxOnly, () => {
    const dir = repo();
    try {
        const files = {
            'backend/services/a.js': 'const a = 1;\nconst b = 3;\n',
            'backend/tests/unit/services/a.test.js': '',
            'backend/services/b.js': 'const c = 1;\n',
            'backend/tests/unit/services/c.test.js': '',
        };
        for (const [rel, body] of Object.entries(files)) {
            mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            writeFileSync(path.join(dir, rel), body);
        }
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'change');
        installFakeStryker(dir);
        // A list left in the environment must not narrow the backend suite.
        const r = strykerRun(dir, null, { MUTATION_JEST_TESTS: '["backend/tests/leaked.test.js"]' });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(startLog(dir), [
            ['backend', ownGroup(), 'test'],
            ['backend-unit', ownGroup(), 'test'],
        ]);
        const lists = readFileSync(path.join(dir, 'stryker-jest-tests.log'), 'utf8').trim().split('\n');
        assert.deepEqual(lists, ['backend: -', 'backend-unit: ["backend/tests/unit/services/a.test.js"]']);
        assert.match(r.stdout, /== backend: mutating 1 range\(s\)\n {3}backend\/services\/b\.js:1-1\n/);
        assert.match(r.stdout, /== backend-unit: mutating 1 range\(s\)\n {3}backend\/services\/a\.js:2-2\n/);
        assert.ok(r.stdout.includes('backend/services/a.js:2:12 EqualityOperator (Survived)'));
    } finally {
        cleanup(dir);
    }
});

test('exits 2 instead of running a bare node --test when a changed script has no tests at all', () => {
    const dir = repo();
    try {
        mkdirSync(path.join(dir, 'scripts'), { recursive: true });
        writeFileSync(path.join(dir, 'scripts/lonely.mjs'), 'export const c = 1;\n');
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'change');
        installFakeStryker(dir);
        const r = strykerRun(dir, null);
        assert.equal(r.status, 2, r.stdout + r.stderr);
        assert.match(r.stderr, /^mutation-check: no node --test files to run for scripts-lonely$/m);
        assert.equal(existsSync(path.join(dir, 'stryker-starts.log')), false);
    } finally {
        cleanup(dir);
    }
});

test('a run that finishes inside its budget prints the same as one without a budget', linuxOnly, () => {
    const dir = strykerRepo();
    try {
        const withBudget = strykerRun(dir, '10');
        assert.equal(withBudget.status, 1, withBudget.stdout + withBudget.stderr);
        assert.deepEqual(starts(dir), ['backend', 'frontend']);
        assert.doesNotMatch(withBudget.stdout, /time budget|incomplete/);
        const without = strykerRun(dir, null);
        assert.equal(without.status, 1, without.stderr);
        assert.equal(without.stdout, withBudget.stdout);
    } finally {
        cleanup(dir);
    }
});

test('a clean run inside its budget exits 0 at once, without waiting for the budget', linuxOnly, () => {
    const dir = strykerRepo();
    try {
        const began = Date.now();
        const r = strykerRun(dir, '10', { FAKE_CLEAN: '1' });
        assert.equal(r.status, 0, `${r.signal} ${r.stdout}${r.stderr}`);
        assert.ok(Date.now() - began < 30_000);
        assert.match(r.stdout, /No new surviving mutants \(0 accepted in the ledger\)\./);
    } finally {
        cleanup(dir);
    }
});

test('with a budget Stryker runs in a process group of its own, without one in ours', linuxOnly, () => {
    const dir = strykerRepo();
    try {
        assert.equal(strykerRun(dir, null).status, 1);
        assert.deepEqual(
            startLog(dir).map(([, group]) => group),
            [ownGroup(), ownGroup()]
        );
        rmSync(path.join(dir, 'stryker-starts.log'));
        assert.equal(strykerRun(dir, '10').status, 1);
        const groups = startLog(dir).map(([, group]) => group);
        assert.equal(groups.length, 2);
        for (const group of groups) assert.notEqual(group, ownGroup());
    } finally {
        cleanup(dir);
    }
});

test('with a budget a process Stryker leaves behind is killed when it finishes', linuxOnly, async () => {
    const dir = strykerRepo();
    try {
        const r = strykerRun(dir, '10', { FAKE_ORPHAN: '1' });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        await assertGone(pidIn(dir, 'orphan.pid'), 'the process the finished Stryker run left behind');
    } finally {
        cleanup(dir);
    }
});

test('at the budget the running suite gets SIGTERM with its child processes, and the survivors of the finished suite are reported', linuxOnly, async () => {
    const dir = strykerRepo();
    const summary = path.join(dir, 'summary.md');
    try {
        const r = strykerRun(dir, '0.03', {
            FAKE_HANG: 'frontend',
            GITHUB_ACTIONS: 'true',
            GITHUB_STEP_SUMMARY: summary,
        });
        const notice =
            'mutation check incomplete — time budget (0.03 min) reached, no result: ' +
            'frontend was stopped part way and none of its mutants are counted';
        // The backend survivor is a normal finding, so the usual exit status 1.
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(starts(dir), ['backend', 'frontend']);
        assert.equal(signals(dir), 'SIGTERM\n');
        assert.ok(r.stdout.includes(`\n${notice}\n`), r.stdout);
        assert.ok(r.stdout.includes(`\n::warning::${notice}\n`), r.stdout);
        assert.match(r.stdout, /backend\/services\/a\.js:2:12 EqualityOperator \(Survived\)/);
        assert.doesNotMatch(r.stdout, /frontend\/components\/X\.tsx:2:12/);
        assert.ok(readFileSync(summary, 'utf8').includes(`**${notice}**`));
        assert.doesNotMatch(r.stdout, /ran out of memory/);
        await assertGone(pidIn(dir, 'child.pid'), 'the child process of the stopped Stryker run');
    } finally {
        cleanup(dir);
    }
});

test('the suite after the first one gets only what is left of the budget', linuxOnly, async () => {
    const dir = strykerRepo();
    try {
        // The backend takes 4 s of the 6 s budget, so the frontend is stopped
        // about 2 s after it starts, not after another 6 s.
        const began = Date.now();
        const r = strykerRun(dir, '0.1', { FAKE_HANG: 'frontend', FAKE_DELAY_MS: '4000' });
        const took = Date.now() - began;
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.deepEqual(starts(dir), ['backend', 'frontend']);
        assert.equal(signals(dir), 'SIGTERM\n');
        assert.ok(took >= 6_000, `${took} ms`);
        assert.ok(took < 8_500, `${took} ms: the frontend run was given the whole budget again`);
        await assertGone(pidIn(dir, 'child.pid'), 'the child process of the stopped Stryker run');
    } finally {
        cleanup(dir);
    }
});

test('a budget stop with nothing new to report exits 0 and says so, without an annotation outside GitHub', linuxOnly, async () => {
    const dir = strykerRepo();
    try {
        // The backend hangs, so nothing finished and the frontend never starts.
        const r = strykerRun(dir, '0.03', { FAKE_HANG: 'backend' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.deepEqual(starts(dir), ['backend']);
        assert.equal(signals(dir), 'SIGTERM\n');
        assert.match(
            r.stdout,
            /no result: backend was stopped part way and none of its mutants are counted; frontend not run\n/
        );
        assert.match(r.stdout, /No new surviving mutants in the runs that finished \(0 accepted in the ledger\)\./);
        assert.doesNotMatch(r.stdout, /::warning::/);
        await assertGone(pidIn(dir, 'child.pid'), 'the child process of the stopped Stryker run');
    } finally {
        cleanup(dir);
    }
});

test('a Stryker run that ignores SIGTERM at the budget gets SIGKILL after the grace period', linuxOnly, () => {
    const dir = strykerRepo();
    try {
        const began = Date.now();
        const r = strykerRun(dir, '0.03', { FAKE_HANG: 'backend', FAKE_IGNORE_TERM: '1' });
        assert.equal(r.status, 0, `${r.signal} ${r.stdout}${r.stderr}`);
        // 1.8 s budget plus the 5 s grace; the fake gives up by itself at 30 s.
        assert.ok(Date.now() - began >= 6_000);
        assert.equal(signals(dir), 'SIGTERM\n');
        assert.match(r.stdout, /no result: backend was stopped part way/);
    } finally {
        cleanup(dir);
    }
});

test('a budget used up before Stryker starts runs neither suite', () => {
    const dir = strykerRepo();
    try {
        const r = strykerRun(dir, '0.00001');
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.equal(existsSync(path.join(dir, 'stryker-starts.log')), false);
        assert.match(r.stdout, /no result: backend, frontend not run\n/);
    } finally {
        cleanup(dir);
    }
});

for (const [sig, status] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
]) {
    test(`with a budget ${sig} to the check is passed on to Stryker's group`, linuxOnly, async () => {
        const dir = strykerRepo();
        try {
            const child = spawn(process.execPath, [SCRIPT, ...strykerArgs(dir, '10')], {
                cwd: tmpdir(),
                env: childEnv({ FAKE_HANG: 'backend' }),
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (d) => (stderr += d));
            child.stdout.resume();
            const closed = once(child, 'close');
            for (let i = 0; i < 200 && !existsSync(path.join(dir, 'child.pid')); i++) await sleep(50);
            assert.ok(existsSync(path.join(dir, 'child.pid')), 'the fake Stryker did not start');
            child.kill(sig);
            const [code] = await closed;
            assert.equal(code, status, stderr);
            assert.match(stderr, new RegExp(`^mutation-check: stopped by ${sig}$`, 'm'));
            assert.equal(signals(dir), `${sig}\n`);
            assert.deepEqual(starts(dir), ['backend']);
            await assertGone(pidIn(dir, 'child.pid'), 'the child process of the stopped Stryker run');
        } finally {
            cleanup(dir);
        }
    });
}

test('exits 2 when Stryker fails, with or without a budget', linuxOnly, () => {
    const dir = strykerRepo();
    try {
        for (const budget of [null, '10']) {
            const r = strykerRun(dir, budget, { FAKE_EXIT: '3' });
            assert.equal(r.status, 2, r.stdout + r.stderr);
            assert.match(r.stderr, /^mutation-check: Stryker \(backend\) exited with 3$/m);
            // Stryker's own output is passed through, each stream to its own.
            assert.match(r.stdout, /^ERROR Stryker Unexpected error occurred while running Stryker$/m);
            assert.match(r.stderr, /^Error: Something went wrong in the initial test run$/m);
            assert.doesNotMatch(r.stdout, /incomplete/);
        }
        assert.deepEqual(starts(dir), ['backend', 'backend']);
    } finally {
        cleanup(dir);
    }
});

test('a suite that runs out of memory is reported incomplete, and the other suites still count', linuxOnly, () => {
    const dir = strykerRepo();
    const summary = path.join(dir, 'summary.md');
    const notice =
        'mutation check incomplete — backend ran out of memory, no result; none of its mutants are counted';
    try {
        for (const budget of [null, '10']) {
            const r = strykerRun(dir, budget, {
                FAKE_OOM: 'backend',
                GITHUB_ACTIONS: 'true',
                GITHUB_STEP_SUMMARY: summary,
            });
            // The frontend survivor is a normal finding, so the usual exit status 1.
            assert.equal(r.status, 1, r.stdout + r.stderr);
            // Stryker's own output still reaches the log, split message included.
            assert.ok(r.stdout.includes('Child process [pid 1] ran out of memory.'), r.stdout);
            assert.ok(r.stdout.includes(`\n${notice}\n`), r.stdout);
            assert.ok(r.stdout.includes(`\n::warning::${notice}\n`), r.stdout);
            assert.match(r.stdout, /frontend\/components\/X\.tsx:2:12 EqualityOperator \(Survived\)/);
            assert.doesNotMatch(r.stdout, /backend\/services\/a\.js:2:12/);
            assert.doesNotMatch(r.stdout, /time budget/);
            assert.ok(readFileSync(summary, 'utf8').includes(`**${notice}**`));
        }
        assert.deepEqual(starts(dir), ['backend', 'frontend', 'backend', 'frontend']);
        // With nothing new elsewhere the incomplete run exits 0.
        const clean = strykerRun(dir, null, { FAKE_OOM: 'backend', FAKE_CLEAN: '1' });
        assert.equal(clean.status, 0, clean.stdout + clean.stderr);
        assert.ok(clean.stdout.includes(`\n${notice}\n`), clean.stdout);
        assert.match(clean.stdout, /No new surviving mutants in the runs that finished \(0 accepted in the ledger\)\./);
        assert.doesNotMatch(clean.stdout, /::warning::/);
    } finally {
        cleanup(dir);
    }
});

test('a Stryker run that recovers from running out of memory counts as usual', linuxOnly, () => {
    const dir = strykerRepo();
    try {
        const r = strykerRun(dir, null, { FAKE_OOM: 'backend', FAKE_OOM_RECOVERS: '1' });
        assert.equal(r.status, 1, r.stdout + r.stderr);
        assert.match(r.stdout, /backend\/services\/a\.js:2:12 EqualityOperator \(Survived\)/);
        assert.doesNotMatch(r.stdout, /incomplete/);
    } finally {
        cleanup(dir);
    }
});

test('exits 2 when StrykerJS is not installed', () => {
    const dir = strykerRepo();
    try {
        rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
        const r = strykerRun(dir, '10');
        assert.equal(r.status, 2);
        assert.match(r.stderr, /StrykerJS is not installed/);
    } finally {
        cleanup(dir);
    }
});

test('exits 2 when Stryker cannot be started, with or without a budget', () => {
    const dir = strykerRepo();
    // Ranges on every other line of a file with a long name make one --mutate
    // argument of several hundred kB, more than Linux lets one argument hold,
    // so spawn fails (E2BIG).
    const file = `backend/services/${'n'.repeat(200)}.js`;
    const lines = Array.from({ length: 4000 }, (_, i) => `x${i};`);
    try {
        git(dir, 'checkout', '-q', 'main');
        writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);
        git(dir, 'add', '.');
        git(dir, 'commit', '-q', '-m', 'long file');
        git(dir, 'checkout', '-q', 'pr');
        git(dir, 'merge', '-q', '--no-edit', 'main');
        writeFileSync(path.join(dir, file), `${lines.map((l, i) => (i % 2 ? l : `y${i};`)).join('\n')}\n`);
        git(dir, 'commit', '-q', '-am', 'every other line');
        for (const budget of [null, '10']) {
            const r = strykerRun(dir, budget);
            assert.equal(r.status, 2, r.stderr);
            assert.match(r.stderr, /^mutation-check: cannot start Stryker \(backend\): spawn .*E2BIG/m);
        }
        assert.equal(existsSync(path.join(dir, 'stryker-starts.log')), false);
    } finally {
        cleanup(dir);
    }
});
