// scripts/test-docker-build.sh (`npm run docker:test-build`) builds the image,
// starts it with a fixed admin login, checks /api/health, and then stops it or
// leaves it running. Its password is in this repository, so the container
// must be reachable from this machine only: a published port with no host
// address binds every interface, and Docker's own firewall rules usually get
// past the host's firewall (the same exposure #554 fixed for the development
// database).
//
// Each case runs the real script with docker, curl and sleep replaced by
// stubs that log their arguments. No Docker daemon is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'test-docker-build.sh'
);

const STUB = `#!/bin/sh
name=$(basename "$0")
echo "$name $*" >> "$STUB_ROOT/calls"
if [ "$name" = docker ] && [ "$1" = logs ]; then echo "container log line"; fi
if [ "$name" = docker ] && [ "\${STUB_FAIL:-}" = "$1" ]; then exit 1; fi
if [ "$name" = curl ] && [ -n "\${STUB_UNHEALTHY:-}" ]; then exit 22; fi
exit 0
`;

function run(args = [], { answer = 'n\n', env = {} } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'test-docker-build-'));
    try {
        const bin = path.join(root, 'bin');
        mkdirSync(bin);
        const stub = path.join(root, 'stub');
        writeFileSync(stub, STUB);
        chmodSync(stub, 0o755);
        for (const cmd of ['docker', 'curl', 'sleep']) {
            symlinkSync(stub, path.join(bin, cmd));
        }
        writeFileSync(path.join(root, 'calls'), '');
        const r = spawnSync('bash', [SCRIPT, ...args], {
            env: { PATH: `${bin}:/usr/bin:/bin`, STUB_ROOT: root, ...env },
            input: answer,
            encoding: 'utf8',
            timeout: 30000,
        });
        const calls = readFileSync(path.join(root, 'calls'), 'utf8')
            .split('\n')
            .filter(Boolean);
        return { status: r.status, out: r.stdout + r.stderr, calls };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const RUN_LATEST =
    'docker run -d --name tududi-test-latest -p 127.0.0.1:3003:3002 ' +
    '-e TUDUDI_USER_EMAIL=test@example.com -e TUDUDI_USER_PASSWORD=testpass123 ' +
    '-e NODE_ENV=production tududi-test:latest';

test('publishes the test container on the loopback address only', () => {
    const { calls } = run();
    const runs = calls.filter((c) => c.startsWith('docker run '));
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].match(/ -p \S+/g), [' -p 127.0.0.1:3003:3002']);
});

test('a healthy build answered "n" is checked, then stopped and removed', () => {
    const r = run();
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.calls, [
        'docker stop tududi-test-latest',
        'docker rm tududi-test-latest',
        'docker build -t tududi-test:latest .',
        RUN_LATEST,
        'sleep 15',
        'curl -f http://localhost:3003/api/health',
        'docker stop tududi-test-latest',
        'docker rm tududi-test-latest',
    ]);
    assert.match(r.out, /Health check passed for latest/);
    assert.match(r.out, /Cleaned up/);
});

test('a healthy build answered "y" is left running', () => {
    const r = run([], { answer: 'y' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.calls.at(-1), 'curl -f http://localhost:3003/api/health');
    assert.match(r.out, /Container tududi-test-latest still running/);
});

test('the version argument names the image and the container', () => {
    const r = run(['v2.1.0']);
    assert.equal(r.status, 0, r.out);
    assert.ok(r.calls.includes('docker build -t tududi-test:v2.1.0 .'));
    assert.ok(
        r.calls.some(
            (c) =>
                c.startsWith('docker run -d --name tududi-test-v2.1.0 ') &&
                c.endsWith(' tududi-test:v2.1.0')
        )
    );
});

test('a failed health check prints the logs, cleans up and exits 1', () => {
    const r = run([], { env: { STUB_UNHEALTHY: '1' } });
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(r.calls.slice(-4), [
        'curl -f http://localhost:3003/api/health',
        'docker logs tududi-test-latest',
        'docker stop tududi-test-latest',
        'docker rm tududi-test-latest',
    ]);
    assert.match(r.out, /Health check failed for latest/);
    assert.match(r.out, /container log line/);
});

test('a failed build stops before starting anything', () => {
    const r = run([], { env: { STUB_FAIL: 'build' } });
    assert.notEqual(r.status, 0);
    assert.equal(r.calls.at(-1), 'docker build -t tududi-test:latest .');
});
