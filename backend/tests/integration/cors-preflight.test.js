const request = require('supertest');
const app = require('../../app');

// http://localhost:8080 is one of the default allowed origins.
const ORIGIN = 'http://localhost:8080';

describe('CORS preflight', () => {
    it.each(['/api/tasks', '/api/v1/tasks', '/api/login'])(
        'answers a preflight to %s with 204 before auth runs',
        async (path) => {
            const res = await request(app)
                .options(path)
                .set('Origin', ORIGIN)
                .set('Access-Control-Request-Method', 'POST')
                .set(
                    'Access-Control-Request-Headers',
                    'content-type,x-csrf-token'
                );

            expect(res.status).toBe(204);
            expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
            expect(res.headers['access-control-allow-credentials']).toBe(
                'true'
            );
        }
    );

    it('still hands CalDAV OPTIONS requests to the CalDAV routes', async () => {
        // The CalDAV OPTIONS handler requires authentication, so a 401 shows
        // the request went past cors instead of being answered by it.
        const res = await request(app)
            .options('/caldav/someone@example.com/')
            .set('Origin', ORIGIN)
            .set('Access-Control-Request-Method', 'PROPFIND');

        expect(res.status).toBe(401);
        expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    });
});
