// The `env` block in .claude/settings.json sets git's safe.bareRepository to
// `explicit` for every command an agent runs. Without it, a bare repository
// committed as ordinary files in a checked-out branch is picked up by the
// pre-approved history commands (`git show`, `git log -p`) when the agent's
// working directory is inside it, and its config can name a program for git
// to run (diff.*.textconv, core.fsmonitor, ...) with no permission prompt. The
// guard hook cannot see that config, so git itself has to refuse the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SETTINGS = fileURLToPath(new URL('../../.claude/settings.json', import.meta.url));
const settingsEnv = JSON.parse(readFileSync(SETTINGS, 'utf8')).env ?? {};

// A clean git environment: no user or system config, no inherited GIT_* overrides.
function baseEnv(home) {
    return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

function git(cwd, env, input, ...args) {
    return spawnSync('git', args, { cwd, env, input, encoding: 'utf8' });
}

function ok(cwd, env, input, ...args) {
    const r = git(cwd, env, input, ...args);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
}

// Builds a clone whose tree carries a committed bare repository `evil/` with one
// commit, whose diff.x.textconv program writes `marker`. Returns the clone's path.
function plantedClone(dir, marker) {
    const env = baseEnv(dir);
    const src = join(dir, 'src');
    const evil = join(src, 'evil');
    ok(dir, env, undefined, 'init', '-q', src);
    ok(src, env, undefined, 'init', '-q', '--bare', 'evil');
    const blob = ok(evil, env, 'data\n', 'hash-object', '-w', '--stdin');
    const tree = ok(evil, env, `100644 blob ${blob}\tfile.txt\n`, 'mktree');
    const commit = ok(evil, env, undefined, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'x');
    ok(evil, env, undefined, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    ok(evil, env, undefined, 'update-ref', 'refs/heads/main', commit);
    ok(evil, env, undefined, 'config', 'diff.x.textconv', `touch '${marker}'; cat`);
    mkdirSync(join(evil, 'info'), { recursive: true });
    writeFileSync(join(evil, 'info', 'attributes'), '* diff=x\n');
    mkdirSync(join(evil, 'refs', 'tags'), { recursive: true });
    writeFileSync(join(evil, 'refs', 'tags', '.keep'), '');
    ok(src, env, undefined, 'add', 'evil');
    ok(src, env, undefined, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
    ok(dir, env, undefined, 'clone', '-q', src, 'victim');
    return join(dir, 'victim');
}

test('settings.json sets safe.bareRepository=explicit through GIT_CONFIG_* for agent commands', () => {
    assert.deepEqual(settingsEnv, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.bareRepository',
        GIT_CONFIG_VALUE_0: 'explicit',
    });
});

test('a committed bare repository cannot make a pre-approved git show or git log -p run a program', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'bare-repo-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, 'ran');
    const victim = plantedClone(dir, marker);
    const evil = join(victim, 'evil');
    const agentEnv = { ...baseEnv(dir), ...settingsEnv };
    const commands = [['show'], ['log', '-p', '-1']];

    // The planted program does run without the setting, so the check below is real.
    for (const args of commands) {
        rmSync(marker, { force: true });
        git(evil, baseEnv(dir), undefined, ...args);
        assert.ok(existsSync(marker), `precondition: without safe.bareRepository git ${args.join(' ')} runs the planted textconv`);
    }

    for (const args of commands) {
        rmSync(marker, { force: true });
        for (const [cwd, full] of [
            [evil, args],
            [victim, ['-C', 'evil', ...args]],
        ]) {
            const r = git(cwd, agentEnv, undefined, ...full);
            assert.notEqual(r.status, 0, `git ${full.join(' ')} should refuse the bare repository`);
            assert.match(r.stderr, /safe\.bareRepository/);
            assert.ok(!existsSync(marker), `git ${full.join(' ')} ran the planted program`);
        }
    }

    // The checkout's own repository (.git/, not bare) still works with the setting.
    assert.equal(git(victim, agentEnv, undefined, 'status', '--short').status, 0);
    assert.equal(git(victim, agentEnv, undefined, 'log', '-1', '--format=%s').stdout.trim(), 'x');
});
