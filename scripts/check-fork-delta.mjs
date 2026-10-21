#!/usr/bin/env node
// Checks docs/fork-delta.md against the files this fork actually changes.
// An upstream-owned file is one the upstream commit has; every such file that
// HEAD modifies or deletes must be named in a ledger row, and every file a row
// names must still differ from upstream. Exits 1 on either kind of drift.
// Usage: node scripts/check-fork-delta.mjs [<upstream-ref>] [--ledger <file>]
// With no ref, the upstream parent of the last `chore: sync upstream` merge.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const LEDGER = 'docs/fork-delta.md';

/**
 * The file paths each "Changes carried" row names, as a map file -> row labels.
 * A row is a table line starting with `| [#`; its second cell lists the files
 * as backticked paths.
 * @param {string} text the ledger's markdown
 * @returns {Map<string, string[]>}
 */
export function parseLedger(text) {
    const files = new Map();
    for (const line of text.split('\n')) {
        if (!line.startsWith('| [#')) continue;
        const cells = line.split('|');
        const label =
            cells[1].trim().match(/^\[(#\d+)\]/)?.[1] ?? cells[1].trim();
        for (const [, file] of (cells[2] ?? '').matchAll(/`([^`]+)`/g)) {
            files.set(file, [...(files.get(file) ?? []), label]);
        }
    }
    return files;
}

/**
 * Upstream-owned files HEAD changes, from `git diff --name-status --no-renames`
 * output. Added files are the fork's own and are left out.
 * @param {string} nameStatus
 * @returns {string[]}
 */
export function parseDelta(nameStatus) {
    return nameStatus
        .split('\n')
        .map((line) => line.split('\t'))
        .filter(([status, file]) => file && (status === 'M' || status === 'D'))
        .map(([, file]) => file);
}

/**
 * @param {Map<string, string[]>} ledger from parseLedger
 * @param {string[]} delta from parseDelta
 * @returns {{missing: string[], stale: string[]}} files changed but not in the
 *   ledger, and ledger files that no longer differ from upstream
 */
export function compare(ledger, delta) {
    const changed = new Set(delta);
    return {
        missing: [...changed].filter((f) => !ledger.has(f)).sort(),
        stale: [...ledger.keys()]
            .filter((f) => !changed.has(f))
            .sort()
            .map((f) => `${f} (${ledger.get(f).join(', ')})`),
    };
}

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * The upstream commit the newest sync merge took: its second parent. Matched
 * on the subject, because the PR merge that lands a sync carries the same
 * words in its body and its second parent is the fork's sync branch.
 * @param {string} log `git log --merges --format=%P%x09%s` output, newest first
 * @returns {string|undefined}
 */
export function lastSyncedUpstream(log) {
    for (const line of log.split('\n')) {
        const [parents, subject = ''] = line.split('\t');
        if (subject.startsWith('chore: sync upstream')) {
            return parents.split(' ')[1];
        }
    }
    return undefined;
}

function main(argv) {
    const i = argv.indexOf('--ledger');
    const ledgerPath = i >= 0 ? argv[i + 1] : LEDGER;
    const rest = argv.filter((_, j) => i < 0 || (j !== i && j !== i + 1));
    const cwd = process.cwd();
    const ref =
        rest[0] ??
        lastSyncedUpstream(git(['log', '--merges', '--format=%P%x09%s'], cwd));
    if (!ref) {
        console.error(
            'No `chore: sync upstream` merge found; pass the upstream ref.'
        );
        process.exit(2);
    }
    const ledger = parseLedger(readFileSync(resolve(cwd, ledgerPath), 'utf8'));
    const delta = parseDelta(
        git(['diff', '--name-status', '--no-renames', ref, 'HEAD'], cwd)
    );
    const { missing, stale } = compare(ledger, delta);
    if (missing.length || stale.length) {
        console.error(
            `${ledgerPath} does not match the fork's changes against ${ref}:`
        );
        for (const f of missing) {
            console.error(
                `  - not in any row (add it to the PR that changed it): ${f}`
            );
        }
        for (const f of stale) {
            console.error(`  - same as upstream (drop it from its row): ${f}`);
        }
        process.exit(1);
    }
    console.log(
        `${ledgerPath} covers all ${delta.length} upstream files changed against ${ref}.`
    );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main(process.argv.slice(2));
}
