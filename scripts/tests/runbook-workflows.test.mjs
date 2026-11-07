// docs/ai-ops-runbook.md is the page to open when something has gone wrong, and
// it repeats what .github/workflows/ does: which workflows exist, when they
// run, how to turn each off, which tags a publish pushes, which secrets exist.
// Nothing read those copies. The table went on saying three workflows run only
// on pull requests after they also ran on pushes to main, left out the
// mutation job, and said most workflows had yet to merge; the warning about
// disabling a required check named ci.yml alone after agent-tooling became
// required. These tests hold the page to the files, so a workflow changed in
// one has to be written into the other in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const PAGE = 'docs/ai-ops-runbook.md';
const WORKFLOWS = '.github/workflows';
const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];

const flat = (text) => text.replace(/\s*\n\s*/g, ' ');
const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const workflowText = (file) => read(`${WORKFLOWS}/${file}`);
const noComments = (text) =>
    text
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
const workflowFiles = () =>
    fs
        .readdirSync(path.join(repoRoot, WORKFLOWS))
        .filter((f) => f.endsWith('.yml'))
        .sort();

// The text under a heading, up to the next heading of any level.
function section(heading) {
    const lines = read(PAGE).split('\n');
    const start = lines.indexOf(heading);
    assert.notEqual(start, -1, `${PAGE} has no ${heading} heading`);
    const end = lines.findIndex((l, i) => i > start && /^#{1,3} /.test(l));
    return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

const WHAT_EACH = '## What each workflow does, and how to turn it off';

// The workflow table, keyed by file. A cell holds no `|` of its own.
function tableRows() {
    const rows = new Map();
    for (const line of section(WHAT_EACH).split('\n')) {
        const hit = /^\| `([^`]+\.yml)` \|(.*)\|$/.exec(line);
        if (!hit) continue;
        const cells = hit[2].split(' | ').map((c) => c.trim());
        assert.equal(cells.length, 3, line);
        assert.ok(!rows.has(hit[1]), `${hit[1]} has two rows`);
        const [what, trigger, off] = cells;
        rows.set(hit[1], { what, trigger, off });
    }
    return rows;
}

const row = (file) => {
    const found = tableRows().get(file);
    assert.ok(found, `${PAGE} has no row for ${file}`);
    return found;
};

// The events of a workflow's `on:` block, each with the lines under it.
function events(file) {
    const lines = workflowText(file).split('\n');
    const start = lines.indexOf('on:');
    assert.notEqual(start, -1, `${file} has no on: block`);
    const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
    const found = new Map();
    let current;
    for (const line of lines.slice(start + 1, end)) {
        const event = /^ {2}(\w+):/.exec(line);
        if (event) {
            current = [];
            found.set(event[1], current);
        } else if (current && line.trim()) {
            current.push(line.trim());
        }
    }
    return found;
}

// How the table words one event.
function eventWords(event, body) {
    const branches = body.some((l) => /^branches: \[ ?main ?\]$/.test(l));
    if (event === 'schedule') {
        const cron = /^- cron: '(.*?)'/.exec(body[0]);
        assert.ok(cron, `no cron in ${body}`);
        return cron[1].split(' ')[4] === '*' ? 'nightly' : 'weekly';
    }
    if (event === 'workflow_dispatch') return 'manual';
    if (event === 'workflow_run') return '`workflow_run`';
    if (event === 'push') {
        assert.ok(branches, 'a push trigger the table has no words for');
        return 'push to `main`';
    }
    if (event === 'issue_comment') return 'comment';
    if (event === 'pull_request_review_comment') return 'comment';
    if (body.includes('types: [labeled]')) return 'label';
    assert.equal(event, 'pull_request', `no words for ${event}`);
    return branches ? 'PR to `main`' : 'pull request';
}

// What the trigger cell has to say, in the table's order.
const WORD_ORDER = [
    'nightly',
    'weekly',
    'PR to `main`',
    'pull request',
    'push to `main`',
    'label',
    'comment',
    '`workflow_run`',
    'manual',
];

function expectedTrigger(file) {
    const words = new Set();
    for (const [event, body] of events(file)) {
        words.add(eventWords(event, body));
    }
    return WORD_ORDER.filter((w) => words.has(w)).join(', ');
}

// Job id -> the name it reports under, comments dropped. Jobs sit at two
// spaces under `jobs:`, their keys at four.
function jobs(file) {
    const lines = noComments(workflowText(file)).split('\n');
    const start = lines.indexOf('jobs:');
    assert.notEqual(start, -1, `${file} has no jobs: block`);
    const found = new Map();
    let id;
    for (const line of lines.slice(start + 1)) {
        const job = /^ {2}([\w-]+):$/.exec(line);
        if (job) {
            id = job[1];
            found.set(id, id);
        }
        const named = /^ {4}name: *(.+)$/.exec(line);
        if (id && named) found.set(id, named[1].replace(/^"|"$/g, ''));
    }
    return found;
}

const requiredChecks = () =>
    JSON.parse(read('.github/rulesets/main.json'))
        .rules.find((r) => r.type === 'required_status_checks')
        .parameters.required_status_checks.map((c) => c.context)
        .sort();

// The workflows that report a required check.
function requiredWorkflows() {
    const found = new Set();
    for (const check of requiredChecks()) {
        const files = workflowFiles().filter((f) =>
            [...jobs(f).values()].includes(check)
        );
        assert.equal(files.length, 1, `${check} comes from ${files}`);
        found.add(files[0]);
    }
    return [...found].sort();
}

test('the table has one row for every workflow file', () => {
    assert.deepEqual([...tableRows().keys()].sort(), workflowFiles());
});

for (const file of workflowFiles()) {
    test(`the table gives the triggers of ${file}`, () => {
        assert.equal(row(file).trigger, expectedTrigger(file));
    });
}

test('a `gh workflow disable` in the table names the workflow by its name:', () => {
    let commands = 0;
    for (const [file, { off }] of tableRows()) {
        const name = /^name: *(.+)$/m.exec(workflowText(file))?.[1];
        assert.ok(name, `${file} has no name:`);
        for (const hit of off.matchAll(/gh workflow disable "([^"]+)"/g)) {
            assert.equal(hit[1], name, file);
            commands += 1;
        }
    }
    assert.ok(commands > 0, 'no gh workflow disable left in the table');
});

test('the warning about disabling names every workflow behind a required check', () => {
    const hit =
        /\. Disable ((?:`[^`]+`(?: or )?)+) only if you also relax the "protect main" ruleset/.exec(
            flat(section(WHAT_EACH))
        );
    assert.ok(hit, 'the warning about disabling a required check is gone');
    assert.deepEqual(codeSpans(hit[1]).sort(), requiredWorkflows());
});

test('the ci.yml row names every job and says which are required', () => {
    const { what } = row('ci.yml');
    const ids = [...jobs('ci.yml').keys()];
    assert.ok(ids.length > 0);
    for (const id of ids) assert.ok(codeSpans(what).includes(id), id);

    const required = ids.filter((id) => requiredChecks().includes(id)).sort();
    const hit = /.*; (.*?) are (\w+) of the (\w+) checks/.exec(what);
    assert.ok(hit, 'the ci.yml row no longer says which jobs are required');
    assert.deepEqual(codeSpans(hit[1]).sort(), required);
    assert.equal(hit[2], COUNT_WORDS[required.length]);
    assert.equal(hit[3], COUNT_WORDS[requiredChecks().length]);
});

test('the ci.yml row calls the mutation job advisory and pull-request-only', () => {
    const lines = noComments(workflowText('ci.yml'));
    const job = lines.slice(lines.indexOf('  mutation:'));
    assert.match(job, /^ {4}continue-on-error: true$/m);
    assert.match(job, /^ {4}if: .*github\.event_name == 'pull_request'/m);
    assert.match(
        row('ci.yml').what,
        /`mutation` \(advisory, pull requests only: /
    );
});

test('the agent-tooling.yml row names the last required check', () => {
    const others = jobs('ci.yml');
    const left = requiredChecks().filter(
        (c) => ![...others.values()].includes(c)
    );
    assert.deepEqual(left, [...jobs('agent-tooling.yml').values()]);
    assert.match(
        row('agent-tooling.yml').what,
        /the third check the "protect main" ruleset requires/
    );
});

test('every file a row names exists and its workflow uses it', () => {
    for (const [file, { what }] of tableRows()) {
        const paths = codeSpans(what).filter((s) =>
            /^(?:scripts\/|policies\/|\.github\/|\.claude\/|[.\w-]+\.json$)/.test(
                s
            )
        );
        for (const named of paths) {
            // A script has to be run; a data file may only be read by one.
            const text = named.startsWith('scripts/')
                ? noComments(workflowText(file))
                : workflowText(file);
            assert.ok(text.includes(named), `${file}: ${named}`);
            const fixed = named.split('*')[0];
            assert.ok(
                fs.existsSync(path.join(repoRoot, fixed)),
                `${file}: ${named}`
            );
        }
    }
});

test('the rows of the two workflows the owner triggers name their triggers', () => {
    const fix = row('ai-fix.yml').what;
    assert.deepEqual(
        codeSpans(fix).filter((s) => /ai-fix/.test(s)),
        ['ai-fix-requested', '/ai-fix']
    );
    const fixFile = noComments(workflowText('ai-fix.yml'));
    assert.ok(fixFile.includes("'ai-fix-requested'"));
    assert.ok(fixFile.includes("'/ai-fix'"));
    assert.match(fixFile, /github\.event\.sender\.type != 'Bot'/);

    const claude = row('claude.yml').what;
    const claudeFile = noComments(workflowText('claude.yml'));
    assert.ok(codeSpans(claude).includes('@claude'));
    assert.ok(claudeFile.includes("'@claude'"));
    for (const secret of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
        assert.ok(codeSpans(claude).includes(secret), secret);
        assert.ok(claudeFile.includes(`secrets.${secret}`), secret);
    }
});

test('the auto-issues.yml row names the workflows it watches', () => {
    const list = /^ {4}workflows: \[(.*)\]$/m.exec(
        workflowText('auto-issues.yml')
    );
    assert.ok(list, 'auto-issues.yml has no workflows: list');
    const watched = list[1].split(',').map((w) => w.trim());
    const hit = /^when (.*?) fails on a push/.exec(row('auto-issues.yml').what);
    assert.ok(hit, 'the auto-issues.yml row no longer names what it watches');
    assert.deepEqual(codeSpans(hit[1]), watched);
    const names = workflowFiles().map(
        (f) => /^name: *(.+)$/m.exec(workflowText(f))?.[1]
    );
    for (const name of watched) assert.ok(names.includes(name), name);
});

const publish = () => noComments(workflowText('docker-publish.yml'));

test('the docker-publish.yml row names the image and the tags it pushes', () => {
    const { what } = row('docker-publish.yml');
    const image = /^ {2}IMAGE: *(\S+)$/m.exec(publish())?.[1];
    assert.ok(image, 'docker-publish.yml has no IMAGE');
    assert.ok(codeSpans(what).includes(image));

    assert.deepEqual(
        codeSpans(what).filter((s) => s.startsWith(':')),
        [':latest', ':sha-<short>', ':v<version>-<short>']
    );
    assert.match(publish(), /:latest/);
    assert.match(publish(), /short=sha-\$SHORT"/);
    assert.match(publish(), /versioned=v\$VERSION-\$SHORT"/);
});

test('a manual publish from another branch is refused', () => {
    assert.match(publish(), /^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    assert.match(
        row('docker-publish.yml').what,
        /refuses manual runs from any branch but `main`/
    );
    assert.match(
        flat(section('## A bad `:latest` image on ghcr')),
        /a run from any other ref is refused by design/
    );
});

test('the rollback steps use the short tag the publish pushes', () => {
    const text = flat(section('## A bad `:latest` image on ghcr'));
    assert.match(publish(), /name: Resolve tags/);
    assert.match(publish(), /SHORT="\$\{GITHUB_SHA::7\}"/);
    assert.match(
        text,
        /the first seven characters of the commit; `docker-publish\.yml`, step "Resolve tags"/
    );
    const image = /^ {2}IMAGE: *(\S+)$/m.exec(publish())[1];
    assert.ok(text.includes(`${image}:sha-<short>`));
    assert.ok(text.includes(`-t ${image}:latest ${image}:sha-<short>`));
});

// The secrets one workflow reads, by the name after `secrets.`.
const secretsOf = (file) =>
    new Set(
        [...noComments(workflowText(file)).matchAll(/secrets\.(\w+)/g)].map(
            (m) => m[1]
        )
    );

test('the leaked-secret steps name the workflows that hold a credential', () => {
    const holders = workflowFiles().filter((f) =>
        [...secretsOf(f)].some((s) => s !== 'GITHUB_TOKEN')
    );
    const hit = /the Anthropic credential used by (.*?) and any Hive/.exec(
        flat(section('## A leaked secret'))
    );
    assert.ok(hit, 'the leaked-secret page no longer names the holders');
    assert.deepEqual(codeSpans(hit[1]).sort(), holders);
    for (const file of holders) {
        assert.deepEqual([...secretsOf(file)].sort(), [
            'ANTHROPIC_API_KEY',
            'CLAUDE_CODE_OAUTH_TOKEN',
            ...(secretsOf(file).has('GITHUB_TOKEN') ? ['GITHUB_TOKEN'] : []),
        ]);
    }
});

test('docker-publish.yml uses only the workflow token, as the page says', () => {
    assert.deepEqual(
        [...secretsOf('docker-publish.yml')].filter(
            (s) => s !== 'GITHUB_TOKEN'
        ),
        []
    );
    assert.match(publish(), /github\.token|secrets\.GITHUB_TOKEN/);
    assert.match(
        flat(section('## A leaked secret')),
        /`docker-publish\.yml` itself uses only the workflow's `GITHUB_TOKEN`/
    );
});

test('the missed-schedule steps name every scheduled workflow', () => {
    const scheduled = workflowFiles().filter((f) => events(f).has('schedule'));
    assert.ok(scheduled.length > 0);
    const hit = /Scheduled workflows \((.*?)\) run only from the default/.exec(
        flat(section('## A scheduled run did not fire'))
    );
    assert.ok(hit, 'the page no longer lists the scheduled workflows');
    assert.deepEqual(codeSpans(hit[1]).sort(), scheduled);
});
