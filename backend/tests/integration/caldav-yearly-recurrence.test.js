const request = require('supertest');
const moment = require('moment-timezone');
const app = require('../../app');
const { Task } = require('../../models');
const { createTestUser } = require('../helpers/testUtils');

// #297: a task that repeats every year, synced from a calendar app, was
// saved as "yearly" but stopped repeating after its first completion.

const EMAIL = 'yearly-sync@test.com';
const BASIC = 'Basic ' + Buffer.from(`${EMAIL}:password123`).toString('base64');

const vcalendar = (lines) =>
    [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Test//Yearly//EN',
        'BEGIN:VTODO',
        ...lines,
        'END:VTODO',
        'END:VCALENDAR',
        '',
    ].join('\r\n');

describe('CalDAV yearly recurrence (#297)', () => {
    let cookie;

    beforeEach(async () => {
        await createTestUser({
            email: EMAIL,
            verified: true,
            timezone: 'UTC',
        });
        const login = await request(app)
            .post('/api/login')
            .send({ email: EMAIL, password: 'password123' });
        cookie = login.headers['set-cookie'];
    });

    it('moves a synced yearly task to the same day next year on completion', async () => {
        const put = await request(app)
            .put(`/caldav/${EMAIL}/tasks/yearly-birthday.ics`)
            .set('Authorization', BASIC)
            .set('Content-Type', 'text/calendar')
            .send(
                vcalendar([
                    'UID:yearly-birthday',
                    'SUMMARY:Birthday',
                    'STATUS:NEEDS-ACTION',
                    'DUE;VALUE=DATE:20300520',
                    'RRULE:FREQ=YEARLY',
                ])
            );
        expect(put.status).toBe(201);

        const task = await Task.findOne({ where: { uid: 'yearly-birthday' } });
        expect(task.recurrence_type).toBe('yearly');
        expect(moment.utc(task.due_date).format('YYYY-MM-DD')).toBe(
            '2030-05-20'
        );

        const patch = await request(app)
            .patch(`/api/task/${task.uid}`)
            .set('Cookie', cookie)
            .send({ status: Task.STATUS.DONE });
        expect(patch.status).toBe(200);

        await task.reload();
        expect(task.status).toBe(Task.STATUS.NOT_STARTED);
        expect(task.completed_at).toBeNull();
        expect(moment.utc(task.due_date).format('YYYY-MM-DD')).toBe(
            '2031-05-20'
        );
    });
});
