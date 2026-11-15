const {
    withJobLock,
    tryBecomeLeader,
    releaseLeadership,
    confirmLeadership,
    isLeader,
    _lockKey,
} = require('../../../services/jobLock');
const { endLeaderSession } = require('../../helpers/leaderSession');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('jobLock', () => {
    it('runs the job and returns its result', async () => {
        const res = await withJobLock('unit:simple', async () => 42);
        expect(res).toEqual({ ran: true, result: 42 });
    });

    it('skips a job that is already running under the same name', async () => {
        let concurrent = 0;
        let peak = 0;
        const job = async () => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            await sleep(50);
            concurrent -= 1;
            return 'done';
        };

        const [first, second] = await Promise.all([
            withJobLock('unit:overlap', job),
            withJobLock('unit:overlap', job),
        ]);

        expect(peak).toBe(1);
        expect([first.ran, second.ran].sort()).toEqual([false, true]);
    });

    it('lets different job names run at the same time', async () => {
        let concurrent = 0;
        let peak = 0;
        const job = async () => {
            concurrent += 1;
            peak = Math.max(peak, concurrent);
            await sleep(30);
            concurrent -= 1;
        };

        await Promise.all([
            withJobLock('unit:a', job),
            withJobLock('unit:b', job),
        ]);
        expect(peak).toBe(2);
    });

    it('releases the lock when the job throws', async () => {
        await expect(
            withJobLock('unit:throws', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');

        const again = await withJobLock('unit:throws', async () => 'ok');
        expect(again.ran).toBe(true);
    });

    it('hands out leadership once per process and releases it', async () => {
        expect(await tryBecomeLeader('unit:leader')).toBe(true);
        expect(isLeader('unit:leader')).toBe(true);
        expect(await tryBecomeLeader('unit:leader')).toBe(true);

        await releaseLeadership('unit:leader');
        expect(isLeader('unit:leader')).toBe(false);
    });

    describe('confirmLeadership', () => {
        beforeEach(() => {
            jest.spyOn(console, 'error').mockImplementation();
        });

        afterEach(async () => {
            await releaseLeadership('unit:confirm');
            jest.restoreAllMocks();
        });

        it('keeps a healthy leader', async () => {
            await tryBecomeLeader('unit:confirm');

            expect(await confirmLeadership('unit:confirm')).toBe(true);
            expect(await confirmLeadership('unit:confirm')).toBe(true);
            expect(isLeader('unit:confirm')).toBe(true);
        });

        it('reports false for a job this process does not lead', async () => {
            expect(await confirmLeadership('unit:confirm')).toBe(false);
            expect(isLeader('unit:confirm')).toBe(false);
        });

        it('notices when the database ends the session holding the lock', async () => {
            await tryBecomeLeader('unit:confirm');

            await endLeaderSession('unit:confirm');

            // isLeader cannot see it until someone checks.
            expect(isLeader('unit:confirm')).toBe(true);
            expect(await confirmLeadership('unit:confirm')).toBe(false);
            expect(isLeader('unit:confirm')).toBe(false);

            // The database really let the lock go, so it can be won again.
            expect(await tryBecomeLeader('unit:confirm')).toBe(true);
            expect(await confirmLeadership('unit:confirm')).toBe(true);
        });

        it('does not touch other leaders', async () => {
            await tryBecomeLeader('unit:confirm');
            await tryBecomeLeader('unit:other');

            try {
                await endLeaderSession('unit:confirm');
                expect(await confirmLeadership('unit:confirm')).toBe(false);

                expect(await confirmLeadership('unit:other')).toBe(true);
                expect(isLeader('unit:other')).toBe(true);
            } finally {
                await releaseLeadership('unit:other');
            }
        });
    });

    it('derives a stable 32-bit key from the job name', () => {
        expect(_lockKey('telegram-poller')).toBe(_lockKey('telegram-poller'));
        expect(_lockKey('a')).not.toBe(_lockKey('b'));
        expect(Number.isInteger(_lockKey('x'))).toBe(true);
        expect(Math.abs(_lockKey('x'))).toBeLessThan(2 ** 31);
    });
});
