const bcrypt = require('bcrypt');
const {
    sequelize,
    User,
    Task,
    CalDAVCalendar,
    CalDAVSyncState,
} = require('../../models');
const MergePhase = require('../../modules/caldav/sync/merge-phase');

describe('CalDAV merge phase with the same remote UID for two users', () => {
    let userA;
    let userB;
    let calendarA;
    let calendarB;
    const mergePhase = new MergePhase();

    const change = (etag = 'etag-1') => ({
        action: 'create_or_update',
        href: '/calendars/household/family-groceries.ics',
        etag,
        task: { uid: 'family-groceries', name: 'Groceries', status: 0 },
    });

    beforeAll(async () => {
        await sequelize.sync({ force: true });
    });

    beforeEach(async () => {
        const makeUser = (email) =>
            User.create({
                email,
                password_digest: bcrypt.hashSync('password', 10),
                verified: true,
            });
        userA = await makeUser('shared-a@test.com');
        userB = await makeUser('shared-b@test.com');

        const makeCalendar = (user, uid) =>
            CalDAVCalendar.create({
                uid,
                user_id: user.id,
                name: 'Household',
                enabled: true,
                sync_direction: 'bidirectional',
                sync_interval_minutes: 15,
                conflict_resolution: 'last_write_wins',
            });
        calendarA = await makeCalendar(userA, 'shared-cal-a');
        calendarB = await makeCalendar(userB, 'shared-cal-b');
    });

    afterEach(async () => {
        await CalDAVSyncState.destroy({ where: {} });
        await CalDAVCalendar.destroy({ where: {} });
        await Task.destroy({ where: {} });
        await User.destroy({ where: {} });
    });

    afterAll(async () => {
        await sequelize.close();
    });

    it('imports the task for the second user under its own uid', async () => {
        const first = await mergePhase.execute(calendarA, [change()]);
        expect(first.errors).toEqual([]);

        const second = await mergePhase.execute(calendarB, [change()]);
        expect(second.errors).toEqual([]);
        expect(second.merged).toHaveLength(1);

        const taskA = await Task.findOne({ where: { user_id: userA.id } });
        const taskB = await Task.findOne({ where: { user_id: userB.id } });
        expect(taskA.uid).toBe('family-groceries');
        expect(taskB).toBeTruthy();
        expect(taskB.uid).not.toBe('family-groceries');
        expect(taskB.name).toBe('Groceries');
    });

    it('updates the second user task on the next sync instead of duplicating it', async () => {
        await mergePhase.execute(calendarA, [change()]);
        await mergePhase.execute(calendarB, [change()]);

        const renamed = change('etag-2');
        renamed.task.name = 'Groceries and milk';
        const result = await mergePhase.execute(calendarB, [renamed]);
        expect(result.errors).toEqual([]);

        const tasksB = await Task.findAll({ where: { user_id: userB.id } });
        expect(tasksB).toHaveLength(1);
        expect(tasksB[0].name).toBe('Groceries and milk');
    });
});
