import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, renderTable } from '../coverage-gate.mjs';

const thresholds = {
    areas: {
        backend: {
            summary: 'b.json',
            floor: { lines: 88, statements: 87, functions: 87, branches: 79 },
        },
    },
};
const summary = (v) => ({
    total: Object.fromEntries(
        ['lines', 'statements', 'functions', 'branches'].map((m) => [m, { pct: v[m] ?? 90 }])
    ),
});

test('passes when every metric is at or above its floor, including exactly at the floor', () => {
    const r = evaluate(thresholds, { backend: summary({ lines: 88, branches: 79 }) });
    assert.deepEqual(r.failures, []);
    assert.equal(r.rows.length, 4);
});

test('fails only the metric that regressed below the floor', () => {
    const r = evaluate(thresholds, { backend: summary({ branches: 78.99 }) });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /backend\.branches: 78\.99% is below the 79% floor/);
});

test('a missing summary file is a failure, not a pass', () => {
    const r = evaluate(thresholds, { backend: null });
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /no coverage summary at b\.json/);
});

test('a metric absent from the summary fails', () => {
    const s = summary({});
    delete s.total.functions;
    const r = evaluate(thresholds, { backend: s });
    assert.match(r.failures[0], /backend\.functions: not present/);
});

test('table marks rows below floor', () => {
    const r = evaluate(thresholds, { backend: summary({ lines: 50 }) });
    assert.match(renderTable(r.rows), /\| backend \| lines \| 50\.00% \| 88% \| BELOW FLOOR \|/);
});
