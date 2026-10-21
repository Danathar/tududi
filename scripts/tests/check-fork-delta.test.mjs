import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    compare,
    lastSyncedUpstream,
    parseDelta,
    parseLedger,
} from '../check-fork-delta.mjs';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'check-fork-delta.mjs'
);

const ledger = (rows) =>
    [
        '# Fork delta',
        '',
        '| PR | Files | Reason | Upstream |',
        '| -- | ----- | ------ | -------- |',
        ...rows.map(
            ([pr, files]) =>
                `| [#${pr}](https://github.com/Danathar/tududi/pull/${pr}) | ${files
                    .map((f) => `\`${f}\``)
                    .join(', ')} | why | fork only |`
        ),
        '',
    ].join('\n');

test('parseLedger maps each file to every row that names it', () => {
    const files = parseLedger(
        ledger([
            [1, ['README.md', 'package.json']],
            [5, ['README.md']],
        ])
    );
    assert.deepEqual(Object.fromEntries(files), {
        'README.md': ['#1', '#5'],
        'package.json': ['#1'],
    });
});

test('parseLedger reads only table rows, not backticks in the prose', () => {
    const text = 'Run `node x.mjs` here.\n' + ledger([[2, ['a.js']]]);
    assert.deepEqual([...parseLedger(text).keys()], ['a.js']);
});

test('parseDelta keeps modified and deleted files and drops the fork’s own', () => {
    assert.deepEqual(
        parseDelta(
            'M\tREADME.md\nD\t.github/FUNDING.yml\nA\tdocs/fork-delta.md\n'
        ),
        ['README.md', '.github/FUNDING.yml']
    );
});

test('compare reports unlisted changes and rows upstream has caught up with', () => {
    const files = parseLedger(
        ledger([
            [1, ['README.md']],
            [151, ['frontend/utils/inboxTokens.ts']],
        ])
    );
    assert.deepEqual(
        compare(files, ['README.md', 'scripts/release-notes.sh']),
        {
            missing: ['scripts/release-notes.sh'],
            stale: ['frontend/utils/inboxTokens.ts (#151)'],
        }
    );
    assert.deepEqual(
        compare(files, ['README.md', 'frontend/utils/inboxTokens.ts']),
        {
            missing: [],
            stale: [],
        }
    );
});

test('lastSyncedUpstream reads the subject, not a PR merge body', () => {
    // `git log --merges --format=%P%x09%s`: the PR merge that lands a sync
    // comes first and its second parent is the fork's sync commit.
    const log = [
        'aaa fff\tMerge pull request #348 from Danathar/scanner/fix-344',
        'bbb up1\tchore: sync upstream c2059f73..96b51073',
        'ccc up0\tchore: sync upstream v1.9.5',
    ].join('\n');
    assert.equal(lastSyncedUpstream(log), 'up1');
    assert.equal(
        lastSyncedUpstream('aaa fff\tMerge pull request #1'),
        undefined
    );
});

// The script end to end, in a throwaway repository: an upstream commit, a
// fork commit on top of it, and the ledger the fork keeps.
function repo() {
    const dir = mkdtempSync(path.join(tmpdir(), 'fork-delta-'));
    const git = (...args) =>
        execFileSync('git', args, {
            cwd: dir,
            encoding: 'utf8',
            env: {
                ...process.env,
                GIT_AUTHOR_NAME: 't',
                GIT_AUTHOR_EMAIL: 't@example.com',
                GIT_COMMITTER_NAME: 't',
                GIT_COMMITTER_EMAIL: 't@example.com',
            },
        }).trim();
    const write = (rel, body) => {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), body);
    };
    git('init', '-q', '-b', 'main');
    write('README.md', 'upstream\n');
    write('app.js', 'upstream\n');
    write('release.sh', 'upstream\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'upstream');
    const upstream = git('rev-parse', 'HEAD');
    write('README.md', 'fork\n');
    unlinkSync(path.join(dir, 'release.sh'));
    git('add', '-A');
    git('commit', '-q', '-m', 'fork');
    return { dir, write, upstream };
}

const run = (dir, args) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: dir,
        encoding: 'utf8',
    });

test('the script passes when every change has a row and fails when one has none', (t) => {
    const { dir, write, upstream } = repo();
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    write('docs/fork-delta.md', ledger([[1, ['README.md', 'release.sh']]]));
    const ok = run(dir, [upstream]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /covers all 2 upstream files/);

    write('docs/fork-delta.md', ledger([[1, ['README.md', 'app.js']]]));
    const bad = run(dir, [upstream]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not in any row .*: release\.sh/);
    assert.match(bad.stderr, /same as upstream .*: app\.js \(#1\)/);
});

test('the script asks for a ref when no sync merge is in the history', (t) => {
    const { dir, write } = repo();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    write('docs/fork-delta.md', ledger([]));
    const res = run(dir, []);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /pass the upstream ref/);
});
