import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
// nothing-to-mutate path), so no Stryker run is needed.

function layout(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mutation-check-'));
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(dir, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    }
    return dir;
}

function run(args, cwd) {
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8' });
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
