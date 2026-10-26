import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..'
);
const require = createRequire(import.meta.url);

// StrykerJS parses every JavaScript file it mutates with its own copy of
// @babel/core, and that parse loads the repository's babel.config.js. A
// preset built for another Babel major throws there, Stryker stops before
// running a single test, and the mutation job reports nothing about the pull
// request. These checks read the lock file and call the config with the
// Babel version each consumer loads, so they need no npm install.

const { packages } = JSON.parse(
    readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')
);
const versionOf = (name) => packages[`node_modules/${name}`].version;
const major = (version) => Number(String(version).split('.')[0]);

const config = require(path.join(ROOT, 'babel.config.js'));
const presetsFor = (version) => {
    const api = {
        version,
        cache: { using: () => {} },
    };
    const result = typeof config === 'function' ? config(api) : config;
    return result.presets ?? [];
};

test("babel.config.js loads no preset of another major under Stryker's Babel", () => {
    const strykerBabel = (
        packages[
            'node_modules/@stryker-mutator/instrumenter/node_modules/@babel/core'
        ] ?? packages['node_modules/@babel/core']
    ).version;
    for (const preset of presetsFor(strykerBabel)) {
        assert.equal(
            major(versionOf(preset)),
            major(strykerBabel),
            `Stryker parses with @babel/core ${strykerBabel}, but babel.config.js gives it ${preset} ${versionOf(preset)}`
        );
    }
});

test('babel.config.js still gives babel-jest its presets', () => {
    assert.deepEqual(presetsFor(versionOf('@babel/core')), [
        '@babel/preset-env',
        '@babel/preset-react',
        '@babel/preset-typescript',
    ]);
});
