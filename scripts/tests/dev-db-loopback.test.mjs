// The development database's superuser name and password are both in this
// repository. A published port with no host address binds every interface, and
// Docker's own firewall rules usually get past the host's firewall, so anyone
// on the developer's network could log in. These tests keep the compose file
// and the documented `docker run` commands on the loopback address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const DOCS_WITH_DOCKER_RUN = ['docs/16-postgresql.md', 'docs/testing.md'];

test('docker-compose.dev.yml publishes the database on loopback only', () => {
    const published = read('docker-compose.dev.yml')
        .split('\n')
        .filter((line) => /^\s*- .*:5432"?\s*$/.test(line));

    assert.equal(published.length, 1);
    assert.match(published[0], /- "127\.0\.0\.1:/);
});

for (const page of DOCS_WITH_DOCKER_RUN) {
    test(`${page} keeps its docker run example on loopback`, () => {
        const flags = read(page).match(/-p \S*:5432\b/g) ?? [];

        assert.ok(flags.length > 0, 'expected a docker run example');
        for (const flag of flags) {
            assert.equal(flag, '-p 127.0.0.1:5432:5432');
        }
    });
}
