#!/usr/bin/env node
// Proposes coverage floor raises. Never lowers a floor, never writes the
// repository's threshold file: output goes to --out-dir for the workflow to
// publish as a step summary and a tracking issue.
// Usage: node scripts/auto-qa-tuner.mjs [--root <dir>] [--out-dir <dir>]
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { METRICS, loadSummaries } from './coverage-gate.mjs';

/**
 * @param {object} thresholds current .coverage-thresholds.json
 * @param {object} rules .github/auto-qa-tuning.json "coverage" block
 * @param {Record<string, object|null>} summaries area -> coverage-summary.json
 * @returns {{changes: object[], proposed: object, skipped: string[]}}
 */
export function propose(thresholds, rules, summaries) {
    const margin = rules.raise_floor_when_headroom_exceeds;
    const buffer = rules.buffer_below_measured;
    const proposed = structuredClone(thresholds);
    const changes = [];
    const skipped = [];
    for (const [area, cfg] of Object.entries(thresholds.areas)) {
        const total = summaries[area]?.total;
        if (!total) {
            skipped.push(`${area}: no coverage summary, left unchanged`);
            continue;
        }
        for (const metric of METRICS) {
            const pct = total[metric]?.pct;
            const floor = cfg.floor[metric];
            if (typeof pct !== 'number') continue;
            const headroom = round2(pct - floor);
            const target = Math.floor(pct - buffer);
            if (headroom > margin && target > floor) {
                changes.push({ area, metric, pct, from: floor, to: target, headroom });
                proposed.areas[area].floor[metric] = target;
            }
        }
        if (changes.some((c) => c.area === area)) {
            for (const metric of METRICS) {
                if (typeof total[metric]?.pct === 'number') {
                    proposed.areas[area].measured[metric] = total[metric].pct;
                }
            }
        }
    }
    return { changes, proposed, skipped };
}

const round2 = (n) => Math.round(n * 100) / 100;

export function renderReport({ changes, skipped }, rules) {
    const out = ['## Auto-QA coverage tuning', ''];
    out.push(
        `Rule: raise a floor when measured minus floor exceeds ${rules.raise_floor_when_headroom_exceeds} points, to floor(measured - ${rules.buffer_below_measured}). Floors are never lowered automatically.`,
        ''
    );
    if (changes.length === 0) {
        out.push('No floor raise warranted.');
    } else {
        out.push(
            '| area | metric | measured | floor now | proposed floor |',
            '| --- | --- | ---: | ---: | ---: |'
        );
        for (const c of changes) {
            out.push(`| ${c.area} | ${c.metric} | ${c.pct}% | ${c.from}% | ${c.to}% |`);
        }
    }
    for (const s of skipped) out.push('', `Skipped - ${s}`);
    return out.join('\n') + '\n';
}

/** Line diff of two JSON documents with identical shape (same key order). */
export function jsonLineDiff(before, after) {
    const a = JSON.stringify(before, null, 4).split('\n');
    const b = JSON.stringify(after, null, 4).split('\n');
    const out = [];
    a.forEach((line, i) => {
        if (line !== b[i]) out.push(`-${line}`, `+${b[i]}`);
    });
    return out.join('\n');
}

function main(argv) {
    const arg = (name, dflt) => {
        const i = argv.indexOf(name);
        return i >= 0 ? argv[i + 1] : dflt;
    };
    const root = resolve(arg('--root', process.cwd()));
    const outDir = resolve(arg('--out-dir', 'auto-qa-out'));
    const thresholds = JSON.parse(readFileSync(resolve(root, '.coverage-thresholds.json'), 'utf8'));
    const rules = JSON.parse(readFileSync(resolve(root, '.github/auto-qa-tuning.json'), 'utf8')).coverage;
    const result = propose(thresholds, rules, loadSummaries(thresholds, root));
    const report = renderReport(result, rules);
    mkdirSync(outDir, { recursive: true });
    let issueBody = '';
    if (result.changes.length) {
        issueBody =
            report +
            '\nProposed change to `.coverage-thresholds.json` (apply by hand in a pull request):\n\n```diff\n' +
            jsonLineDiff(thresholds, result.proposed) +
            '\n```\n';
    }
    writeFileSync(resolve(outDir, 'report.md'), report);
    writeFileSync(resolve(outDir, 'issue-body.md'), issueBody);
    process.stdout.write(report);
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `raise=${result.changes.length > 0}\n`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main(process.argv.slice(2));
}
