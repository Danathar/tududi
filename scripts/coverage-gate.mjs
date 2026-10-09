#!/usr/bin/env node
// Compares Jest json-summary coverage against the floors in
// .coverage-thresholds.json. Exits 1 when any metric is below its floor or a
// summary file is missing. Usage: node scripts/coverage-gate.mjs [--config <file>] [--root <dir>]
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
            failures.push(`${area}: no coverage summary at ${cfg.summary}`);
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

export function loadSummaries(thresholds, root) {
    const out = {};
    for (const [area, cfg] of Object.entries(thresholds.areas)) {
        const p = resolve(root, cfg.summary);
        out[area] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
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
