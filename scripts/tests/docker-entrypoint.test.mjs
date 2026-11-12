// scripts/docker-entrypoint.sh runs as root on every start of the published
// image. It moves the `app` user to the PUID/PGID the operator asked for, hands
// the data directories to that user, and starts the server as that user
// through su-exec. The image smoke test in docker-publish.yml overrides the
// entrypoint, and the e2e suite starts the backend directly, so nothing else
// runs this script before an operator does.
//
// Each case runs the real script under bash with the system commands it calls
// (id, getent, deluser, delgroup, addgroup, adduser, mkdir, chown, chmod,
// su-exec) replaced by stubs that read and edit throwaway passwd and group
// files and log every call. No root, Docker, or Alpine is needed.
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
    'docker-entrypoint.sh'
);

const STUB = `#!/usr/bin/env bash
# One stub for every command; it acts on its own name.
name=$(basename "$0")
printf '%s\\n' "$name $*" >> "$STUB_ROOT/calls"
if [ "\${STUB_FAIL:-}" = "$name" ]; then exit 1; fi
P="$STUB_ROOT/passwd"
G="$STUB_ROOT/group"
case "$name" in
  id)
    case "$1" in
      -u) awk -F: -v n="$2" '$1==n {print $3; f=1} END {exit !f}' "$P" ;;
      -g) awk -F: -v n="$2" '$1==n {print $4; f=1} END {exit !f}' "$P" ;;
      *) awk -F: -v n="$1" '$1==n {f=1} END {exit !f}' "$P" ;;
    esac ;;
  getent)
    f="$P"; [ "$1" = group ] && f="$G"
    awk -F: -v k="$2" '$3==k {print; f=1} END {exit f ? 0 : 2}' "$f" ;;
  deluser)
    grep -q "^$1:" "$P" || exit 1
    sed -i "/^$1:/d" "$P" ;;
  delgroup)
    grep -q "^$1:" "$G" || exit 1
    sed -i "/^$1:/d" "$G" ;;
  addgroup)
    # addgroup -g GID NAME
    echo "$3:x:$2:" >> "$G" ;;
  adduser)
    # adduser -D -u UID -G GROUP NAME
    gid=$(awk -F: -v n="$5" '$1==n {print $3}' "$G")
    echo "$6:x:$3:$gid::/home/$6:/bin/sh" >> "$P" ;;
esac
# The stub exits with the status of the branch it ran (0 for log-only names).
`;

const COMMANDS = [
    'id',
    'getent',
    'deluser',
    'delgroup',
    'addgroup',
    'adduser',
    'mkdir',
    'chown',
    'chmod',
    'su-exec',
];

// node:22-alpine ships `node` as 1000:1000; the Dockerfile adds app:app at
// APP_UID/APP_GID (1001).
const IMAGE_PASSWD = [
    'root:x:0:0:root:/root:/bin/sh',
    'node:x:1000:1000::/home/node:/bin/sh',
    'app:x:1001:1001::/home/app:/bin/sh',
];
const IMAGE_GROUP = ['root:x:0:', 'node:x:1000:', 'app:x:1001:'];

function run(
    env = {},
    { passwd = IMAGE_PASSWD, group = IMAGE_GROUP, fail } = {}
) {
    const root = mkdtempSync(path.join(tmpdir(), 'docker-entrypoint-'));
    try {
        const stubs = path.join(root, 'bin');
        const stub = path.join(root, 'stub');
        writeFileSync(stub, STUB);
        chmodSync(stub, 0o755);
        mkdirSync(stubs);
        for (const cmd of COMMANDS) symlinkSync(stub, path.join(stubs, cmd));
        writeFileSync(path.join(root, 'passwd'), passwd.join('\n') + '\n');
        writeFileSync(path.join(root, 'group'), group.join('\n') + '\n');
        writeFileSync(path.join(root, 'calls'), '');

        const result = spawnSync('bash', [SCRIPT], {
            env: {
                PATH: `${stubs}:/usr/bin:/bin`,
                STUB_ROOT: root,
                ...(fail ? { STUB_FAIL: fail } : {}),
                ...env,
            },
            encoding: 'utf8',
        });
        const calls = readFileSync(path.join(root, 'calls'), 'utf8')
            .split('\n')
            .filter(Boolean)
            // id and getent are lookups; the assertions are about actions.
            .filter((c) => !/^(id|getent) /.test(c));
        const passwdAfter = readFileSync(path.join(root, 'passwd'), 'utf8');
        return { ...result, calls, passwdAfter };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

const STARTUP = (user, group) => [
    'mkdir -p /app/backend/certs /app/uploads /app/backups',
    `chown -R ${user}:${group} /app/backend /app/scripts`,
    `chown -R ${user}:${group} /app/uploads /app/backups`,
    'chmod 770 /app/backend/certs /app/uploads',
    `su-exec ${user} dumb-init -- /app/backend/cmd/start.sh`,
];

test('with no PUID/PGID it keeps app:app and starts the server as app', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, STARTUP('app', 'app'));
    assert.match(r.stdout, /Target: {2}1001:1001/);
});

test('PUID/PGID equal to the build-time ids change no user or group', () => {
    const r = run({ PUID: '1001', PGID: '1001' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, STARTUP('app', 'app'));
});

test('APP_UID/APP_GID are the fallback when PUID/PGID are unset', () => {
    const r = run(
        { APP_UID: '2000', APP_GID: '2000' },
        {
            passwd: ['root:x:0:0::/root:/bin/sh', 'app:x:2000:2000::/:/bin/sh'],
            group: ['root:x:0:', 'app:x:2000:'],
        }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, STARTUP('app', 'app'));
    assert.match(r.stdout, /Target: {2}2000:2000/);
});

test('new ids with no matching user or group recreate app at those ids', () => {
    const r = run({ PUID: '1500', PGID: '1600' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
        'deluser app',
        'delgroup app',
        'addgroup -g 1600 app',
        'adduser -D -u 1500 -G app app',
        ...STARTUP('app', 'app'),
    ]);
    assert.match(r.passwdAfter, /^app:x:1500:1600:/m);
});

test('a PGID change alone still recreates app in the new group', () => {
    const r = run({ PUID: '1001', PGID: '1600' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
        'deluser app',
        'delgroup app',
        'addgroup -g 1600 app',
        'adduser -D -u 1001 -G app app',
        ...STARTUP('app', 'app'),
    ]);
    assert.match(r.passwdAfter, /^app:x:1001:1600:/m);
});

test('a PGID that names an existing group joins that group', () => {
    const r = run({ PUID: '1500', PGID: '1000' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
        'deluser app',
        'delgroup app',
        'adduser -D -u 1500 -G node app',
        ...STARTUP('app', 'node'),
    ]);
});

test('a PUID that names an existing user runs the server as that user', () => {
    // PUID=1000 PGID=1000 is the common host id and is `node` in the base image.
    const r = run({ PUID: '1000', PGID: '1000' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
        'deluser app',
        'delgroup app',
        ...STARTUP('node', 'node'),
    ]);
});

test('a PUID of 0 runs the server as root, as asked', () => {
    // Pinned so a change to this outcome is a deliberate one.
    const r = run({ PUID: '0', PGID: '0' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.calls, [
        'deluser app',
        'delgroup app',
        ...STARTUP('root', 'root'),
    ]);
});

test('if handing over the data directories fails, the server does not start', () => {
    for (const fail of ['mkdir', 'chown', 'chmod']) {
        const r = run({}, { fail });
        assert.notEqual(r.status, 0, fail);
        assert.ok(
            !r.calls.some((c) => c.startsWith('su-exec ')),
            `${fail} failed but su-exec still ran`
        );
    }
});

test('if creating the user fails, the server does not start', () => {
    for (const fail of ['addgroup', 'adduser']) {
        const r = run({ PUID: '1500', PGID: '1600' }, { fail });
        assert.notEqual(r.status, 0, fail);
        assert.ok(
            !r.calls.some((c) => /^(chown|su-exec) /.test(c)),
            `${fail} failed but the script went on`
        );
    }
});
