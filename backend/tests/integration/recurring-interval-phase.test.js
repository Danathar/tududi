const request = require('supertest');
const app = require('../../app');
const { Task } = require('../../models');
const { createTestUser } = require('../helpers/testUtils');

describe('Recurring task iterations keep the due date phase (issue #1489)', () => {
    let user, agent;

    beforeEach(async () => {
        user = await createTestUser({
            email: 'phase-test@example.com',
            timezone: 'UTC',
        });

        agent = request.agent(app);
        await agent.post('/api/login').send({
            email: user.email,
            password: 'password123',
        });
    });

    it('keeps a "repeat daily every 14 days" task anchored to its due date', async () => {
        const createResponse = await agent.post('/api/task').send({
            name: 'Every 14 days',
            due_date: '2026-09-18',
            recurrence_type: 'daily',
            recurrence_interval: 14,
        });
        expect(createResponse.status).toBe(201);

        const iterationsResponse = await agent.get(
            `/api/task/${createResponse.body.uid}/next-iterations?startFromDate=2026-09-18`
        );
        expect(iterationsResponse.status).toBe(200);

        const dates = iterationsResponse.body.iterations.map((i) => i.date);
        expect(dates).toEqual([
            '2026-09-18',
            '2026-10-02',
            '2026-10-16',
            '2026-10-30',
            '2026-11-13',
            '2026-11-27',
        ]);
    });

    it('keeps a "repeat weekly every 2 weeks" task anchored to its due date', async () => {
        const createResponse = await agent.post('/api/task').send({
            name: 'Every other Friday',
            due_date: '2026-09-18', // a Friday
            recurrence_type: 'weekly',
            recurrence_interval: 2,
            recurrence_weekday: 5,
        });
        expect(createResponse.status).toBe(201);

        const iterationsResponse = await agent.get(
            `/api/task/${createResponse.body.uid}/next-iterations?startFromDate=2026-09-18`
        );
        expect(iterationsResponse.status).toBe(200);

        const dates = iterationsResponse.body.iterations.map((i) => i.date);
        expect(dates).toEqual([
            '2026-09-18',
            '2026-10-02',
            '2026-10-16',
            '2026-10-30',
            '2026-11-13',
            '2026-11-27',
        ]);
    });

    describe('recurrence_interval validation (#209)', () => {
        it.each([-3, 0, 1.5, 'abc', 1001])(
            'rejects recurrence_interval %p on create',
            async (interval) => {
                const response = await agent.post('/api/task').send({
                    name: 'Bad interval',
                    due_date: '2026-05-10',
                    recurrence_type: 'daily',
                    recurrence_interval: interval,
                });
                expect(response.status).toBe(400);
                expect(JSON.stringify(response.body)).toMatch(
                    /recurrence_interval must be a whole number/
                );
            }
        );

        it('accepts a numeric string interval on create', async () => {
            const response = await agent.post('/api/task').send({
                name: 'String interval',
                due_date: '2026-05-10',
                recurrence_type: 'daily',
                recurrence_interval: '3',
            });
            expect(response.status).toBe(201);
            expect(response.body.recurrence_interval).toBe(3);
        });

        it('rejects a negative recurrence_interval on update', async () => {
            const created = await agent.post('/api/task').send({
                name: 'Daily',
                due_date: '2026-05-10',
                recurrence_type: 'daily',
                recurrence_interval: 1,
            });
            expect(created.status).toBe(201);

            const response = await agent
                .patch(`/api/task/${created.body.uid}`)
                .send({ recurrence_interval: -1 });
            expect(response.status).toBe(400);

            const stored = await Task.findOne({
                where: { uid: created.body.uid },
            });
            expect(stored.recurrence_interval).toBe(1);
        });

        it('returns next-iterations for a stored negative interval instead of hanging', async () => {
            // A row written before validation existed.
            const task = await Task.create({
                user_id: user.id,
                name: 'Legacy negative interval',
                recurrence_type: 'daily',
                recurrence_interval: -1,
                due_date: new Date('2026-01-01T23:59:59.999Z'),
            });

            const response = await agent.get(
                `/api/task/${task.uid}/next-iterations?startFromDate=2026-01-05`
            );
            expect(response.status).toBe(200);
            expect(response.body.iterations.map((i) => i.date)).toEqual([
                '2026-01-05',
                '2026-01-06',
                '2026-01-07',
                '2026-01-08',
                '2026-01-09',
                '2026-01-10',
            ]);
        });
    });
});
