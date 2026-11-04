// The "Signals" table of docs/quality.md says which quality signals this fork
// has and whether each blocks a merge. Nothing read it. It called the two ci.yml
// jobs "planned" required checks long after the ruleset required them, left the
// third required check at "per that workflow", said CI never runs the frontend
// unit tests while three workflows do, and had no row for three workflows.
// These tests hold the table to .github/rulesets/main.json and
// .github/workflows/, so a workflow added or a required check changed has to be
// written into the table in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PAGE = 'docs/quality.md';
const WORKFLOWS = '.github/workflows';

// Workflows that check nothing here, so the table has no row for them.
const NOT_A_SIGNAL = new Map([
    ['ai-fix.yml', 'starts an agent when a maintainer asks for one'],
    ['claude.yml', 'answers @claude mentions'],
    ['labeler.yml', 'labels pull requests by the paths they change'],
]);

const ruleset = JSON.parse(read('.github/rulesets/main.json'));
const requiredNames = () =>
    ruleset.rules
        .find((r) => r.type === 'required_status_checks')
        .parameters.required_status_checks.map((c) => c.context)
        .sort();

const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const workflowFiles = () =>
    fs
        .readdirSync(path.join(repoRoot, WORKFLOWS))
        .filter((f) => /\.ya?ml$/.test(f))
        .sort();

// A workflow with its comments dropped, so only what it does counts.
const workflow = (name) =>
    read(`${WORKFLOWS}/${name}`)
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');

function section(heading) {
    const lines = read(PAGE).split('\n');
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${PAGE} has no ${heading} heading`);
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

// { signal, where, tells, blocks } per data row of the Signals table.
function rows() {
    return section('## Signals')
        .split('\n')
        .filter((l) => l.startsWith('|'))
        .slice(2)
        .map((line) => {
            const cells = line.slice(1, -1).split(' | ');
            assert.equal(cells.length, 4, line);
            const [signal, where, tells, blocks] = cells.map((c) => c.trim());
            return { signal, where, tells, blocks };
        });
}

function row(signal) {
    const hits = rows().filter((r) => r.signal.startsWith(signal));
    assert.equal(hits.length, 1, `want one row opening ${signal}`);
    return hits[0];
}

// The `npm run` scripts a job's steps run, in order, with arguments dropped.
function npmRuns(file, id) {
    const lines = workflow(file).split('\n');
    const start = lines.indexOf(`  ${id}:`);
    assert.notEqual(start, -1, `${file} has no job ${id}`);
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    const job = lines.slice(start, end === -1 ? undefined : end).join('\n');
    return [...job.matchAll(/run: npm run (\S+)/g)].map((m) => m[1]);
}

test('every workflow has a row or a reason it has none', () => {
    const linked = new Set(
        rows().flatMap((r) =>
            [
                ...`${r.where} ${r.tells}`.matchAll(
                    /\(\.\.\/\.github\/workflows\/([^)]+)\)/g
                ),
            ].map((m) => m[1])
        )
    );
    assert.deepEqual(
        workflowFiles().filter((f) => !linked.has(f) && !NOT_A_SIGNAL.has(f)),
        []
    );
    for (const file of NOT_A_SIGNAL.keys()) {
        assert.ok(workflowFiles().includes(file), `${file} is gone`);
        assert.ok(!linked.has(file), `${file} has a row now; drop its reason`);
    }
});

test('every relative link in the table resolves', () => {
    const base = path.dirname(path.join(repoRoot, PAGE));
    const links = [...section('## Signals').matchAll(/\]\(([^)#]+)\)/g)];
    assert.ok(links.length > 0);
    for (const [, target] of links) {
        assert.ok(fs.existsSync(path.resolve(base, target)), target);
    }
});

test('the blocks-merge column follows the ruleset', () => {
    const blocking = rows().filter((r) => /^yes\b/.test(r.blocks));
    assert.deepEqual(
        blocking.flatMap((r) => codeSpans(r.signal)).sort(),
        requiredNames()
    );
    for (const r of blocking) {
        assert.match(r.blocks, /^yes, required check/);
        assert.match(r.signal, /^`[^`]+` job$/);
    }
    for (const r of rows()) {
        assert.match(r.blocks, /^(yes|no)\b/, `${r.signal}: ${r.blocks}`);
    }
});

test('the ci.yml rows name the npm scripts their jobs run', () => {
    for (const job of ['test-sqlite', 'test-postgres']) {
        const named = codeSpans(row(`\`${job}\` job`).tells)
            .filter((s) => s.startsWith('npm run '))
            .map((s) => s.slice('npm run '.length));
        assert.deepEqual(named, npmRuns('ci.yml', job));
    }
});

test('the agent-tooling row names the steps of its job', () => {
    const text = row('`agent-tooling` job').tells;
    const job = workflow('agent-tooling.yml');
    for (const dir of ['scripts/tests/', '.claude/hooks/tests/']) {
        assert.ok(codeSpans(text).includes(dir), dir);
        assert.ok(job.includes(`${dir}**/*.test.mjs`), dir);
    }
    assert.ok(codeSpans(text).includes('node scripts/check-fork-delta.mjs'));
    assert.ok(job.includes('run: node scripts/check-fork-delta.mjs'));
});

test('the mutation row states how the mutation job is set up', () => {
    const r = row('mutation check');
    assert.equal(r.blocks, 'no, advisory (`continue-on-error`)');
    assert.ok(codeSpans(r.tells).includes('chore: sync upstream'));
    const job = workflow('ci.yml').split('  mutation:\n')[1];
    assert.match(job, /^ {4}continue-on-error: true$/m);
    assert.ok(job.includes("'chore: sync upstream'"));
});

// The workflows whose steps run `command`, with comments dropped.
const runningIt = (command) =>
    workflowFiles().filter((f) => workflow(f).includes(`run: ${command}`));

test('the frontend row says which workflows run the unit tests', () => {
    const r = row('frontend unit tests');
    const running = runningIt('npm run frontend:test');
    assert.deepEqual(running, [
        'auto-qa.yml',
        'coverage-gate.yml',
        'nightly-compliance.yml',
    ]);
    for (const file of running) {
        assert.ok(r.tells.includes(file), file);
        assert.match(
            workflow(file),
            /continue-on-error: true\n\s+run: npm run frontend:test:coverage/,
            `${file}: a failing frontend test now fails a job`
        );
    }
    assert.match(r.tells, /`ci\.yml` leaves them out/);
    assert.equal(r.blocks, 'no, a failing test fails no job');
    assert.match(r.tells, /with `continue-on-error` on that step/);
});

test('"Known weak spots" says what CI leaves out', () => {
    const text = section('## Known weak spots').replace(/\s*\n\s*/g, ' ');
    assert.deepEqual(runningIt('npm run test:ui'), []);
    assert.match(row('e2e tests').blocks, /^no, not run in CI/);
    assert.match(text, /CI does not run the e2e suite/);
    assert.match(text, /no job fails on a frontend unit test/);
    assert.ok(!workflow('ci.yml').includes('frontend:test'));
    assert.match(text, /`ci\.yml` leaves the frontend unit tests out/);
});
