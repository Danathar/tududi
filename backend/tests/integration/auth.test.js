const request = require('supertest');
const app = require('../../app');
const { User } = require('../../models');
const { createTestUser } = require('../helpers/testUtils');

describe('Auth Routes', () => {
    describe('POST /api/login', () => {
        let user;

        beforeEach(async () => {
            user = await createTestUser({
                email: 'test@example.com',
            });
        });

        it('should login with valid credentials', async () => {
            const response = await request(app).post('/api/login').send({
                email: 'test@example.com',
                password: 'password123',
            });

            expect(response.status).toBe(200);
            expect(response.body.user).toBeDefined();
            expect(response.body.user.email).toBe('test@example.com');
            expect(response.body.user.uid).toBe(user.uid);
            expect(response.body.user).not.toHaveProperty('id');
            expect(response.body.user.language).toBe('en');
            expect(response.body.user.appearance).toBe('light');
            expect(response.body.user.timezone).toBe('UTC');
        });

        it('should return 400 for missing email', async () => {
            const response = await request(app).post('/api/login').send({
                password: 'password123',
            });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Invalid login parameters.');
        });

        it('should return 400 for missing password', async () => {
            const response = await request(app).post('/api/login').send({
                email: 'test@example.com',
            });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Invalid login parameters.');
        });

        it.each([
            ['an array email', { email: ['test@example.com'], password: 'x' }],
            ['an object email', { email: { a: 1 }, password: 'x' }],
            ['a numeric password', { email: 'test@example.com', password: 1 }],
            [
                'an array password',
                { email: 'test@example.com', password: ['x'] },
            ],
        ])('should return 400 for %s', async (_label, body) => {
            const response = await request(app).post('/api/login').send(body);

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Invalid login parameters.');
        });

        it('should return 401 for non-existent user', async () => {
            const response = await request(app).post('/api/login').send({
                email: 'nonexistent@example.com',
                password: 'password123',
            });

            expect(response.status).toBe(401);
            expect(response.body.errors).toEqual(['Invalid credentials']);
        });

        it('should return 401 for invalid password', async () => {
            const response = await request(app).post('/api/login').send({
                email: 'test@example.com',
                password: 'wrongpassword',
            });

            expect(response.status).toBe(401);
            expect(response.body.errors).toEqual(['Invalid credentials']);
        });

        it('answers a passwordless account like an unknown email', async () => {
            await User.create({
                email: 'nopw@example.com',
                password_digest: null,
            });

            const response = await request(app).post('/api/login').send({
                email: 'nopw@example.com',
                password: 'whatever12',
            });

            expect(response.status).toBe(401);
            expect(response.body.errors).toEqual(['Invalid credentials']);
        });

        it('issues a new session id at sign-in, so a planted one is never signed in', async () => {
            const sessionCookie = (response) =>
                (response.headers['set-cookie'] || [])
                    .map((c) => c.split(';')[0])
                    .find((c) => c.startsWith('connect.sid='));

            const before = await request(app).get('/api/csrf-token');
            const planted = sessionCookie(before);
            expect(planted).toBeDefined();

            const login = await request(app)
                .post('/api/login')
                .set('Cookie', planted)
                .send({
                    email: 'test@example.com',
                    password: 'password123',
                });
            expect(login.status).toBe(200);
            const issued = sessionCookie(login);
            expect(issued).toBeDefined();
            expect(issued).not.toBe(planted);

            const withPlanted = await request(app)
                .get('/api/profile')
                .set('Cookie', planted);
            expect(withPlanted.status).toBe(401);

            const withIssued = await request(app)
                .get('/api/profile')
                .set('Cookie', issued);
            expect(withIssued.status).toBe(200);
        });
    });

    describe('GET /api/current_user', () => {
        let user;

        beforeEach(async () => {
            user = await createTestUser({
                email: 'test@example.com',
            });
        });

        it('should return current user when logged in', async () => {
            const agent = request.agent(app);

            // Login first
            await agent.post('/api/login').send({
                email: 'test@example.com',
                password: 'password123',
            });

            // Check current user
            const response = await agent.get('/api/current_user');

            expect(response.status).toBe(200);
            expect(response.body.user).toBeDefined();
            expect(response.body.user.email).toBe('test@example.com');
            expect(response.body.user.uid).toBe(user.uid);
            expect(response.body.user).not.toHaveProperty('id');
        });

        it('should return null user when not logged in', async () => {
            const response = await request(app).get('/api/current_user');

            expect(response.status).toBe(200);
            expect(response.body.user).toBeNull();
        });
    });

    describe('GET /api/logout', () => {
        let user;

        beforeEach(async () => {
            user = await createTestUser({
                email: 'test@example.com',
            });
        });

        it('should logout successfully', async () => {
            const agent = request.agent(app);

            // Login first
            await agent.post('/api/login').send({
                email: 'test@example.com',
                password: 'password123',
            });

            // Logout
            const response = await agent.get('/api/logout');

            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Logged out successfully');

            // Verify user is logged out
            const currentUserResponse = await agent.get('/api/current_user');
            expect(currentUserResponse.body.user).toBeNull();
        });

        it('should handle logout when not logged in', async () => {
            const response = await request(app).get('/api/logout');

            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Logged out successfully');
        });
    });

    describe('Password Authentication Disabled', () => {
        let originalEnv;

        beforeAll(() => {
            originalEnv = process.env.PASSWORD_AUTH_ENABLED;
        });

        afterAll(() => {
            if (originalEnv === undefined) {
                delete process.env.PASSWORD_AUTH_ENABLED;
            } else {
                process.env.PASSWORD_AUTH_ENABLED = originalEnv;
            }
            delete require.cache[require.resolve('../../config/authConfig')];
        });

        beforeEach(() => {
            process.env.PASSWORD_AUTH_ENABLED = 'false';
            delete require.cache[require.resolve('../../config/authConfig')];
        });

        describe('POST /api/login', () => {
            it('should return 403 when password auth is disabled', async () => {
                const response = await request(app).post('/api/login').send({
                    email: 'test@example.com',
                    password: 'password123',
                });

                expect(response.status).toBe(403);
                expect(response.body.error).toBe(
                    'Password login is disabled. Please use SSO to sign in.'
                );
            });
        });

        describe('POST /api/register', () => {
            it('should return 403 when password auth is disabled', async () => {
                const response = await request(app).post('/api/register').send({
                    email: 'newuser@example.com',
                    password: 'password123',
                });

                expect(response.status).toBe(403);
                expect(response.body.error).toBe(
                    'Password registration is disabled. Please use SSO to sign in.'
                );
            });
        });

        describe('GET /api/password-auth-status', () => {
            it('should return enabled: false when disabled', async () => {
                const response = await request(app).get(
                    '/api/password-auth-status'
                );

                expect(response.status).toBe(200);
                expect(response.body).toEqual({ enabled: false });
            });
        });
    });

    describe('Password Authentication Enabled (Default)', () => {
        beforeEach(() => {
            delete process.env.PASSWORD_AUTH_ENABLED;
            delete require.cache[require.resolve('../../config/authConfig')];
        });

        describe('GET /api/password-auth-status', () => {
            it('should return enabled: true by default', async () => {
                const response = await request(app).get(
                    '/api/password-auth-status'
                );

                expect(response.status).toBe(200);
                expect(response.body).toEqual({ enabled: true });
            });
        });
    });
});
