#!/usr/bin/env node
// Compares Jest json-summary coverage against the floors in
// .coverage-thresholds.json. Exits 1 when any metric is below its floor or a
// summary file is missing. Usage: node scripts/coverage-gate.mjs [--config <file>] [--root <dir>]
import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const METRICS = ['lines', 'statements', 'functions', 'branches'];

/**
 * @param {object} thresholds parsed .coverage-thresholds.json
 * @param {Record<string, object|null>} summaries area -> parsed coverage-summary.json (null = missing)
 * @returns {{rows: object[], failures: string[]}}
 */
export function evaluate(thresholds, summaries) {
    const rows = [];
    const failures = [];
    for (const [area, cfg] of Object.entries(thresholds.areas)) {
        const total = summaries[area]?.total;
        if (!total) {
            const under = cfg.include ? ` for files under ${cfg.include.join(', ')}` : '';
            failures.push(`${area}: no coverage summary at ${cfg.summary}${under}`);
            continue;
        }
        for (const metric of METRICS) {
            const floor = cfg.floor[metric];
            const pct = total[metric]?.pct;
            if (typeof floor !== 'number') {
                failures.push(`${area}.${metric}: no floor configured`);
                continue;
            }
            if (typeof pct !== 'number') {
                failures.push(`${area}.${metric}: not present in summary`);
                continue;
            }
            const ok = pct >= floor;
            rows.push({ area, metric, pct, floor, ok });
            if (!ok) {
                failures.push(
                    `${area}.${metric}: ${pct}% is below the ${floor}% floor`
                );
            }
        }
    }
    return { rows, failures };
}

export function renderTable(rows) {
    const lines = [
        '| area | metric | measured | floor | status |',
        '| --- | --- | ---: | ---: | --- |',
    ];
    for (const r of rows) {
        lines.push(
            `| ${r.area} | ${r.metric} | ${r.pct.toFixed(2)}% | ${r.floor}% | ${r.ok ? 'ok' : 'BELOW FLOOR'} |`
        );
    }
    return lines.join('\n');
}

// Same rounding as Istanbul, so a total built from per-file entries matches
// the "total" Jest writes for the same files.
function percent(covered, total) {
    return total > 0 ? Math.floor((1000 * 100 * covered) / total / 10) / 100 : 100;
}

/**
 * Totals of the per-file entries of a Jest json-summary that sit under one of
 * the given folders. Jest keys those entries by absolute path, so the folders
 * are resolved against root. Returns null when no file matches, so a wrong
 * folder name fails the gate instead of passing it.
 * @param {object} summary parsed coverage-summary.json
 * @param {string[]} folders paths relative to root
 * @param {string} root
 */
export function totalUnder(summary, folders, root) {
    const prefixes = folders.map((f) => resolve(root, f) + sep);
    const sums = Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }]));
    let files = 0;
    for (const [file, entry] of Object.entries(summary)) {
        if (file === 'total' || !prefixes.some((p) => file.startsWith(p))) continue;
        files++;
        for (const m of METRICS) {
            sums[m].total += entry[m]?.total ?? 0;
            sums[m].covered += entry[m]?.covered ?? 0;
        }
    }
    if (files === 0) return null;
    return Object.fromEntries(
        METRICS.map((m) => [m, { ...sums[m], pct: percent(sums[m].covered, sums[m].total) }])
    );
}

// An area with "include" counts only the files under those folders, so one
// Jest run can feed several areas, each with its own floors.
export function loadSummaries(thresholds, root) {
    const out = {};
    for (const [area, cfg] of Object.entries(thresholds.areas)) {
        const p = resolve(root, cfg.summary);
        const parsed = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
        if (parsed && cfg.include) {
            const total = totalUnder(parsed, cfg.include, root);
            out[area] = total ? { total } : null;
        } else {
            out[area] = parsed;
        }
    }
    return out;
}

function main(argv) {
    const arg = (name, dflt) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : dflt;
    };
    const root = resolve(arg('--root', process.cwd()));
    const thresholds = JSON.parse(
        readFileSync(resolve(root, arg('--config', '.coverage-thresholds.json')), 'utf8')
    );
    const { rows, failures } = evaluate(thresholds, loadSummaries(thresholds, root));
    console.log(renderTable(rows));
    if (failures.length) {
        console.error('\nCoverage gate FAILED:');
        for (const f of failures) console.error(`  - ${f}`);
        process.exit(1);
    }
    console.log('\nCoverage gate passed.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main(process.argv.slice(2));
}
