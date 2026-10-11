const packageJson = require('../../../../package.json');
const { getBuildInfo } = require('../../../services/buildInfo');

describe('getBuildInfo', () => {
    const originalEnv = process.env;
    const sha = '518b8ff0a1b2c3d4e5f60718293a4b5c6d7e8f90';

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.TUDUDI_BUILD_COMMIT;
        delete process.env.TUDUDI_BUILD_DATE;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('describes the build when the commit and date are set', () => {
        process.env.TUDUDI_BUILD_COMMIT = sha;
        process.env.TUDUDI_BUILD_DATE = '2026-10-11T08:00:00+00:00';

        const version = String(packageJson.version).replace(/^v/, '');
        expect(getBuildInfo()).toEqual({
            commit: sha,
            short: '518b8ff',
            date: '2026-10-11T08:00:00+00:00',
            tag: `v${version}-518b8ff`,
            url: `https://github.com/Danathar/tududi/commit/${sha}`,
        });
    });

    it('has a null date when only the commit is set', () => {
        process.env.TUDUDI_BUILD_COMMIT = sha;

        expect(getBuildInfo().date).toBeNull();
    });

    it('returns null when the commit is unset', () => {
        expect(getBuildInfo()).toBeNull();
    });

    it('returns null when the commit is empty', () => {
        process.env.TUDUDI_BUILD_COMMIT = '';

        expect(getBuildInfo()).toBeNull();
    });

    it('returns null when the commit is not a full sha', () => {
        process.env.TUDUDI_BUILD_COMMIT = 'not-a-sha';
        expect(getBuildInfo()).toBeNull();

        process.env.TUDUDI_BUILD_COMMIT = '518b8ff';
        expect(getBuildInfo()).toBeNull();
    });
});
