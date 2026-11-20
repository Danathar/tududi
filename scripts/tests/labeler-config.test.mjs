// .github/labeler.yml is the path-to-label map that actions/labeler reads, and
// .github/workflows/labeler.yml is the workflow that runs it. Nothing read
// either one except the repo-wide policy test that refuses
// `pull_request_target`, so a rule that matches no file (a renamed or deleted
// folder), a label that collides with a triage label, or a dropped fork guard
// on the job passed unnoticed. These tests hold both files to the tree:
//
//   1. every glob in labeler.yml matches at least one tracked file;
//   2. no label key is `quality`, `security`, `testing`, `hive/*` or `agent/*`
//      (those are set by people and agents, and `sync-labels` would strip them);
//   3. the workflow triggers on `pull_request` only, the `label` job is
//      skipped for fork pull requests (which only get a read-only token), and
//      the job never checks out code or runs a shell step.
//
// Read-only and dependency-free: a small glob matcher with the labeler's
// minimatch semantics for the syntax used here (`**`, `*`, `?`, dotfiles
// included), run over `git ls-files`. Syntax the matcher does not model (braces,
// character classes, extglobs) fails the test instead of silently passing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const LABELER = '.github/labeler.yml';
const WORKFLOW = '.github/workflows/labeler.yml';
const FORK_GUARD = 'github.event.pull_request.head.repo.full_name == github.repository';

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

// The labeler's config as { label: [glob, ...] }, read line by line: a top-level
// `label:` line opens a label and every quoted or bare scalar under it is a glob
// (the `changed-files:` and `any-glob-to-any-file:` keys are not).
export function parseLabeler(text) {
    const labels = new Map();
    let current = null;
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '');
        if (line.trim() === '' || line.trim().startsWith('#')) continue;
        const key = /^(\S.*?):$/.exec(line);
        if (key) {
            current = unquote(key[1]);
            assert.ok(!labels.has(current), `${LABELER}: label ${current} is declared twice`);
            labels.set(current, []);
            continue;
        }
        assert.ok(current !== null, `${LABELER}: unexpected line before the first label: ${line}`);
        const item = /^\s+(?:-\s+)?(?:[A-Za-z-]+:\s+)?(\S.*)$/.exec(line);
        const bare = /^\s+(?:-\s+)?[A-Za-z-]+:$/.exec(line);
        if (bare || !item) continue;
        labels.get(current).push(unquote(item[1]));
    }
    return labels;
}

export function globToRegExp(glob) {
    assert.ok(!/[{}[\]()!]/.test(glob), `${LABELER}: glob ${glob} uses syntax this test does not model`);
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            if (glob[i + 2] === '/') {
                re += '(?:.*/)?';
                i += 2;
            } else {
                re += '.*';
                i += 1;
            }
        } else if (c === '*') {
            re += '[^/]*';
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

export function deadGlobs(labels, files) {
    const dead = [];
    for (const [label, globs] of labels) {
        for (const glob of globs) {
            const re = globToRegExp(glob);
            if (!files.some((f) => re.test(f))) dead.push(`${label}: ${glob}`);
        }
    }
    return dead;
}

const RESERVED = /^(quality|security|testing)$|^(hive|agent)\//;

export const reservedLabels = (labels) => [...labels.keys()].filter((l) => RESERVED.test(l));

// The lines of a top-level (`indent` 0) or job-level (`indent` 2) block.
function block(text, header, indent) {
    const lines = text.split('\n');
    const pad = ' '.repeat(indent);
    const start = lines.findIndex((l) => l === `${pad}${header}`);
    if (start === -1) return null;
    const out = [];
    for (const l of lines.slice(start + 1)) {
        if (l.trim() !== '' && !l.startsWith(`${pad} `) && !l.trim().startsWith('#')) break;
        out.push(l);
    }
    return out;
}

export function workflowTriggers(text) {
    const lines = block(text, 'on:', 0);
    assert.ok(lines, `${WORKFLOW}: no top-level on: block`);
    return lines.map((l) => /^ {2}([A-Za-z_]+):/.exec(l)?.[1]).filter(Boolean);
}

export function labelJobGuarded(text) {
    const lines = block(text, 'label:', 2);
    assert.ok(lines, `${WORKFLOW}: no label job`);
    return lines.some((l) => l.trim() === `if: ${FORK_GUARD}` && /^ {4}if:/.test(l));
}

// Steps that would run pull request code or a shell with the write token.
export function labelJobHazards(text) {
    const lines = block(text, 'label:', 2);
    assert.ok(lines, `${WORKFLOW}: no label job`);
    return lines.map((l) => l.trim()).filter((l) => /^(?:-\s+)?(?:uses:\s*actions\/checkout\b|run:)/.test(l));
}

const ls = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
const files = ls.stdout.split('\n').filter(Boolean);
const labels = parseLabeler(read(LABELER));

test('git ls-files works and labeler.yml parses into labels with globs', () => {
    assert.equal(ls.status, 0, ls.stderr);
    assert.ok(files.length > 0);
    assert.ok(labels.size >= 5, `only ${labels.size} labels parsed`);
    for (const [label, globs] of labels) assert.ok(globs.length > 0, `${LABELER}: label ${label} has no globs`);
});

test('every glob in labeler.yml matches at least one tracked file', () => {
    assert.deepEqual(deadGlobs(labels, files), [], 'dead path rules: drop them or point them at a path that exists');
});

test('labeler.yml uses no reserved label', () => {
    assert.deepEqual(reservedLabels(labels), [], 'sync-labels would strip labels that people and agents set by hand');
});

test('labeler workflow triggers on pull_request only', () => {
    assert.deepEqual(workflowTriggers(read(WORKFLOW)), ['pull_request']);
});

test('labeler workflow skips fork pull requests at the job level', () => {
    assert.ok(labelJobGuarded(read(WORKFLOW)), `the label job needs: if: ${FORK_GUARD}`);
});

test('labeler job neither checks out code nor runs a shell step', () => {
    assert.deepEqual(labelJobHazards(read(WORKFLOW)), []);
});

test('globToRegExp follows the labeler minimatch semantics', () => {
    assert.ok(globToRegExp('a/**').test('a/b/c.sh'));
    assert.ok(globToRegExp('a/**').test('a/.hidden'));
    assert.ok(globToRegExp('*.md').test('README.md'));
    assert.ok(!globToRegExp('*.md').test('docs/x.md'));
    assert.ok(globToRegExp('**/*.mk').test('a/b.mk'));
    assert.ok(globToRegExp('**/*.mk').test('b.mk'));
    assert.ok(globToRegExp('x/**/y').test('x/y'));
    assert.ok(globToRegExp('README?').test('README1'));
    assert.ok(!globToRegExp('Justfile').test('Justfile.bak'));
    assert.throws(() => globToRegExp('a/{b,c}'));
});

test('a dead glob, a reserved label and a dropped fork guard are caught', () => {
    const mutated = parseLabeler(`${read(LABELER)}\n'area/zz':\n  - changed-files:\n      - any-glob-to-any-file: 'no/such/dir-zz/**'\n\nquality:\n  - changed-files:\n      - any-glob-to-any-file:\n          - 'scripts/**'\n`);
    assert.deepEqual(deadGlobs(mutated, files), ['area/zz: no/such/dir-zz/**']);
    assert.deepEqual(reservedLabels(mutated), ['quality']);
    assert.ok(reservedLabels(parseLabeler("'hive/x':\n  - 'a/**'\n'agent/y':\n  - 'b/**'\n")).length === 2);
    const wf = read(WORKFLOW);
    assert.ok(!labelJobGuarded(wf.replace(`    if: ${FORK_GUARD}\n`, '')));
    const step = '    steps:\n';
    assert.deepEqual(labelJobHazards(wf.replace(step, `${step}      - uses: actions/checkout@v7\n`)), ['- uses: actions/checkout@v7']);
    assert.deepEqual(labelJobHazards(wf.replace(step, `${step}      - run: echo injected\n`)), ['- run: echo injected']);
    assert.deepEqual(workflowTriggers(wf.replace('  pull_request:', '  pull_request_target:')), ['pull_request_target']);
});
