// scripts/start-all-dev.sh is `npm start`. Before starting the backend and the
// frontend it kills whatever is listening on their ports (8080 and 3002):
// TERM first, KILL if the listener is still there about 3 seconds later. A
// mistake here kills the wrong processes on a developer's machine, or leaves
// the servers running after Ctrl-C.
//
// Each case runs the real script with lsof, npm and sleep replaced by stubs.
// The "listeners" are real throwaway processes, so the script's own `kill`
// (a shell builtin) acts on them; the lsof stub reports a listener as long as
// its process is alive. Linux only: the stub reads /proc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
    'start-all-dev.sh'
);

const which = (cmd) =>
    spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' })
        .stdout.trim();
const BASH = which('bash');
const REAL_SLEEP = which('sleep');
const TR = which('tr');

// Only builtins, so the stubs work with PATH set to the stub folder alone.
const LSOF = `#!${BASH}
# lsof -ti tcp:PORT -sTCP:LISTEN
printf '%s\\n' "lsof $*" >> "$STUB_ROOT/calls"
port=\${2#tcp:}
[ -f "$STUB_ROOT/port-$port" ] || exit 1
found=1
while read -r pid; do
  [ -r "/proc/$pid/stat" ] || continue
  read -r _ _ state _ < "/proc/$pid/stat"
  [ "$state" = Z ] && continue
  printf '%s\\n' "$pid"
  found=0
done < "$STUB_ROOT/port-$port"
exit $found
`;

const NPM = `#!${BASH}
printf '%s\\n' "npm $*" >> "$STUB_ROOT/calls"
if [ -n "\${STUB_HANG:-}" ]; then
  printf '%s\\n' "$$" >> "$STUB_ROOT/npm-pids"
  exec "$REAL_SLEEP" 60
fi
`;

const SLEEP = `#!${BASH}
printf '%s\\n' "sleep $*" >> "$STUB_ROOT/calls"
`;

function sandbox({ lsof = true } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'start-all-dev-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    const stubs = { npm: NPM, sleep: SLEEP, tr: `#!${BASH}\nexec ${TR} "$@"\n` };
    if (lsof) stubs.lsof = LSOF;
    for (const [name, body] of Object.entries(stubs)) {
        writeFileSync(path.join(bin, name), body);
        chmodSync(path.join(bin, name), 0o755);
    }
    writeFileSync(path.join(root, 'calls'), '');
    const env = { PATH: bin, STUB_ROOT: root, REAL_SLEEP };
    return { root, env };
}

const callsOf = (box) =>
    readFileSync(path.join(box.root, 'calls'), 'utf8').split('\n').filter(Boolean);

function runSync(box) {
    const r = spawnSync(BASH, [SCRIPT], {
        env: box.env,
        encoding: 'utf8',
        timeout: 30000,
    });
    return { status: r.status, out: r.stdout + r.stderr };
}

// Never wait on a process without a limit: a script that fails to stop it
// must fail the test, not hang the CI job.
const within = (promise, ms = 5000) =>
    Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve('still running'), ms).unref()),
    ]);

// A process standing in for a server on `port`; `ended` resolves with the
// signal that ended it, or 'still running' after 5 seconds.
function listener(box, port, { ignoreTerm = false } = {}) {
    const body = ignoreTerm
        ? `trap '' TERM; while :; do ${REAL_SLEEP} 1; done`
        : `exec ${REAL_SLEEP} 300`;
    const child = spawn(BASH, ['-c', body], { stdio: 'ignore' });
    const ended = within(
        new Promise((resolve) =>
            child.on('exit', (_code, signal) => resolve(signal))
        )
    );
    writeFileSync(path.join(box.root, `port-${port}`), `${child.pid}\n`, {
        flag: 'a',
    });
    return { child, ended };
}

const cleanup = (box, ...children) => {
    for (const c of children) {
        try {
            c.kill('SIGKILL');
        } catch {
            // already gone
        }
    }
    rmSync(box.root, { recursive: true, force: true });
};

test('with free ports it checks only 8080 and 3002, then starts both servers', () => {
    const box = sandbox();
    try {
        const r = runSync(box);
        assert.equal(r.status, 0, r.out);
        const calls = callsOf(box);
        assert.deepEqual(
            calls.filter((c) => c.startsWith('lsof ')),
            ['lsof -ti tcp:8080 -sTCP:LISTEN', 'lsof -ti tcp:3002 -sTCP:LISTEN']
        );
        assert.deepEqual(
            calls.filter((c) => c.startsWith('npm ')).sort(),
            ['npm run backend:start', 'npm run frontend:dev']
        );
        assert.doesNotMatch(r.out, /in use/);
    } finally {
        cleanup(box);
    }
});

test('without lsof it skips the port cleanup and still starts both servers', () => {
    const box = sandbox({ lsof: false });
    try {
        const r = runSync(box);
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /lsof not found, skipping port cleanup/);
        assert.deepEqual(
            callsOf(box).filter((c) => c.startsWith('npm ')).sort(),
            ['npm run backend:start', 'npm run frontend:dev']
        );
    } finally {
        cleanup(box);
    }
});

test('a listener on either port is stopped with TERM', async () => {
    const box = sandbox();
    const a = listener(box, 8080);
    const b = listener(box, 3002);
    try {
        const r = runSync(box);
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, new RegExp(`Port 8080 in use, stopping PID\\(s\\): ${a.child.pid}`));
        assert.match(r.out, new RegExp(`Port 3002 in use, stopping PID\\(s\\): ${b.child.pid}`));
        assert.equal(await a.ended, 'SIGTERM');
        assert.equal(await b.ended, 'SIGTERM');
        assert.ok(callsOf(box).includes('npm run backend:start'));
    } finally {
        cleanup(box, a.child, b.child);
    }
});

test('a listener that ignores TERM is killed after ten checks', async () => {
    const box = sandbox();
    const stubborn = listener(box, 8080, { ignoreTerm: true });
    try {
        const r = runSync(box);
        assert.equal(r.status, 0, r.out);
        assert.equal(await stubborn.ended, 'SIGKILL');
        const calls = callsOf(box);
        assert.equal(
            calls.filter((c) => c === 'lsof -ti tcp:8080 -sTCP:LISTEN').length,
            11
        );
        assert.equal(calls.filter((c) => c === 'sleep 0.3').length, 10);
    } finally {
        cleanup(box, stubborn.child);
    }
});

test('stopping the script stops both servers', async () => {
    const box = sandbox();
    box.env.STUB_HANG = '1';
    const pidsFile = path.join(box.root, 'npm-pids');
    const script = spawn(BASH, [SCRIPT], { env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    script.stdout.on('data', (d) => (out += d));
    script.stderr.on('data', (d) => (out += d));
    const done = new Promise((resolve) => script.on('exit', resolve));
    try {
        const deadline = Date.now() + 10000;
        const started = () =>
            existsSync(pidsFile) &&
            readFileSync(pidsFile, 'utf8').trim().split('\n').length === 2;
        while (!started()) {
            assert.ok(Date.now() < deadline, 'servers did not start');
            await new Promise((r) => setTimeout(r, 20));
        }
        const pids = readFileSync(pidsFile, 'utf8').trim().split('\n').map(Number);

        script.kill('SIGTERM');
        assert.notEqual(await within(done), 'still running', 'the script did not exit');

        assert.match(out, /Stopping frontend and backend/);
        for (const pid of pids) {
            assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `server ${pid} still running`);
        }
    } finally {
        script.kill('SIGKILL');
        if (existsSync(pidsFile)) {
            for (const pid of readFileSync(pidsFile, 'utf8').trim().split('\n')) {
                try {
                    process.kill(Number(pid), 'SIGKILL');
                } catch {
                    // already gone
                }
            }
        }
        cleanup(box);
    }
});
