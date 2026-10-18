const request = require('supertest');
const app = require('../../app');
const { Task, TaskEvent } = require('../../models');
const { createTestUser } = require('../helpers/testUtils');

// #244: the task history compared the request's due date with the UTC date
// of the stored instant, so for users west of UTC every save logged a
// due-date change that did not happen.
describe('Task history for users west of UTC', () => {
    let agent, task;

    const events = (fieldName) =>
        TaskEvent.findAll({
            where: { task_id: task.id, field_name: fieldName },
            order: [['id', 'ASC']],
        });

    beforeEach(async () => {
        const user = await createTestUser({
            email: 'history-la@example.com',
            timezone: 'America/Los_Angeles',
        });

        agent = request.agent(app);
        await agent.post('/api/login').send({
            email: user.email,
            password: 'password123',
        });

        const created = await agent.post('/api/task').send({
            name: 'Dentist',
            due_date: '2026-06-15',
            priority: 'low',
        });
        expect(created.status).toBe(201);
        task = await Task.findOne({ where: { uid: created.body.uid } });
        await TaskEvent.destroy({ where: { task_id: task.id } });
    });

    it('does not log a due date change when the same date is sent again', async () => {
        const response = await agent
            .patch(`/api/task/${task.uid}`)
            .send({ name: 'Dentist', due_date: '2026-06-15' });
        expect(response.status).toBe(200);

        expect(await events('due_date')).toHaveLength(0);
    });

    it('logs a real due date change with both dates in the same format', async () => {
        const response = await agent
            .patch(`/api/task/${task.uid}`)
            .send({ due_date: '2026-06-20' });
        expect(response.status).toBe(200);

        const logged = await events('due_date');
        expect(logged).toHaveLength(1);
        expect(logged[0].old_value).toEqual({ due_date: '2026-06-15' });
        expect(logged[0].new_value).toEqual({ due_date: '2026-06-20' });
    });

    it('does not log a priority change when the same priority is sent by name', async () => {
        const response = await agent
            .patch(`/api/task/${task.uid}`)
            .send({ priority: 'low' });
        expect(response.status).toBe(200);

        expect(await events('priority')).toHaveLength(0);
    });

    it('keeps a falsy old value (priority low = 0) in the history', async () => {
        const response = await agent
            .patch(`/api/task/${task.uid}`)
            .send({ priority: 'high' });
        expect(response.status).toBe(200);

        const logged = await events('priority');
        expect(logged).toHaveLength(1);
        expect(logged[0].old_value).toEqual({ priority: 0 });
        expect(logged[0].new_value).toEqual({ priority: 2 });
    });
});
