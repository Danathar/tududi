import test from 'node:test';
import assert from 'node:assert/strict';
import {
    evaluate,
    formatSurvivor,
    isAccepted,
    ledgerEntry,
    mutateRanges,
    originalText,
    parseDiff,
    projectFor,
    survivors,
    validateLedger,
} from '../mutation-check.mjs';

const DIFF = [
    'diff --git a/backend/modules/mcp/tools/taskTools.js b/backend/modules/mcp/tools/taskTools.js',
    'index 1111111..2222222 100644',
    '--- a/backend/modules/mcp/tools/taskTools.js',
    '+++ b/backend/modules/mcp/tools/taskTools.js',
    '@@ -10,0 +11,3 @@ function a() {',
    '+one',
    '+two',
    '+three',
    '@@ -20 +24 @@ function b() {',
    '-old',
    '+new',
    '@@ -30,2 +33,0 @@ function c() {',
    '-gone',
    '-gone too',
    'diff --git a/frontend/components/New.tsx b/frontend/components/New.tsx',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/frontend/components/New.tsx',
    '@@ -0,0 +1,2 @@',
    '+export const x = 1;',
    '+export const y = 2;',
    '',
].join('\n');

test('parseDiff keeps added and changed lines, 1-based and inclusive', () => {
    const r = parseDiff(DIFF);
    assert.deepEqual(r.get('backend/modules/mcp/tools/taskTools.js'), [
        { start: 11, end: 13 },
        { start: 24, end: 24 },
    ]);
    assert.deepEqual(r.get('frontend/components/New.tsx'), [{ start: 1, end: 2 }]);
});

test('parseDiff drops hunks that only delete lines', () => {
    const r = parseDiff(
        ['+++ b/backend/services/a.js', '@@ -5,3 +4,0 @@', '-x', '-y', '-z'].join('\n')
    );
    assert.equal(r.has('backend/services/a.js'), false);
});

test('parseDiff merges adjacent and overlapping ranges but not separate ones', () => {
    const r = parseDiff(
        [
            '+++ b/backend/services/a.js',
            '@@ -1 +1,2 @@',
            '-a',
            '+a',
            '+b',
            '@@ -3 +3 @@',
            '-c',
            '+c',
            '@@ -9 +5,1 @@',
            '-d',
            '+d',
            '@@ -12 +10,3 @@',
            '-e',
            '+e',
            '+f',
            '+g',
            '@@ -14 +11 @@',
            '-h',
            '+h',
        ].join('\n')
    );
    assert.deepEqual(r.get('backend/services/a.js'), [
        { start: 1, end: 3 },
        { start: 5, end: 5 },
        { start: 10, end: 12 },
    ]);
});

test('parseDiff reads quoted paths and ignores deleted files', () => {
    const r = parseDiff(
        [
            '+++ "b/frontend/components/odd \\"name\\".tsx"',
            '@@ -1 +1 @@',
            '-a',
            '+b',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-x',
        ].join('\n')
    );
    assert.deepEqual([...r.keys()], ['frontend/components/odd "name".tsx']);
});

test('projectFor picks the Jest suite for source files', () => {
    assert.equal(projectFor('backend/modules/mcp/tools/taskTools.js'), 'backend');
    assert.equal(projectFor('backend/services/scopeService.js'), 'backend');
    assert.equal(projectFor('backend/middleware/auth.js'), 'backend');
    assert.equal(projectFor('backend/models/task.js'), 'backend');
    assert.equal(projectFor('backend/utils/x.js'), 'backend');
    assert.equal(projectFor('backend/shared/x.js'), 'backend');
    assert.equal(projectFor('frontend/components/Tasks.tsx'), 'frontend');
    assert.equal(projectFor('frontend/utils/date.ts'), 'frontend');
    assert.equal(projectFor('frontend/store/x.js'), 'frontend');
    assert.equal(projectFor('frontend/a.jsx'), 'frontend');
});

test('projectFor leaves out tests, configs, migrations, scripts and locales', () => {
    for (const f of [
        'backend/tests/integration/mcp/mcp-shared-project-area.test.js',
        'backend/modules/tasks/__tests__/x.js',
        'backend/modules/tasks/x.test.js',
        'backend/modules/tasks/x.spec.js',
        'backend/migrations/20240101-x.js',
        'backend/seeders/x.js',
        'backend/scripts/db-init.js',
        'backend/config/config.js',
        'backend/jest.config.js',
        'backend/app.js',
        'backend/models/index.js',
        'backend/modules/landing/locales/en.js',
        'backend/modules/tasks/x.ts',
        'frontend/components/__tests__/Tasks.test.tsx',
        'frontend/components/Tasks.test.tsx',
        'frontend/components/Tasks.spec.ts',
        'frontend/__mocks__/x.js',
        'frontend/types/global.d.ts',
        'frontend/index.tsx',
        'frontend/styles.css',
        'public/locales/en/translation.json',
        'scripts/mutation-check.mjs',
        '.claude/hooks/guard-bash.mjs',
        'jest.config.js',
        'stryker.config.mjs',
        'package.json',
        'docs/quality.md',
    ]) {
        assert.equal(projectFor(f), null, f);
    }
});

test('parseDiff reads an added line that looks like a header as content', () => {
    const r = parseDiff(
        [
            '+++ b/backend/services/a.js',
            '@@ -1,0 +2,3 @@',
            '+++ b/backend/services/other.js',
            '+@@ -1 +1 @@',
            '+ok',
            '\\ No newline at end of file',
        ].join('\n')
    );
    assert.deepEqual([...r.keys()], ['backend/services/a.js']);
    assert.deepEqual(r.get('backend/services/a.js'), [{ start: 2, end: 4 }]);
});

test('mutateRanges builds Stryker file:start-end entries per suite, sorted by file', () => {
    const changed = new Map([
        ['frontend/b.tsx', [{ start: 2, end: 4 }]],
        ['backend/services/z.js', [{ start: 7, end: 7 }]],
        ['backend/services/a.js', [{ start: 1, end: 3 }, { start: 9, end: 9 }]],
        ['backend/tests/a.test.js', [{ start: 1, end: 1 }]],
        ['docs/quality.md', [{ start: 1, end: 1 }]],
    ]);
    assert.deepEqual(mutateRanges(changed), {
        backend: ['backend/services/a.js:1-3', 'backend/services/a.js:9-9', 'backend/services/z.js:7-7'],
        frontend: ['frontend/b.tsx:2-4'],
    });
});

test('mutateRanges is empty when only tests and docs change', () => {
    assert.deepEqual(mutateRanges(parseDiff('+++ b/backend/tests/x.test.js\n@@ -1 +1 @@\n')), {
        backend: [],
        frontend: [],
    });
});

test('originalText slices one line or several, columns 1-based and end exclusive', () => {
    const src = 'const a = 1;\nif (a > 0) {\n    run();\n}\n';
    assert.equal(
        originalText(src, { start: { line: 2, column: 5 }, end: { line: 2, column: 10 } }),
        'a > 0'
    );
    assert.equal(
        originalText(src, { start: { line: 2, column: 12 }, end: { line: 4, column: 2 } }),
        '{\n    run();\n}'
    );
});

const REPORT = {
    files: {
        'backend/services/a.js': {
            source: 'function f(x) {\n    return x > 0;\n}\n',
            mutants: [
                {
                    id: '1',
                    mutatorName: 'EqualityOperator',
                    replacement: 'x >= 0',
                    status: 'Survived',
                    location: { start: { line: 2, column: 12 }, end: { line: 2, column: 17 } },
                },
                {
                    id: '2',
                    mutatorName: 'BooleanLiteral',
                    replacement: 'true',
                    status: 'Killed',
                    location: { start: { line: 2, column: 12 }, end: { line: 2, column: 17 } },
                },
                {
                    id: '3',
                    mutatorName: 'BlockStatement',
                    replacement: '{}',
                    status: 'NoCoverage',
                    location: { start: { line: 1, column: 15 }, end: { line: 3, column: 2 } },
                },
                { id: '4', mutatorName: 'X', replacement: 'y', status: 'Timeout', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
                { id: '5', mutatorName: 'X', replacement: 'y', status: 'RuntimeError', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
                { id: '6', mutatorName: 'X', replacement: 'y', status: 'CompileError', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
                { id: '7', mutatorName: 'X', replacement: 'y', status: 'Ignored', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } },
            ],
        },
    },
};

test('survivors keeps only Survived and NoCoverage mutants, in file and line order', () => {
    const s = survivors(REPORT, '/repo');
    assert.deepEqual(
        s.map((m) => [m.line, m.status, m.mutator, m.original, m.replacement]),
        [
            [1, 'NoCoverage', 'BlockStatement', '{\n    return x > 0;\n}', '{}'],
            [2, 'Survived', 'EqualityOperator', 'x > 0', 'x >= 0'],
        ]
    );
    assert.ok(s.every((m) => m.file === 'backend/services/a.js'));
});

test('survivors makes absolute report paths relative to the root', () => {
    const abs = { files: { '/repo/backend/services/a.js': REPORT.files['backend/services/a.js'] } };
    assert.equal(survivors(abs, '/repo')[0].file, 'backend/services/a.js');
});

test('survivors of an empty or file-less report is empty', () => {
    assert.deepEqual(survivors({ files: {} }), []);
    assert.deepEqual(survivors({}), []);
});

const SURVIVOR = {
    file: 'backend/services/a.js',
    line: 2,
    column: 12,
    status: 'Survived',
    mutator: 'EqualityOperator',
    original: 'x > 0',
    replacement: 'x >= 0',
};
const entry = (over = {}) => ({ ...ledgerEntry(SURVIVOR), reason: 'x is never 0', ...over });

test('a ledger entry accepts a survivor on file, mutator, original and replacement', () => {
    assert.equal(isAccepted(SURVIVOR, { survivors: [entry()] }), true);
    assert.equal(isAccepted({ ...SURVIVOR, line: 99, column: 1 }, { survivors: [entry()] }), true);
    assert.equal(isAccepted(SURVIVOR, { survivors: [entry({ original: '  x  >\n0 ' })] }), true);
});

test('a ledger entry that differs in any matched field does not accept the survivor', () => {
    for (const over of [
        { file: 'backend/services/b.js' },
        { mutator: 'ConditionalExpression' },
        { original: 'x < 0' },
        { replacement: 'x <= 0' },
    ]) {
        assert.equal(isAccepted(SURVIVOR, { survivors: [entry(over)] }), false, JSON.stringify(over));
    }
    assert.equal(isAccepted(SURVIVOR, { survivors: [] }), false);
});

test('evaluate splits survivors into new and accepted', () => {
    const other = { ...SURVIVOR, mutator: 'ConditionalExpression', replacement: 'true' };
    const r = evaluate([SURVIVOR, other], { survivors: [entry()] });
    assert.deepEqual(r.accepted, [SURVIVOR]);
    assert.deepEqual(r.fresh, [other]);
});

test('validateLedger accepts an empty ledger and complete entries', () => {
    assert.deepEqual(validateLedger({ survivors: [] }), []);
    assert.deepEqual(validateLedger({ survivors: [entry()] }), []);
    assert.deepEqual(validateLedger({ survivors: [entry({ replacement: '' })] }), []);
});

test('validateLedger rejects a missing list and entries without a reason or field', () => {
    assert.match(validateLedger({})[0], /no "survivors" array/);
    assert.match(validateLedger(null)[0], /no "survivors" array/);
    assert.match(validateLedger({ survivors: [entry({ reason: ' ' })] })[0], /survivors\[0\]: "reason"/);
    const { mutator, ...noMutator } = entry();
    assert.equal(mutator, 'EqualityOperator');
    assert.match(validateLedger({ survivors: [noMutator] })[0], /"mutator"/);
    assert.equal(validateLedger({ survivors: [null] }).length, 5);
});

test('ledgerEntry has every field validateLedger needs and a reason to fill in', () => {
    const e = ledgerEntry(SURVIVOR);
    assert.deepEqual(validateLedger({ survivors: [e] }), []);
    assert.match(e.reason, /^TODO/);
    assert.equal(isAccepted(SURVIVOR, { survivors: [e] }), true);
});

test('formatSurvivor names the place, mutator, status and both texts on one line', () => {
    assert.equal(
        formatSurvivor({ ...SURVIVOR, original: 'a\n  b' }),
        'backend/services/a.js:2:12 EqualityOperator (Survived): `a b` -> `x >= 0`'
    );
});
