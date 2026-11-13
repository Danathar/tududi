// Every script in scripts/ and every hook in .claude/hooks/ has a test file of
// its own. Shell scripts are not measured by Jest or the mutation check, so an
// untested one never shows up in a coverage number: the release script, the
// image entrypoint and the cron backup each went untested until someone
// noticed (#68, #587, #589, #597). A test file named after the script makes
// the gap fail here instead.
//
// The test file is scripts/tests/<name>.test.mjs or <name>-<part>.test.mjs
// (hooks: .claude/hooks/tests/), and it must name the script, so a file that
// only shares the prefix does not count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
);

const SCRIPT_DIRS = [
    ['scripts', 'scripts/tests'],
    ['.claude/hooks', '.claude/hooks/tests'],
];

const SCRIPT = /\.(sh|js|mjs|cjs)$/;

function filesIn(dir) {
    const abs = path.join(repoRoot, dir);
    return readdirSync(abs).filter((name) =>
        statSync(path.join(abs, name)).isFile()
    );
}

export function untestedScripts() {
    const missing = [];
    for (const [dir, testDir] of SCRIPT_DIRS) {
        const tests = filesIn(testDir).filter((f) => f.endsWith('.test.mjs'));
        for (const script of filesIn(dir).filter((f) => SCRIPT.test(f))) {
            const stem = script.replace(SCRIPT, '');
            const own = tests.filter(
                (t) => t === `${stem}.test.mjs` || t.startsWith(`${stem}-`)
            );
            const names = own.some((t) =>
                readFileSync(path.join(repoRoot, testDir, t), 'utf8').includes(
                    script
                )
            );
            if (!names) missing.push(`${dir}/${script}`);
        }
    }
    return missing;
}

test('the check sees the scripts it is meant to cover', () => {
    for (const [dir] of SCRIPT_DIRS) {
        assert.ok(
            filesIn(dir).some((f) => SCRIPT.test(f)),
            `no scripts found in ${dir}; has it moved?`
        );
    }
});

test('every script and hook has its own test file that names it', () => {
    assert.deepEqual(
        untestedScripts(),
        [],
        'add scripts/tests/<name>.test.mjs (or .claude/hooks/tests/) that runs each of these'
    );
});
