const request = require('supertest');
const app = require('../../app');
const packageJson = require('../../../package.json');

describe('GET /api/version', () => {
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

    it('returns the package version and a null build without the build env', async () => {
        const res = await request(app).get('/api/version');

        expect(res.status).toBe(200);
        expect(res.body.version).toBe(packageJson.version);
        expect(res.body.build).toBeNull();
    });

    it('returns the build when the build env is set', async () => {
        process.env.TUDUDI_BUILD_COMMIT = sha;
        process.env.TUDUDI_BUILD_DATE = '2026-10-11T08:00:00+00:00';

        const res = await request(app).get('/api/version');

        expect(res.status).toBe(200);
        expect(res.body.version).toBe(packageJson.version);
        expect(res.body.build.commit).toBe(sha);
        expect(res.body.build.tag).toMatch(
            /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?-[0-9a-f]{7}$/
        );
    });
});
