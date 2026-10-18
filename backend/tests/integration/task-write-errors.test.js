const request = require('supertest');
const app = require('../../app');
const taskRepository = require('../../modules/tasks/repository');
const {
    createTestUser,
    acceptAllInvitations,
} = require('../helpers/testUtils');

// Task create, update and delete answer a client mistake with its own status
// and a server fault with a 500 that carries no internal text (#315).
describe('Task write error statuses', () => {
    let user, agent;

    const driverError = () =>
        Object.assign(new Error('SQLITE_BUSY: database is locked'), {
            code: 'SQLITE_BUSY',
        });

    // errorHandler only hides the internal message in production, and CSRF
    // is only enforced outside the test environment.
    const inProduction = async (send) => {
        const savedNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const { body } = await agent.get('/api/csrf-token');
            return await send(body.csrfToken);
        } finally {
            process.env.NODE_ENV = savedNodeEnv;
        }
    };

    const expectServerError = (response) => {
        expect(response.status).toBe(500);
        expect(response.body.code).toBe('INTERNAL_ERROR');
        expect(response.body.details).toBeUndefined();
    };

    const expectNoDriverText = (response) => {
        expect(response.body.error).toBe('Internal server error');
        expect(JSON.stringify(response.body)).not.toMatch(/SQLITE|locked/);
    };

    beforeEach(async () => {
        user = await createTestUser({
            email: `task-write-errors-${Date.now()}@example.com`,
        });
        agent = request.agent(app);
        await agent
            .post('/api/login')
            .send({ email: user.email, password: 'password123' });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('400 for a malformed request', () => {
        it('rejects a bad due_time on create', async () => {
            const response = await agent.post('/api/task').send({
                name: 'Bad time',
                due_date: '2030-01-10',
                due_time: '25:99',
            });

            expect(response.status).toBe(400);
            expect(response.body.details).toEqual([
                'due_time must be in HH:mm format',
            ]);
        });

        it('rejects a bad due_time on update', async () => {
            const created = await agent
                .post('/api/task')
                .send({ name: 'Has a date', due_date: '2030-01-10' });
            expect(created.status).toBe(201);

            const response = await agent
                .patch(`/api/task/${created.body.uid}`)
                .send({ due_time: 'noon' });

            expect(response.status).toBe(400);
            expect(response.body.details).toEqual([
                'due_time must be in HH:mm format',
            ]);
        });

        it('rejects a task name that is not a string', async () => {
            const response = await agent.post('/api/task').send({ name: 42 });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Task name is required.');
        });
    });

    describe('403 for a read-only project', () => {
        let roProject;

        beforeEach(async () => {
            const owner = await createTestUser({
                email: `task-write-errors-owner-${Date.now()}@example.com`,
            });
            const ownerAgent = request.agent(app);
            await ownerAgent
                .post('/api/login')
                .send({ email: owner.email, password: 'password123' });

            const projectResponse = await ownerAgent
                .post('/api/project')
                .send({ name: 'Read-only project' });
            roProject = projectResponse.body;

            await ownerAgent.post('/api/shares').send({
                resource_type: 'project',
                resource_uid: roProject.uid,
                target_user_email: user.email,
                access_level: 'ro',
            });
            await acceptAllInvitations(agent);
        });

        it('refuses to create a task in it', async () => {
            const response = await agent
                .post('/api/task')
                .send({ name: 'Sneak in', project_uid: roProject.uid });

            expect(response.status).toBe(403);
            expect(response.body.error).toBe('Forbidden');
        });

        it('refuses to move a task into it', async () => {
            const created = await agent
                .post('/api/task')
                .send({ name: 'Mine' });
            expect(created.status).toBe(201);

            const response = await agent
                .patch(`/api/task/${created.body.uid}`)
                .send({ project_uid: roProject.uid });

            expect(response.status).toBe(403);
            expect(response.body.error).toBe('Forbidden');
        });
    });

    describe('500 when the database write fails', () => {
        it('create', async () => {
            jest.spyOn(taskRepository, 'create').mockRejectedValue(
                driverError()
            );

            const response = await agent
                .post('/api/task')
                .send({ name: 'Locked out' });

            expectServerError(response);
        });

        it('create, without the driver message in production', async () => {
            jest.spyOn(taskRepository, 'create').mockRejectedValue(
                driverError()
            );

            const response = await inProduction((csrfToken) =>
                agent
                    .post('/api/task')
                    .set('x-csrf-token', csrfToken)
                    .send({ name: 'Locked out' })
            );

            expectServerError(response);
            expectNoDriverText(response);
        });

        it('update, without the driver message in production', async () => {
            const created = await agent
                .post('/api/task')
                .send({ name: 'To update' });
            expect(created.status).toBe(201);
            jest.spyOn(taskRepository, 'findByUid').mockRejectedValue(
                driverError()
            );

            const response = await inProduction((csrfToken) =>
                agent
                    .patch(`/api/task/${created.body.uid}`)
                    .set('x-csrf-token', csrfToken)
                    .send({ name: 'Renamed' })
            );

            expectServerError(response);
            expectNoDriverText(response);
        });

        it('delete, without the driver message in production', async () => {
            const created = await agent
                .post('/api/task')
                .send({ name: 'To delete' });
            expect(created.status).toBe(201);
            jest.spyOn(taskRepository, 'findByUid').mockRejectedValue(
                driverError()
            );

            const response = await inProduction((csrfToken) =>
                agent
                    .delete(`/api/task/${created.body.uid}`)
                    .set('x-csrf-token', csrfToken)
            );

            expectServerError(response);
            expectNoDriverText(response);
        });
    });
});
