const { Task, Notification, User } = require('../../../../models');
const {
    checkDeferredTasks,
} = require('../../../../modules/tasks/deferredTaskService');
const bcrypt = require('bcrypt');

const HOUR = 60 * 60 * 1000;

async function deferNotificationsFor(task) {
    const notifications = await Notification.findAll({
        where: { user_id: task.user_id, type: 'task_due_soon' },
    });
    return notifications.filter(
        (notification) =>
            notification.data?.taskUid === task.uid &&
            notification.data?.reason === 'defer_until_reached'
    );
}

describe('deferredTaskService', () => {
    let user;

    beforeEach(async () => {
        user = await User.create({
            email: 'deferred@example.com',
            password_digest: await bcrypt.hash('password123', 10),
        });
    });

    describe('checkDeferredTasks (#247)', () => {
        it('notifies an open task whose defer date was just reached', async () => {
            const task = await Task.create({
                name: 'Now active',
                user_id: user.id,
                status: Task.STATUS.NOT_STARTED,
                defer_until: new Date(Date.now() - HOUR),
            });

            await checkDeferredTasks();

            expect(await deferNotificationsFor(task)).toHaveLength(1);
        });

        it('does not notify cancelled or archived tasks', async () => {
            const cancelled = await Task.create({
                name: 'Cancelled',
                user_id: user.id,
                status: Task.STATUS.CANCELLED,
                defer_until: new Date(Date.now() - HOUR),
            });
            const archived = await Task.create({
                name: 'Archived',
                user_id: user.id,
                status: Task.STATUS.ARCHIVED,
                defer_until: new Date(Date.now() - HOUR),
            });

            await checkDeferredTasks();

            expect(await deferNotificationsFor(cancelled)).toHaveLength(0);
            expect(await deferNotificationsFor(archived)).toHaveLength(0);
        });

        it('keeps the same notification across runs instead of recreating it', async () => {
            const task = await Task.create({
                name: 'Notify once',
                user_id: user.id,
                status: Task.STATUS.NOT_STARTED,
                defer_until: new Date(Date.now() - HOUR),
            });

            await checkDeferredTasks();
            const [first] = await deferNotificationsFor(task);
            expect(first).toBeDefined();

            await checkDeferredTasks();
            const after = await deferNotificationsFor(task);

            expect(after).toHaveLength(1);
            expect(after[0].id).toBe(first.id);
        });

        it('does not notify a defer date that passed long ago', async () => {
            const task = await Task.create({
                name: 'Old defer',
                user_id: user.id,
                status: Task.STATUS.NOT_STARTED,
                defer_until: new Date(Date.now() - 30 * 24 * HOUR),
            });

            await checkDeferredTasks();

            expect(await deferNotificationsFor(task)).toHaveLength(0);
        });
    });
});
