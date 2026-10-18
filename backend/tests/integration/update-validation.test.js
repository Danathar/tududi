const request = require('supertest');
const app = require('../../app');
const { Area, Goal, Project, Task, View } = require('../../models');
const { createTestUser } = require('../helpers/testUtils');

// PATCH must reject the values POST rejects, instead of storing them.
describe('Update validation', () => {
    let user, agent;

    beforeEach(async () => {
        user = await createTestUser({ email: 'update-validation@example.com' });
        agent = request.agent(app);
        await agent.post('/api/login').send({
            email: 'update-validation@example.com',
            password: 'password123',
        });
    });

    describe('projects', () => {
        let project;

        beforeEach(async () => {
            project = await Project.create({
                name: 'Keep me',
                user_id: user.id,
            });
        });

        it.each([
            [{ status: 'bogus' }],
            [{ priority: 'x' }],
            [{ priority: 5 }],
            [{ name: '   ' }],
        ])('rejects %j with 400', async (body) => {
            const res = await agent
                .patch(`/api/project/${project.uid}`)
                .send(body);

            expect(res.status).toBe(400);
            await project.reload();
            expect(project.name).toBe('Keep me');
            expect(project.status).toBe('not_started');
        });

        it('still accepts a valid status and priority', async () => {
            const res = await agent
                .patch(`/api/project/${project.uid}`)
                .send({ status: 'done', priority: 2 });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('done');
        });
    });

    describe('goals', () => {
        let goal;

        beforeEach(async () => {
            goal = await Goal.create({ title: 'Keep me', user_id: user.id });
        });

        it.each([
            [{ horizon: 'zz' }],
            [{ status: 'bogus' }],
            [{ title: null }],
            [{ title: 42 }],
            [{ title: '  ' }],
        ])('rejects %j with 400', async (body) => {
            const res = await agent.patch(`/api/goals/${goal.uid}`).send(body);

            expect(res.status).toBe(400);
            await goal.reload();
            expect(goal.title).toBe('Keep me');
            expect(goal.horizon).toBe('season');
            expect(goal.status).toBe('active');
        });

        it('still accepts valid values', async () => {
            const res = await agent
                .patch(`/api/goals/${goal.uid}`)
                .send({ horizon: 'year', status: 'paused', title: ' New ' });

            expect(res.status).toBe(200);
            await goal.reload();
            expect(goal.title).toBe('New');
            expect(goal.horizon).toBe('year');
            expect(goal.status).toBe('paused');
        });
    });

    describe('areas', () => {
        it('rejects a blank name', async () => {
            const area = await Area.create({
                name: 'Keep me',
                user_id: user.id,
            });

            const res = await agent
                .patch(`/api/areas/${area.uid}`)
                .send({ name: '   ' });

            expect(res.status).toBe(400);
            await area.reload();
            expect(area.name).toBe('Keep me');
        });
    });

    describe('views', () => {
        it('rejects a blank name', async () => {
            const created = await agent
                .post('/api/views')
                .send({ name: 'Keep me', filters: ['Task'] });
            expect(created.status).toBe(201);

            const res = await agent
                .patch(`/api/views/${created.body.uid}`)
                .send({ name: '   ' });

            expect(res.status).toBe(400);
            const view = await View.findOne({
                where: { uid: created.body.uid },
            });
            expect(view.name).toBe('Keep me');
        });
    });

    describe('tasks', () => {
        let task;

        beforeEach(async () => {
            task = await Task.create({ name: 'Keep me', user_id: user.id });
        });

        it.each([
            [{ name: '   ' }],
            [{ status: 'bogus' }],
            [{ recurrence_type: 'bogus' }],
        ])('rejects %j with 400', async (body) => {
            const res = await agent.patch(`/api/task/${task.uid}`).send(body);

            expect(res.status).toBe(400);
            await task.reload();
            expect(task.name).toBe('Keep me');
            expect(task.status).toBe(Task.STATUS.NOT_STARTED);
            expect(task.recurrence_type).toBe('none');
        });

        it('still accepts a valid status name', async () => {
            const res = await agent
                .patch(`/api/task/${task.uid}`)
                .send({ status: 'in_progress' });

            expect(res.status).toBe(200);
        });
    });
});
