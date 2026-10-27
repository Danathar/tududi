// StrykerJS configuration for the mutation check on changed lines.
// scripts/mutation-check.mjs runs it once per Jest suite, setting
// MUTATION_PROJECT to `backend` or `frontend` and passing the changed line
// ranges with `--mutate`; the `mutate` list below is only a fallback for a
// hand run (`npx stryker run`), which mutates every source file of the suite
// and takes hours. See docs/quality.md.
const project = process.env.MUTATION_PROJECT === 'frontend' ? 'frontend' : 'backend';

const suites = {
    backend: {
        // Same Jest config `npm run backend:test` uses; mutation-check.mjs
        // sets NODE_ENV=test for it.
        configFile: 'backend/jest.config.js',
        mutate: [
            'backend/{modules,services,middleware,models,utils,shared}/**/*.js',
            '!backend/**/locales/**',
            '!backend/models/index.js',
        ],
    },
    frontend: {
        // Same Jest config `npm run frontend:test` uses.
        configFile: 'jest.config.js',
        mutate: [
            'frontend/**/*.{js,jsx,ts,tsx}',
            '!frontend/**/__tests__/**',
            '!frontend/**/*.{test,spec}.{js,jsx,ts,tsx}',
            '!frontend/**/*.d.ts',
            '!frontend/index.tsx',
        ],
    },
};

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
    packageManager: 'npm',
    testRunner: 'jest',
    plugins: ['@stryker-mutator/jest-runner'],
    jest: {
        projectType: 'custom',
        configFile: suites[project].configFile,
        // Run only the tests related to the mutated files.
        enableFindRelatedTests: true,
    },
    coverageAnalysis: 'perTest',
    mutate: suites[project].mutate,
    // Top-level paths the sandbox copy does not need (anchored, so
    // backend/docs, which the API docs load, is still copied).
    ignorePatterns: [
        '/dist',
        '/coverage',
        '/coverage-frontend',
        '/backend/coverage',
        '/screenshots',
        '/e2e',
        '/docs',
        '/reports',
    ],
    reporters: ['clear-text', 'progress', 'json'],
    jsonReporter: { fileName: `reports/mutation/${project}.json` },
    // mutation-check.mjs decides the result from the report and the survivors
    // ledger, so Stryker's own score threshold never fails the run.
    thresholds: { high: 80, low: 60, break: null },
    timeoutMS: 60000,
    // The initial test run (the dry run) runs every test related to the
    // mutated files. A file most of the backend loads, such as one
    // backend/models/user.js imports, pulls in most of the integration suite,
    // about 10 minutes on CI; Stryker's default of 5 minutes stopped it before
    // any mutant ran (#435). This is longer than the CI job's
    // --budget-minutes (ci.yml), so in CI the budget, which ends the check
    // with an "incomplete" notice instead of a failure, always comes first.
    dryRunTimeoutMinutes: 55,
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
};
