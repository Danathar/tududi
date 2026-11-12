// scripts/pg-backup.sh is the documented way to back up the database from
// cron (docs/backups.md). It dumps DATABASE_URL with pg_dump, gzips it to
// <dir>/tududi-<UTC stamp>.sql.gz, and deletes dumps older than
// BACKUP_KEEP_DAYS. No other test or CI job runs it.
//
// Each case runs the real script under bash with a PATH that holds only the
// tools it needs, and a stub pg_dump that writes a known dump (or fails). No
// PostgreSQL server or client is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const SCRIPT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'pg-backup.sh'
);

// Everything the script runs besides pg_dump and bash builtins.
const TOOLS = ['mkdir', 'date', 'gzip', 'mv', 'du', 'cut', 'find', 'sed'];

const URL = 'postgres://tududi:secret@db.invalid:5432/tududi';
const DUMP = '-- PostgreSQL database dump\nCREATE TABLE tasks ();\n';

function realTool(name) {
    for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
        const p = path.join(dir, name);
        if (existsSync(p)) return p;
    }
    throw new Error(`${name} not found`);
}

// pgDump: 'ok' writes DUMP and records its arguments, 'fail' writes part of
// a dump and exits 1, 'missing' leaves pg_dump off PATH.
function setup(pgDump = 'ok') {
    const root = mkdtempSync(path.join(tmpdir(), 'pg-backup-'));
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    for (const t of TOOLS) symlinkSync(realTool(t), path.join(bin, t));
    if (pgDump !== 'missing') {
        const stub = path.join(bin, 'pg_dump');
        writeFileSync(
            stub,
            pgDump === 'ok'
                ? `#!${realTool('bash')}\nprintf '%s\\n' "$@" > "${root}/pg_dump.args"\nprintf '%b' '${DUMP.replace(/\n/g, '\\n')}'\n`
                : `#!${realTool('bash')}\nprintf 'CREATE TABLE half'\necho 'pg_dump: error: connection lost' >&2\nexit 1\n`
        );
        chmodSync(stub, 0o755);
    }
    return { root, bin, dest: path.join(root, 'backups') };
}

function run({ bin }, args, env = {}) {
    return spawnSync(realTool('bash'), [SCRIPT, ...args], {
        env: { PATH: bin, ...env },
        encoding: 'utf8',
    });
}

const dumps = (dir) =>
    existsSync(dir)
        ? readdirSync(dir).filter((f) => /^tududi-.*\.sql\.gz$/.test(f))
        : [];

function withSetup(pgDump, fn) {
    const s = setup(pgDump);
    try {
        fn(s);
    } finally {
        rmSync(s.root, { recursive: true, force: true });
    }
}

test('without DATABASE_URL it refuses and writes nothing', () => {
    withSetup('ok', (s) => {
        const r = run(s, [s.dest]);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /DATABASE_URL is not set/);
        assert.equal(existsSync(s.dest), false);
    });
});

test('without pg_dump on PATH it refuses and writes nothing', () => {
    withSetup('missing', (s) => {
        const r = run(s, [s.dest], { DATABASE_URL: URL });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /pg_dump not found/);
        assert.equal(existsSync(s.dest), false);
    });
});

test('a good dump lands as one gzipped tududi-<UTC stamp>.sql.gz', () => {
    withSetup('ok', (s) => {
        const r = run(s, [s.dest], { DATABASE_URL: URL });
        assert.equal(r.status, 0, r.stderr);

        const files = readdirSync(s.dest);
        assert.equal(files.length, 1, files.join(', '));
        assert.match(files[0], /^tududi-\d{8}T\d{6}Z\.sql\.gz$/);
        const body = gunzipSync(readFileSync(path.join(s.dest, files[0])));
        assert.equal(body.toString('utf8'), DUMP);
        assert.match(r.stdout, new RegExp(`^Wrote ${s.dest}/${files[0]} `));

        // --no-owner/--no-acl keep the dump restorable into any role's
        // database; the URL is the last argument.
        const args = readFileSync(path.join(s.root, 'pg_dump.args'), 'utf8');
        assert.equal(args, `--no-owner\n--no-acl\n${URL}\n`);
    });
});

test('a failed dump exits non-zero and leaves no file that looks like a backup', () => {
    withSetup('fail', (s) => {
        const r = run(s, [s.dest], { DATABASE_URL: URL });
        assert.notEqual(r.status, 0);
        assert.deepEqual(dumps(s.dest), []);
        assert.doesNotMatch(r.stdout, /^Wrote /m);
    });
});

test('with no argument it writes to BACKUP_DIR', () => {
    withSetup('ok', (s) => {
        const r = run(s, [], { DATABASE_URL: URL, BACKUP_DIR: s.dest });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(dumps(s.dest).length, 1);
    });
});

function seed(dest, files) {
    mkdirSync(dest, { recursive: true });
    const now = Date.now() / 1000;
    for (const [name, ageDays] of Object.entries(files)) {
        const p = path.join(dest, name);
        writeFileSync(p, 'old');
        const t = now - ageDays * 86400;
        utimesSync(p, t, t);
    }
}

test('it prunes dumps older than 14 days and keeps everything else', () => {
    withSetup('ok', (s) => {
        seed(s.dest, {
            'tududi-20260101T030000Z.sql.gz': 30,
            'tududi-20260102T030000Z.sql.gz': 16,
            'tududi-20260103T030000Z.sql.gz': 10,
            'tududi-20260104T030000Z.sql.gz': 3,
            'notes.txt': 30,
            'other-20260101T030000Z.sql.gz': 30,
        });
        const r = run(s, [s.dest], { DATABASE_URL: URL });
        assert.equal(r.status, 0, r.stderr);

        const left = readdirSync(s.dest).sort();
        assert.ok(!left.includes('tududi-20260101T030000Z.sql.gz'));
        assert.ok(!left.includes('tududi-20260102T030000Z.sql.gz'));
        for (const kept of [
            'tududi-20260103T030000Z.sql.gz',
            'tududi-20260104T030000Z.sql.gz',
            'notes.txt',
            'other-20260101T030000Z.sql.gz',
        ]) {
            assert.ok(left.includes(kept), kept);
        }
        assert.equal(dumps(s.dest).length, 3);
        assert.match(
            r.stdout,
            new RegExp(
                `^Pruned ${s.dest}/tududi-20260101T030000Z\\.sql\\.gz$`,
                'm'
            )
        );
    });
});

test('BACKUP_KEEP_DAYS sets how long dumps are kept', () => {
    withSetup('ok', (s) => {
        seed(s.dest, {
            'tududi-20260101T030000Z.sql.gz': 40,
            'tududi-20260102T030000Z.sql.gz': 20,
        });
        const r = run(s, [s.dest], {
            DATABASE_URL: URL,
            BACKUP_KEEP_DAYS: '30',
        });
        assert.equal(r.status, 0, r.stderr);
        const left = dumps(s.dest);
        assert.ok(!left.includes('tududi-20260101T030000Z.sql.gz'));
        assert.ok(left.includes('tududi-20260102T030000Z.sql.gz'));
        assert.equal(left.length, 2);
    });
});

test('a failed dump prunes nothing', () => {
    withSetup('fail', (s) => {
        seed(s.dest, { 'tududi-20260101T030000Z.sql.gz': 30 });
        const r = run(s, [s.dest], { DATABASE_URL: URL });
        assert.notEqual(r.status, 0);
        assert.deepEqual(dumps(s.dest), ['tududi-20260101T030000Z.sql.gz']);
    });
});
