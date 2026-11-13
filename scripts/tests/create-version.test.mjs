// scripts/create-version.sh cuts a release: it writes package.json, rolls the
// changelog for a stable release, commits, tags, and pushes the branch and the
// tag. The pushed tag is what docker-publish.yml publishes, so a wrong version
// or a tag pushed the wrong way cannot be taken back. Nothing else runs it.
//
// Each case runs the real script with a version on the command line (the
// non-interactive path) inside a throwaway git repository whose origin is a
// local bare repository. `gh` is a stub that fails, so nothing reaches GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
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
    'create-version.sh'
);

const CHANGELOG = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '- Add a thing',
    '',
    '## 2.1.0',
    '',
    '- Older thing',
    '',
].join('\n');

function sandbox() {
    const root = mkdtempSync(path.join(tmpdir(), 'create-version-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const gh = path.join(bin, 'gh');
    writeFileSync(gh, `#!/bin/sh\necho "gh $*" >> "${root}/gh-calls"\nexit 1\n`);
    chmodSync(gh, 0o755);
    const env = {
        PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Release Test',
        GIT_AUTHOR_EMAIL: 'release@example.invalid',
        GIT_COMMITTER_NAME: 'Release Test',
        GIT_COMMITTER_EMAIL: 'release@example.invalid',
    };
    const git = (args, cwd) => {
        const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
        assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
    };
    return { root, env, git };
}

function makeRepo(
    { version = 'v2.1.0', changelog = CHANGELOG, tags = [] } = {}
) {
    const box = sandbox();
    const repo = path.join(box.root, 'repo');
    const origin = path.join(box.root, 'origin.git');
    mkdirSync(repo);
    box.git(['init', '-q', '--bare', origin], box.root);
    // Logs each push as one line of the refs it updated, so the test can tell
    // two pushes from one.
    const hook = path.join(origin, 'hooks', 'pre-receive');
    writeFileSync(
        hook,
        `#!/bin/sh\nrefs=""\nwhile read -r old new ref; do refs="$refs $ref"; done\necho "$refs" >> "${box.root}/pushes"\n`
    );
    chmodSync(hook, 0o755);

    box.git(['init', '-q', '-b', 'main'], repo);
    writeFileSync(
        path.join(repo, 'package.json'),
        JSON.stringify({ name: 'tududi', version }, null, 2) + '\n'
    );
    writeFileSync(path.join(repo, 'CHANGELOG.md'), changelog);
    box.git(['add', '.'], repo);
    box.git(['commit', '-q', '-m', 'initial'], repo);
    for (const tag of tags) box.git(['tag', tag], repo);
    box.git(['remote', 'add', 'origin', origin], repo);
    return { ...box, repo, origin };
}

function run(box, args, { cwd = box.repo } = {}) {
    const r = spawnSync('bash', [SCRIPT, ...args], {
        cwd,
        env: box.env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
    });
    return { status: r.status, out: r.stdout + r.stderr };
}

const read = (box, file) => readFileSync(path.join(box.repo, file), 'utf8');
const tagsOf = (box, dir = box.repo) =>
    box.git(['tag', '--list'], dir).split('\n').filter(Boolean);
const headOf = (box) => box.git(['rev-parse', 'HEAD'], box.repo);
const cleanup = (box) => rmSync(box.root, { recursive: true, force: true });

function refuses(box, args, message) {
    const before = headOf(box);
    const tags = tagsOf(box);
    const r = run(box, args);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, message);
    assert.equal(headOf(box), before, 'no commit is made');
    assert.deepEqual(tagsOf(box), tags, 'no tag is made');
    assert.equal(existsSync(path.join(box.root, 'pushes')), false);
}

test('--help prints the usage and changes nothing', () => {
    const box = makeRepo();
    try {
        const r = run(box, ['--help']);
        assert.equal(r.status, 0);
        assert.match(r.out, /Usage: .* \[--no-push\] \[version\]/);
        assert.deepEqual(tagsOf(box), []);
    } finally {
        cleanup(box);
    }
});

for (const [name, args, message] of [
    ['an unknown option', ['--force', 'v2.2.0'], /unknown option: --force/],
    ['a second version', ['v2.2.0', 'v2.3.0'], /unexpected argument: v2\.3\.0/],
    ['no version and no terminal', [], /no version given and no terminal/],
    ['a version without the v', ['2.2.0'], /Version must start with 'v'/],
    ['a version with two parts', ['v2.2'], /is not a version like v1\.5\.0/],
    ['a version with a bad suffix', ['v2.2.0-rc_1'], /is not a version like/],
    ['a version with a build tail', ['v2.2.0+5'], /is not a version like/],
    ['the version already in package.json', ['v2.1.0'], /already set to version v2\.1\.0/],
]) {
    test(`refuses ${name}`, () => {
        const box = makeRepo();
        try {
            refuses(box, args, message);
        } finally {
            cleanup(box);
        }
    });
}

test('refuses a tag that already exists', () => {
    const box = makeRepo({ tags: ['v2.2.0'] });
    try {
        refuses(box, ['v2.2.0'], /Tag v2\.2\.0 already exists/);
    } finally {
        cleanup(box);
    }
});

test('refuses a working tree with uncommitted changes', () => {
    const box = makeRepo();
    try {
        writeFileSync(path.join(box.repo, 'stray.txt'), 'x\n');
        refuses(box, ['v2.2.0'], /uncommitted changes/);
    } finally {
        cleanup(box);
    }
});

test('refuses to run outside a git repository', () => {
    const box = sandbox();
    try {
        const r = run(box, ['v2.2.0'], { cwd: box.root });
        assert.equal(r.status, 1);
        assert.match(r.out, /must be run inside a git repository/);
    } finally {
        cleanup(box);
    }
});

test('a stable release sets the version, rolls the changelog, commits and tags', () => {
    const box = makeRepo();
    try {
        const r = run(box, ['--no-push', 'v2.2.0']);
        assert.equal(r.status, 0, r.out);

        assert.equal(
            read(box, 'package.json'),
            JSON.stringify({ name: 'tududi', version: 'v2.2.0' }, null, 2) + '\n'
        );
        assert.equal(
            read(box, 'CHANGELOG.md'),
            CHANGELOG.replace('## Unreleased\n', '## Unreleased\n\n## 2.2.0\n')
        );
        assert.equal(
            box.git(['log', '-1', '--format=%s'], box.repo),
            'release: v2.2.0'
        );
        assert.equal(
            box.git(['show', '--name-only', '--format=', 'HEAD'], box.repo),
            'CHANGELOG.md\npackage.json'
        );
        assert.equal(box.git(['cat-file', '-t', 'v2.2.0'], box.repo), 'tag');
        assert.equal(
            box.git(['rev-parse', 'v2.2.0^{commit}'], box.repo),
            headOf(box)
        );
        assert.equal(
            box.git(['tag', '-l', '--format=%(contents:subject)', 'v2.2.0'], box.repo),
            'Release v2.2.0'
        );
    } finally {
        cleanup(box);
    }
});

test('--no-push stops at the local tag and prints how to publish', () => {
    const box = makeRepo();
    try {
        const r = run(box, ['--no-push', 'v2.2.0']);
        assert.equal(r.status, 0, r.out);
        assert.match(
            r.out,
            /Publish it with: {2}git push origin main && git push origin v2\.2\.0/
        );
        assert.equal(existsSync(path.join(box.root, 'pushes')), false);
        assert.deepEqual(tagsOf(box, box.origin), []);
    } finally {
        cleanup(box);
    }
});

for (const version of ['v2.2.0-rc.1', 'v2.2.0-dev.3']) {
    test(`a pre-release (${version}) leaves the changelog alone`, () => {
        const box = makeRepo();
        try {
            const r = run(box, ['--no-push', version]);
            assert.equal(r.status, 0, r.out);
            assert.equal(read(box, 'CHANGELOG.md'), CHANGELOG);
            assert.equal(JSON.parse(read(box, 'package.json')).version, version);
            assert.equal(
                box.git(['show', '--name-only', '--format=', 'HEAD'], box.repo),
                'package.json'
            );
            assert.deepEqual(tagsOf(box), [version]);
        } finally {
            cleanup(box);
        }
    });
}

test('an empty Unreleased section right above the last release is left alone', () => {
    // The bug fixed upstream in #1817: the last release's heading counted as
    // unreleased text, so every release stacked another empty heading.
    const changelog = '# Changelog\n\n## Unreleased\n\n## 2.1.0\n\n- Older thing\n';
    const box = makeRepo({ changelog });
    try {
        const r = run(box, ['--no-push', 'v2.2.0']);
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /"## Unreleased" is empty; leaving CHANGELOG\.md alone/);
        assert.equal(read(box, 'CHANGELOG.md'), changelog);
    } finally {
        cleanup(box);
    }
});

test('a changelog with no Unreleased section is left alone', () => {
    const changelog = '# Changelog\n\n## 2.1.0\n\n- Older thing\n';
    const box = makeRepo({ changelog });
    try {
        const r = run(box, ['--no-push', 'v2.2.0']);
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /No "## Unreleased" section/);
        assert.equal(read(box, 'CHANGELOG.md'), changelog);
    } finally {
        cleanup(box);
    }
});

test('publishing pushes the branch, then the tag, as two separate pushes', () => {
    // One push carrying both left v1.5.0-rc.8 on the remote with no tag
    // event, so nothing was built. The tag must arrive on its own.
    const box = makeRepo();
    try {
        const r = run(box, ['v2.2.0']);
        assert.equal(r.status, 0, r.out);
        assert.deepEqual(
            readFileSync(path.join(box.root, 'pushes'), 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((line) => line.trim()),
            ['refs/heads/main', 'refs/tags/v2.2.0']
        );
        assert.equal(
            box.git(['rev-parse', 'v2.2.0^{commit}'], box.origin),
            headOf(box)
        );
        assert.equal(box.git(['rev-parse', 'main'], box.origin), headOf(box));
        assert.match(r.out, /Pushed main and v2\.2\.0 to /);
    } finally {
        cleanup(box);
    }
});
