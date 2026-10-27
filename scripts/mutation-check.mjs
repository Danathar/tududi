#!/usr/bin/env node
// Mutation check on the lines a pull request changes. Turns
// `git diff -U0 <base>...HEAD` into StrykerJS `--mutate file:start-end`
// ranges for the backend and frontend Jest suites and for the fork's own
// tooling (scripts/ and the Bash guard hook, tested with `node --test`), runs
// Stryker once per suite, and reports every mutant the tests did not notice
// (status Survived or NoCoverage) that is not an accepted survivor in
// .mutation-survivors.json.
// Exits 0 when there is nothing new, 1 on a new survivor, 2 when the check
// could not run (bad arguments, git or Stryker failure, unreadable ledger).
// A run stopped by --budget-minutes exits 0 unless a run that finished
// before it found a new survivor.
// Usage: node scripts/mutation-check.mjs [--base <ref>] [--ledger <file>]
//        [--root <dir>] [--budget-minutes <n>] [--dry-run]
//        [--report <stryker json report>]...
// --dry-run prints the ranges and stops. --report skips git and Stryker and
// checks existing Stryker JSON reports against the ledger.
// --budget-minutes is a wall-clock limit for the Stryker runs together
// (#435). A change to a file most of the backend loads can keep Stryker busy
// past the CI job's timeout, and a job cut off by its timeout fails the check
// even though the job is advisory. At the budget the Stryker run in progress
// is stopped with its whole process group (SIGTERM, then SIGKILL after a
// grace period), the suites after it are not started, and a notice says the
// result is incomplete. Without the option there is no limit.
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { constants } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

export const LEDGER = '.mutation-survivors.json';
export const CONFIG = 'stryker.config.mjs';
export const SURVIVING = new Set(['Survived', 'NoCoverage']);

// Source the backend Jest suite (backend/jest.config.js) tests. Tests,
// migrations, seeders, scripts, config and models/index.js are not mutated.
const BACKEND_SOURCE = /^backend\/(?:modules|services|middleware|models|utils|shared)\/.+\.js$/;
// Source the frontend Jest suite (root jest.config.js) tests.
const FRONTEND_SOURCE = /^frontend\/.+\.(?:js|jsx|ts|tsx)$/;
// The fork's tooling. Stryker runs these with its built-in `command` test
// runner: a script against its own scripts/tests/<name>.test.mjs and
// <name>-cli.test.mjs, the guard hook against HOOK_TESTS (#437).
const SCRIPT_SOURCE = /^scripts\/([^/]+)\.m?js$/;
const HOOK_SOURCE = /^\.claude\/hooks\/[^/]+\.mjs$/;
// The tests that exercise the guard hook and its shared shell reader.
// .claude/hooks/tests/shell-reader.test.mjs is left out: it pins the
// reader's sha256, so it fails for every mutant and would count each one as
// killed.
export const HOOK_TESTS = [
    '.claude/hooks/tests/guard-bash.test.mjs',
    '.claude/hooks/tests/gate-refusal-corpus.test.mjs',
];
const NOT_SOURCE = [
    /(?:^|\/)__tests__\//,
    /(?:^|\/)__mocks__\//,
    /(?:^|\/)tests?\//,
    /\.(?:test|spec)\.[jt]sx?$/,
    /\.d\.ts$/,
    // Translation strings, including upstream's landing-site copy under
    // backend/modules/landing/locales/ that AGENTS.md says to leave alone.
    /(?:^|\/)locales\//,
    /^backend\/models\/index\.js$/,
    /^frontend\/index\.tsx$/,
];

/**
 * Which suite mutates this file, or null when it is not source Stryker
 * should touch.
 * @param {string} file repository-relative path
 * @returns {string|null} `backend` or `frontend` (Jest), `hooks`, or
 *   `scripts-<name>` for scripts/<name>.mjs
 */
export function projectFor(file) {
    if (NOT_SOURCE.some((re) => re.test(file))) return null;
    if (BACKEND_SOURCE.test(file)) return 'backend';
    if (FRONTEND_SOURCE.test(file)) return 'frontend';
    if (HOOK_SOURCE.test(file)) return 'hooks';
    const script = file.match(SCRIPT_SOURCE);
    if (script) return `scripts-${script[1]}`;
    return null;
}

/**
 * The test files a tooling suite runs, or null for a Jest suite. A script
 * with no test file of its own runs every scripts/tests file, since another
 * script's tests may still load it.
 * @param {string} project from projectFor
 * @param {string[]} scriptTests the scripts/tests/*.test.mjs files that exist
 * @returns {string[]|null}
 */
export function testsFor(project, scriptTests) {
    if (project === 'backend' || project === 'frontend') return null;
    if (project === 'hooks') return [...HOOK_TESTS];
    const name = project.slice('scripts-'.length);
    const own = [`scripts/tests/${name}.test.mjs`, `scripts/tests/${name}-cli.test.mjs`].filter((f) =>
        scriptTests.includes(f)
    );
    return own.length ? own : [...scriptTests];
}

function unquote(path) {
    if (!path.startsWith('"')) return path;
    return JSON.parse(path);
}

/**
 * Added or changed line ranges per file from `git diff -U0` output. Hunks
 * that only delete lines add nothing: there is no new line to mutate.
 * Adjacent or overlapping ranges are merged.
 * @param {string} diff
 * @returns {Map<string, {start: number, end: number}[]>} 1-based, inclusive
 */
export function parseDiff(diff) {
    const out = new Map();
    let file = null;
    // Lines still owed to the current hunk, so an added line that itself
    // starts with "++ " or "@@ " is read as content, not as a header.
    let oldLeft = 0;
    let newLeft = 0;
    for (const line of diff.split('\n')) {
        if (oldLeft > 0 || newLeft > 0) {
            if (line.startsWith('-')) oldLeft--;
            else if (line.startsWith('+')) newLeft--;
            else if (line.startsWith(' ')) {
                oldLeft--;
                newLeft--;
            }
            continue;
        }
        if (line.startsWith('+++ ')) {
            const target = unquote(line.slice(4));
            file = target === '/dev/null' ? null : target.replace(/^b\//, '');
            continue;
        }
        const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        if (!hunk) continue;
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
        if (file === null) continue;
        const start = Number(hunk[2]);
        const count = newLeft;
        if (count === 0) continue;
        const ranges = out.get(file) ?? [];
        ranges.push({ start, end: start + count - 1 });
        out.set(file, ranges);
    }
    for (const [f, ranges] of out) {
        ranges.sort((a, b) => a.start - b.start);
        const merged = [];
        for (const r of ranges) {
            const last = merged.at(-1);
            if (last && r.start <= last.end + 1) {
                last.end = Math.max(last.end, r.end);
            } else {
                merged.push({ ...r });
            }
        }
        out.set(f, merged);
    }
    return out;
}

/**
 * Stryker `--mutate` entries per suite, for the files that suite tests. The
 * Jest suites are always present; a tooling suite only when it has entries.
 * @param {Map<string, {start: number, end: number}[]>} changed from parseDiff
 * @returns {{backend: string[], frontend: string[], [tooling: string]: string[]}}
 */
export function mutateRanges(changed) {
    const out = { backend: [], frontend: [] };
    for (const [file, ranges] of [...changed].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
    )) {
        const project = projectFor(file);
        if (!project) continue;
        out[project] ??= [];
        for (const r of ranges) out[project].push(`${file}:${r.start}-${r.end}`);
    }
    return out;
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The source text a mutant replaced. Report locations are 1-based lines and
 * 1-based columns, end exclusive.
 */
export function originalText(source, location) {
    const lines = source.split('\n');
    const { start, end } = location;
    if (start.line === end.line) {
        return lines[start.line - 1]?.slice(start.column - 1, end.column - 1) ?? '';
    }
    const parts = [lines[start.line - 1]?.slice(start.column - 1) ?? ''];
    for (let l = start.line; l < end.line - 1; l++) parts.push(lines[l] ?? '');
    parts.push(lines[end.line - 1]?.slice(0, end.column - 1) ?? '');
    return parts.join('\n');
}

/**
 * Surviving mutants in a Stryker JSON report (mutation-testing-report-schema).
 * @param {object} report parsed JSON report
 * @param {string} root repository root, to make absolute report paths relative
 */
export function survivors(report, root = process.cwd()) {
    const out = [];
    for (const [key, entry] of Object.entries(report?.files ?? {})) {
        const file = (isAbsolute(key) ? relative(root, key) : key).replace(/\\/g, '/');
        for (const m of entry.mutants ?? []) {
            if (!SURVIVING.has(m.status)) continue;
            out.push({
                file,
                line: m.location.start.line,
                column: m.location.start.column,
                status: m.status,
                mutator: m.mutatorName,
                original: originalText(entry.source ?? '', m.location),
                replacement: m.replacement ?? '',
            });
        }
    }
    return out.sort((a, b) =>
        a.file === b.file ? a.line - b.line || a.column - b.column : a.file < b.file ? -1 : 1
    );
}

/**
 * Check the ledger's shape. Every entry names the file, mutator, original and
 * replacement text, and a reason it is accepted.
 * @returns {string[]} problems; empty when the ledger is usable
 */
export function validateLedger(ledger) {
    if (!ledger || !Array.isArray(ledger.survivors)) {
        return ['ledger has no "survivors" array'];
    }
    const problems = [];
    ledger.survivors.forEach((e, i) => {
        for (const key of ['file', 'mutator', 'original', 'replacement', 'reason']) {
            if (typeof e?.[key] !== 'string' || (key !== 'replacement' && !e[key].trim())) {
                problems.push(`survivors[${i}]: "${key}" must be a non-empty string`);
            }
        }
    });
    return problems;
}

/**
 * A ledger entry accepts a survivor when file, mutator, original text and
 * replacement all match (whitespace collapsed). Line numbers are not part of
 * the match, so an entry survives edits elsewhere in the file.
 */
export function isAccepted(survivor, ledger) {
    return ledger.survivors.some(
        (e) =>
            e.file === survivor.file &&
            e.mutator === survivor.mutator &&
            norm(e.original) === norm(survivor.original) &&
            norm(e.replacement) === norm(survivor.replacement)
    );
}

/**
 * @returns {{fresh: object[], accepted: object[]}}
 */
export function evaluate(found, ledger) {
    const fresh = [];
    const accepted = [];
    for (const s of found) (isAccepted(s, ledger) ? accepted : fresh).push(s);
    return { fresh, accepted };
}

export function formatSurvivor(s) {
    const one = (t) => norm(t).slice(0, 80);
    return `${s.file}:${s.line}:${s.column} ${s.mutator} (${s.status}): \`${one(s.original)}\` -> \`${one(s.replacement)}\``;
}

export function ledgerEntry(s) {
    return {
        file: s.file,
        mutator: s.mutator,
        original: s.original,
        replacement: s.replacement,
        reason: 'TODO: why this survivor is equivalent or harmless',
    };
}

/**
 * The one-line notice for a run that hit its time budget.
 * @param {{minutes: number, cut: string|null, skipped: string[]}} stopped the
 *   budget, the suite stopped part way (if any) and the suites never started
 */
export function budgetNotice(stopped) {
    const left = [];
    if (stopped.cut) left.push(`${stopped.cut} was stopped part way and none of its mutants are counted`);
    if (stopped.skipped.length) left.push(`${stopped.skipped.join(', ')} not run`);
    return (
        `mutation check incomplete — time budget (${stopped.minutes} min) reached, no result` +
        (left.length ? `: ${left.join('; ')}` : '')
    );
}

function fail(message) {
    console.error(`mutation-check: ${message}`);
    process.exit(2);
}

function parseArgs(argv) {
    const opts = {
        base: 'origin/main',
        ledger: LEDGER,
        root: process.cwd(),
        budgetMinutes: null,
        dryRun: false,
        reports: [],
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const value = () => {
            const v = argv[++i];
            if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`);
            return v;
        };
        if (a === '--base') opts.base = value();
        else if (a === '--ledger') opts.ledger = value();
        else if (a === '--root') opts.root = value();
        else if (a === '--budget-minutes') {
            const v = value();
            opts.budgetMinutes = Number(v);
            if (!/^\d+(\.\d+)?$/.test(v) || !(opts.budgetMinutes > 0)) {
                fail(`--budget-minutes needs a positive number of minutes, got ${v}`);
            }
        } else if (a === '--report') opts.reports.push(value());
        else if (a === '--dry-run') opts.dryRun = true;
        else fail(`unknown argument ${a}`);
    }
    opts.root = resolve(opts.root);
    return opts;
}

function readJson(path, what) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        fail(`cannot read ${what} ${path}: ${e.message}`);
    }
}

function changedRanges(root, base) {
    try {
        const diff = execFileSync(
            'git',
            ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--diff-filter=AM', `${base}...HEAD`],
            { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
        );
        return mutateRanges(parseDiff(diff));
    } catch (e) {
        fail(`git diff against ${base} failed: ${e.message}`);
    }
}

// How long Stryker gets to stop by itself after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 5000;

/**
 * Stryker for one suite. With a limit (milliseconds) it runs in a process
 * group of its own and is stopped with that group, the Jest workers it starts
 * included, if it is still running when the limit is up.
 * @returns {Promise<{report: object, cut: boolean}>} `cut` when the limit
 *   stopped it; none of its mutants are counted then
 */
async function runStryker(root, project, mutate, limitMs = null) {
    const bin = resolve(root, 'node_modules/@stryker-mutator/core/bin/stryker.js');
    if (!existsSync(bin)) fail(`StrykerJS is not installed (${bin}); run npm install`);
    const report = resolve(root, `reports/mutation/${project}.json`);
    rmSync(report, { force: true });
    console.log(`\n== ${project}: mutating ${mutate.length} range(s)`);
    for (const m of mutate) console.log(`   ${m}`);
    const env = { ...process.env, MUTATION_PROJECT: project };
    if (project === 'backend') env.NODE_ENV = 'test';
    const scriptTests = existsSync(resolve(root, 'scripts/tests'))
        ? readdirSync(resolve(root, 'scripts/tests'))
              .filter((f) => f.endsWith('.test.mjs'))
              .map((f) => `scripts/tests/${f}`)
        : [];
    const tests = testsFor(project, scriptTests);
    // A bare `node --test` would run every test file it finds instead.
    if (tests && !tests.length) fail(`no node --test files to run for ${project}`);
    // Set for a tooling suite only; a Jest suite never inherits one.
    if (tests) env.MUTATION_TEST_COMMAND = `node --test ${tests.join(' ')}`;
    else delete env.MUTATION_TEST_COMMAND;
    // Without a limit Stryker stays in our process group, so Ctrl-C in a
    // terminal reaches it as usual.
    const detached = limitMs !== null;
    let child;
    let timer = null;
    let cut = false;
    let interrupted = null;
    const killGroup = (signal) => {
        try {
            process.kill(-child.pid, signal);
        } catch {
            // The group is already gone.
        }
    };
    const stop = (signal) => {
        killGroup(signal);
        clearTimeout(timer);
        timer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    // A group of its own no longer gets the terminal's Ctrl-C or the
    // runner's cancel, so pass those on.
    const onSignal = (signal) => {
        interrupted = signal;
        stop(signal);
    };
    let status;
    let signal;
    try {
        child = spawn(process.execPath, [bin, 'run', CONFIG, '--mutate', mutate.join(',')], {
            cwd: root,
            env,
            stdio: 'inherit',
            detached,
        });
        if (detached) {
            timer = setTimeout(() => {
                cut = true;
                stop('SIGTERM');
            }, limitMs);
            process.on('SIGINT', onSignal);
            process.on('SIGTERM', onSignal);
        }
        [status, signal] = await once(child, 'close');
    } catch (e) {
        // spawn throws for some failures (E2BIG: the ranges do not fit in one
        // argument), and `once` rejects on the 'error' event of the others.
        fail(`cannot start Stryker (${project}): ${e.message}`);
    } finally {
        clearTimeout(timer);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
    }
    // Processes Stryker started can outlive it; end what is left of the group.
    if (detached) killGroup('SIGKILL');
    if (interrupted) {
        console.error(`mutation-check: stopped by ${interrupted}`);
        process.exit(128 + constants.signals[interrupted]);
    }
    // Stryker writes its report at the end, so a run that was cut off has none.
    if (cut) return { report: { files: {} }, cut };
    if (status !== 0) fail(`Stryker (${project}) exited with ${status ?? signal}`);
    // Stryker writes no report when the ranges hold no mutable code.
    return { report: existsSync(report) ? readJson(report, 'Stryker report') : { files: {} }, cut };
}

/**
 * The step-summary text: the new survivors and how to resolve them, and the
 * budget notice when the time budget stopped the run.
 */
export function summarize(fresh, accepted, stopped = null) {
    const lines = ['## Mutation check on changed lines', ''];
    if (stopped) lines.push(`**${budgetNotice(stopped)}**`, '');
    if (!fresh.length) {
        lines.push(
            stopped
                ? `No new surviving mutants in the runs that finished (${accepted.length} accepted in the ledger).`
                : `No new surviving mutants (${accepted.length} accepted in the ledger).`
        );
    } else {
        lines.push(
            `${fresh.length} changed line(s) can be broken without any test failing:`,
            '',
            ...fresh.map((s) => `- ${formatSurvivor(s)}`),
            '',
            `Add a test that fails on each, or, if a survivor is equivalent or harmless, add it to \`${LEDGER}\` with a reason.`
        );
    }
    return lines.join('\n');
}

async function main(argv) {
    const started = Date.now();
    const opts = parseArgs(argv);
    const ledgerPath = resolve(opts.root, opts.ledger);
    const ledger = existsSync(ledgerPath) ? readJson(ledgerPath, 'ledger') : { survivors: [] };
    const problems = validateLedger(ledger);
    if (problems.length) fail(`${opts.ledger} is malformed:\n  ${problems.join('\n  ')}`);

    const reports = [];
    let stopped = null;
    if (opts.reports.length) {
        for (const p of opts.reports) reports.push(readJson(resolve(opts.root, p), 'Stryker report'));
    } else {
        const ranges = changedRanges(opts.root, opts.base);
        const queue = Object.keys(ranges).filter((p) => ranges[p].length);
        if (opts.dryRun) {
            console.log(JSON.stringify(ranges, null, 2));
            return;
        }
        if (!queue.length) {
            console.log(`No source lines changed against ${opts.base}; nothing to mutate.`);
            return;
        }
        const budgetMs = opts.budgetMinutes === null ? null : opts.budgetMinutes * 60_000;
        while (queue.length) {
            const project = queue.shift();
            const left = budgetMs === null ? null : started + budgetMs - Date.now();
            if (left !== null && left <= 0) {
                stopped = { minutes: opts.budgetMinutes, cut: null, skipped: [project, ...queue] };
                break;
            }
            const result = await runStryker(opts.root, project, ranges[project], left);
            reports.push(result.report);
            if (result.cut) {
                stopped = { minutes: opts.budgetMinutes, cut: project, skipped: [...queue] };
                break;
            }
        }
    }

    const { fresh, accepted } = evaluate(
        reports.flatMap((r) => survivors(r, opts.root)),
        ledger
    );
    const text = summarize(fresh, accepted, stopped);
    console.log(`\n${text}`);
    if (stopped) {
        console.log(`\n${budgetNotice(stopped)}`);
        if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning::${budgetNotice(stopped)}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
        try {
            appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
        } catch {
            // The summary is a convenience; the exit status is the result.
        }
    }
    if (fresh.length) {
        console.log('\nLedger entries for these survivors, if they are accepted:');
        console.log(JSON.stringify(fresh.map(ledgerEntry), null, 4));
        process.exit(1);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    await main(process.argv.slice(2));
}
