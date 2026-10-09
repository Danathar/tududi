import test from 'node:test';
import assert from 'node:assert/strict';
import { propose, renderReport, jsonLineDiff } from '../auto-qa-tuner.mjs';

const rules = { raise_floor_when_headroom_exceeds: 5, buffer_below_measured: 3 };
const thresholds = () => ({
    areas: {
        backend: {
            summary: 'b.json',
            measured: { lines: 91, statements: 90, functions: 90, branches: 82 },
            floor: { lines: 88, statements: 87, functions: 87, branches: 79 },
        },
    },
});
const sum = (v) => ({
    total: Object.fromEntries(Object.entries(v).map(([k, pct]) => [k, { pct }])),
});
const all = (n) => ({ lines: n, statements: n, functions: n, branches: n });

test('no raise when headroom does not exceed the margin (exactly at margin)', () => {
    const r = propose(thresholds(), rules, { backend: sum({ lines: 93, statements: 92, functions: 92, branches: 84 }) });
    assert.equal(r.changes.length, 0);
    assert.deepEqual(r.proposed, thresholds());
});

test('raises to floor(measured - buffer) when headroom exceeds margin, only for metrics that qualify', () => {
    const r = propose(thresholds(), rules, { backend: sum({ ...all(90), lines: 96.4, branches: 82 }) });
    assert.equal(r.changes.length, 1);
    assert.deepEqual(r.changes[0], { area: 'backend', metric: 'lines', pct: 96.4, from: 88, to: 93, headroom: 8.4 });
    assert.equal(r.proposed.areas.backend.floor.lines, 93);
    assert.equal(r.proposed.areas.backend.floor.branches, 79);
    assert.equal(r.proposed.areas.backend.measured.lines, 96.4);
});

test('never lowers a floor when coverage drops', () => {
    const r = propose(thresholds(), rules, { backend: sum(all(40)) });
    assert.equal(r.changes.length, 0);
    assert.equal(r.proposed.areas.backend.floor.lines, 88);
});

test('a missing summary leaves the area untouched and is reported', () => {
    const r = propose(thresholds(), rules, { backend: null });
    assert.equal(r.changes.length, 0);
    assert.match(r.skipped[0], /backend: no coverage summary/);
});

test('the proposed floor is never above measured minus the buffer', () => {
    const r = propose(thresholds(), rules, { backend: sum(all(99.9)) });
    for (const c of r.changes) assert.ok(c.to <= c.pct - rules.buffer_below_measured);
});

test('report and diff show the change', () => {
    const r = propose(thresholds(), rules, { backend: sum({ ...all(90), lines: 96.4, branches: 82 }) });
    assert.match(renderReport(r, rules), /\| backend \| lines \| 96\.4% \| 88% \| 93% \|/);
    const d = jsonLineDiff(thresholds(), r.proposed);
    assert.match(d, /^-\s+"lines": 88,$/m);
    assert.match(d, /^\+\s+"lines": 93,$/m);
    assert.match(renderReport({ changes: [], skipped: [] }, rules), /No floor raise warranted/);
});
