const {
    withRemoteAuth,
} = require('../../../../../modules/caldav/services/remote-auth');

describe('withRemoteAuth', () => {
    it('uses Basic auth for a basic calendar', () => {
        const config = withRemoteAuth(
            { method: 'GET', headers: { Depth: '1' } },
            { auth_type: 'basic', username: 'user' },
            'pw'
        );

        expect(config.auth).toEqual({ username: 'user', password: 'pw' });
        expect(config.headers).toEqual({ Depth: '1' });
    });

    it('uses Basic auth when auth_type is not set', () => {
        const config = withRemoteAuth(
            { method: 'GET' },
            { username: 'user' },
            'pw'
        );

        expect(config.auth).toEqual({ username: 'user', password: 'pw' });
    });

    it('sends a Bearer header and no Basic auth for a bearer calendar', () => {
        const config = withRemoteAuth(
            { method: 'PUT', headers: { 'If-Match': '"abc"' } },
            { auth_type: 'bearer', username: 'user' },
            'token-123'
        );

        expect(config.auth).toBeUndefined();
        expect(config.headers).toEqual({
            'If-Match': '"abc"',
            Authorization: 'Bearer token-123',
        });
    });
});
