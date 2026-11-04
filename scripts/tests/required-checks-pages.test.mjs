// .github/rulesets/main.json decides which checks a pull request must pass, and
// several pages repeat the names. Nothing read those copies: when `agent-tooling`
// became the third required check, docs/multi-agent.md went on saying the
// ruleset requires "both" jobs of ci.yml, and "Renaming a required check" in
// docs/branch-protection.md went on naming two. These tests hold the pages to
// the ruleset and to the workflows behind it, so a rule or a required check
// changed in one has to be written into the other in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PAGE = 'docs/branch-protection.md';
const MULTI_AGENT = 'docs/multi-agent.md';
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

const ruleset = JSON.parse(read('.github/rulesets/main.json'));
const rule = (type) => ruleset.rules.find((r) => r.type === type);
const statusChecks = () => rule('required_status_checks').parameters;
const requiredNames = () =>
    statusChecks()
        .required_status_checks.map((c) => c.context)
        .sort();

const flat = (text) => text.replace(/\s*\n\s*/g, ' ');
const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
// The code spans of a list of checks, less the workflow paths beside them.
const checkNames = (text) =>
    [...new Set(codeSpans(text).filter((s) => !/[./]/.test(s)))].sort();

// The text under a heading, up to the next heading of any level.
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

// The top-level bullet of a section that opens with `lead`, wrapped lines
// folded.
function bullet(text, lead) {
    const found = [];
    for (const line of text.split('\n')) {
        if (line.startsWith('- ')) found.push(line);
        else if (found.length && /^\s+\S/.test(line))
            found[found.length - 1] += `\n${line}`;
    }
    const hits = found.filter((b) => lead.test(b));
    assert.equal(hits.length, 1, `want one bullet opening ${lead}`);
    return flat(hits[0]);
}

const rulesetBullet = (lead) => bullet(section(PAGE, '## The ruleset'), lead);

// The lines of a job, comments dropped. Jobs sit at two spaces under `jobs:`.
function jobLines(workflow, id) {
    const lines = read(`.github/workflows/${workflow}`).split('\n');
    const start = lines.indexOf(`  ${id}:`);
    assert.notEqual(start, -1, `${workflow} has no job ${id}`);
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    return lines
        .slice(start + 1, end === -1 ? undefined : end)
        .filter((l) => !/^\s*#/.test(l));
}

// The `on:` block of a workflow.
function triggers(workflow) {
    const lines = read(`.github/workflows/${workflow}`).split('\n');
    const start = lines.indexOf('on:');
    assert.notEqual(start, -1, `${workflow} has no on: block`);
    const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
    return lines.slice(start + 1, end).join('\n');
}

// Required check -> the workflow and job id that report it.
const REPORTED_BY = new Map([
    ['agent-tooling', ['agent-tooling.yml', 'node-tests']],
    ['test-postgres', ['ci.yml', 'test-postgres']],
    ['test-sqlite', ['ci.yml', 'test-sqlite']],
]);

test('every required check comes from the job this test names', () => {
    assert.deepEqual(requiredNames(), [...REPORTED_BY.keys()].sort());
    for (const [check, [workflow, id]] of REPORTED_BY) {
        const lines = jobLines(workflow, id);
        const named = lines.find((l) => /^ {4}name:/.test(l));
        assert.equal(named?.replace(/^ {4}name: */, '') ?? id, check);
    }
});

// Each page's copy of the list, as the words around it find it.
const COPIES = [
    ['docs/agent-boundaries.md', /CI \(([^)]*)\) is the gate/],
    [PAGE, /\*\*\w+ required checks: (.*?)\.\*\*/],
    [PAGE, /has passed (.*?) on it\./],
    [PAGE, /pull request renames (.*?) \(or the job behind it\)/],
    [MULTI_AGENT, /gate a merge are (.*?)\. They run on/],
    ['docs/review-rubric.md', /- \[ \] CI \(([^)]*)\) is green/],
    ['docs/risk-tiers.md', /required CI checks \(([^)]*)\) must pass/],
    ['docs/security/SECURITY-AI.md', /a required check \(([^)]*)\)/],
];

for (const [page, words] of COPIES) {
    test(`${page} names every required check at ${words.source}`, () => {
        const hit = words.exec(flat(read(page)));
        assert.ok(hit, `${page} no longer matches ${words}`);
        assert.deepEqual(checkNames(hit[1]), requiredNames());
    });
}

test('the pages count the required checks the ruleset has', () => {
    const count = COUNT_WORDS[requiredNames().length];
    assert.match(
        rulesetBullet(/^- \*\*\w+ required checks:/),
        new RegExp(`^- \\*\\*${count} required checks:`, 'i')
    );
    const lands = section(MULTI_AGENT, '## Who decides what lands');
    assert.match(
        bullet(lands, /^- \*\*Required checks\.\*\*/),
        new RegExp(`requires all ${count}, with branches up to date`)
    );
    assert.match(
        flat(read('docs/ai-ops-runbook.md')),
        new RegExp(`of the ${count} checks the "protect main" ruleset requires`)
    );
});

test('the required checks run on every pull request to main', () => {
    const text = rulesetBullet(/^- \*\*\w+ required checks:/);
    assert.match(text, /on every pull request to `main` with no path filter/);
    assert.match(text, /`integration_id` 15368 is GitHub Actions/);
    for (const check of statusChecks().required_status_checks) {
        assert.equal(check.integration_id, 15368, check.context);
    }
    for (const [check, [workflow, id]] of REPORTED_BY) {
        assert.ok(text.includes(`(../.github/workflows/${workflow})`), check);
        const on = triggers(workflow);
        assert.match(on, /^ {2}pull_request:\n {4}branches: \[ main \]/m);
        assert.doesNotMatch(on, /paths|types:/, workflow);
        assert.ok(
            !jobLines(workflow, id).some((l) => /^ {4}if:/.test(l)),
            `${check} would be skipped, and a required check must report`
        );
    }
});

test('agent-tooling runs what the ruleset bullet says it runs', () => {
    const text = rulesetBullet(/^- \*\*\w+ required checks:/);
    const job = jobLines('agent-tooling.yml', 'node-tests').join('\n');
    for (const dir of ['.claude/hooks/tests/', 'scripts/tests/']) {
        assert.ok(codeSpans(text).includes(dir), dir);
        assert.ok(job.includes(`${dir}**/*.test.mjs`), dir);
    }
    assert.ok(codeSpans(text).includes('node scripts/check-fork-delta.mjs'));
    assert.match(job, /run: node scripts\/check-fork-delta\.mjs/);
    assert.match(text, /on a full-history checkout/);
    assert.match(job, /fetch-depth: 0/);
});

test('the mutation job is advisory, as the page says', () => {
    const text = rulesetBullet(/^- \*\*Not required: /);
    assert.match(text, /^- \*\*Not required: the `mutation` job in `ci\.yml`/);
    assert.match(text, /\(`continue-on-error: true`\)/);
    assert.match(text, /runs only on pull requests, and skips upstream syncs/);
    assert.ok(!requiredNames().includes('mutation'));
    const job = jobLines('ci.yml', 'mutation');
    assert.ok(job.includes('    continue-on-error: true'));
    const guard = job.find((l) => /^ {4}if:/.test(l));
    assert.ok(guard.includes("github.event_name == 'pull_request'"));
    assert.ok(guard.includes("'chore: sync upstream'"));
});

test('the ruleset bullets state what the ruleset holds', () => {
    assert.ok(
        rulesetBullet(/^- \*\*Targets /).includes(
            ruleset.conditions.ref_name.include[0]
        )
    );
    assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);

    assert.match(rulesetBullet(/^- \*\*No bypass actors/), /No bypass actors/);
    assert.deepEqual(ruleset.bypass_actors, []);

    assert.ok(rule('deletion'));
    assert.ok(rule('non_fast_forward'));
    assert.match(
        rulesetBullet(/^- \*\*`deletion` and/),
        /`deletion` and `non_fast_forward`/
    );

    const reviews = rule('pull_request').parameters;
    const approvals = reviews.required_approving_review_count;
    assert.match(
        rulesetBullet(/^- \*\*`pull_request` with /),
        new RegExp(`\`pull_request\` with ${approvals} approvals`)
    );

    assert.equal(statusChecks().strict_required_status_checks_policy, true);
    assert.ok(
        rulesetBullet(/^- \*\*A pull request merges only with /).includes(
            '(`strict_required_status_checks_policy: true`)'
        )
    );
});

test('the ruleset has only the rules the page explains', () => {
    assert.deepEqual(ruleset.rules.map((r) => r.type).sort(), [
        'deletion',
        'non_fast_forward',
        'pull_request',
        'required_status_checks',
    ]);
});

test('"Merge queue" says the ruleset has no merge_queue rule', () => {
    assert.equal(rule('merge_queue'), undefined);
    assert.match(
        flat(section(PAGE, '## Merge queue')),
        /the ruleset has no `merge_queue` rule/
    );
});

test('"When there is a second reviewer" names settings still to change', () => {
    const text = section(PAGE, '## When there is a second reviewer');
    const reviews = rule('pull_request').parameters;
    assert.match(text, /Set `required_approving_review_count` to 1/);
    assert.equal(reviews.required_approving_review_count, 0);
    assert.ok(codeSpans(text).includes('require_last_push_approval'));
    assert.equal(reviews.require_last_push_approval, false);
});
