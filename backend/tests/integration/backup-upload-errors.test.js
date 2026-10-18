const request = require('supertest');
const app = require('../../app');
const { createTestUser } = require('../helpers/testUtils');

const login = async (user) => {
    const agent = request.agent(app);
    await agent
        .post('/api/login')
        .send({ email: user.email, password: 'password123' });
    return agent;
};

describe('backup upload errors', () => {
    let agent;

    beforeEach(async () => {
        const user = await createTestUser({
            email: `backup-upload_${Date.now()}@example.com`,
        });
        agent = await login(user);
    });

    it.each(['/api/backup/import', '/api/backup/validate'])(
        'answers 400 with the message when %s gets a file type it refuses',
        async (url) => {
            const res = await agent
                .post(url)
                .attach('backup', Buffer.from('not a backup'), {
                    filename: 'backup.txt',
                    contentType: 'text/plain',
                });

            expect(res.status).toBe(400);
            expect(res.body.error).toBe('Only JSON and gzip files are allowed');
            expect(res.body.code).toBe('VALIDATION_ERROR');
        }
    );

    it('answers 400 when the file is sent under the wrong field name', async () => {
        const res = await agent
            .post('/api/backup/import')
            .attach('wrong', Buffer.from('{}'), {
                filename: 'backup.json',
                contentType: 'application/json',
            });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
    });
});
