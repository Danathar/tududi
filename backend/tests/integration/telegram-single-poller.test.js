'use strict';

const https = require('https');
const request = require('supertest');
const app = require('../../app');
const { User } = require('../../models');
const { getConfig } = require('../../config/config');
const jobLock = require('../../services/jobLock');
const entitlements = require('../../services/entitlementsService');
const { isPostgres } = require('../../utils/db-dialect');
const telegramPoller = require('../../modules/telegram/telegramPoller');
const telegramService = require('../../modules/telegram/service');
const {
    initializeTelegramPolling,
    rescanPolledUsers,
    RESCAN_INTERVAL_MS,
} = require('../../modules/telegram/telegramInitializer');
const {
    exportUserData,
    importUserData,
} = require('../../services/userDataTransfer');
const { createTestUser } = require('../helpers/testUtils');

const LEADER_JOB = 'telegram-poller';
const TOKEN = '123456789:ABCdefGHIjklMNOPQRSTUVwxyz-12345678';

// Fake https.get: every getUpdates answers with no updates.
const mockGetUpdates = () =>
    jest.spyOn(https, 'get').mockImplementation((url, options, callback) => {
        const res = {
            on: (event, handler) => {
                if (event === 'data')
                    handler(JSON.stringify({ ok: true, result: [] }));
                if (event === 'end') handler();
                return res;
            },
        };
        callback(res);
        const req = { on: () => req };
        return req;
    });

const isPolled = (user) => telegramPoller.getPolledUserIds().includes(user.id);

const storedWish = async (user) =>
    (await User.findByPk(user.id)).telegram_polling_enabled;

describe('Only the polling process polls Telegram', () => {
    let user, agent, getSpy, savedDisableTelegram;

    beforeEach(async () => {
        jest.spyOn(console, 'log').mockImplementation();
        getSpy = mockGetUpdates();

        const config = getConfig();
        savedDisableTelegram = config.disableTelegram;
        config.disableTelegram = false;

        user = await createTestUser({
            email: 'single-poller@example.com',
            telegram_bot_token: TOKEN,
        });
        agent = request.agent(app);
        await agent.post('/api/login').send({
            email: 'single-poller@example.com',
            password: 'password123',
        });
    });

    afterEach(async () => {
        getConfig().disableTelegram = savedDisableTelegram;
        for (const userId of telegramPoller.getPolledUserIds()) {
            telegramPoller.removeUser(userId);
        }
        telegramPoller.stopPolling();
        await jobLock.releaseLeadership(LEADER_JOB);
        jest.restoreAllMocks();
    });

    describe('POST /api/telegram/start-polling', () => {
        it('does not start the poller under DISABLE_TELEGRAM', async () => {
            // The lock is held, so the setting alone must keep the poller off.
            await jobLock.tryBecomeLeader(LEADER_JOB);
            getConfig().disableTelegram = true;

            const response = await agent.post('/api/telegram/start-polling');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.status.pollingHere).toBe(false);
            expect(telegramPoller.getStatus().running).toBe(false);
            expect(isPolled(user)).toBe(false);
            expect(await storedWish(user)).toBe(true);
        });

        it('does not start the poller without the leader lock', async () => {
            const response = await agent.post('/api/telegram/start-polling');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.message).toBe('Telegram polling requested');
            expect(response.body.status.wanted).toBe(true);
            expect(telegramPoller.getStatus().running).toBe(false);
            expect(isPolled(user)).toBe(false);
            expect(await storedWish(user)).toBe(true);
        });

        it('starts the poller at once on the leader', async () => {
            await jobLock.tryBecomeLeader(LEADER_JOB);

            const response = await agent.post('/api/telegram/start-polling');

            expect(response.status).toBe(200);
            expect(response.body.message).toBe('Telegram polling started');
            expect(response.body.status.running).toBe(true);
            expect(response.body.status.pollingHere).toBe(true);
            expect(isPolled(user)).toBe(true);
            expect(await storedWish(user)).toBe(true);
        });

        it('is covered by the first rescan when made before the lock is taken', async () => {
            // Single-process SQLite: isLeader is false until the startup
            // delay ends, so this request can only record the wish.
            await user.update({ telegram_polling_enabled: false });
            await agent.post('/api/telegram/start-polling');
            expect(isPolled(user)).toBe(false);

            await jobLock.tryBecomeLeader(LEADER_JOB);
            await rescanPolledUsers();

            expect(isPolled(user)).toBe(true);
        });
    });

    describe('POST /api/telegram/stop-polling', () => {
        it('stops at once on the leader and stores false, not NULL', async () => {
            await jobLock.tryBecomeLeader(LEADER_JOB);
            await telegramPoller.addUser(user);

            const response = await agent.post('/api/telegram/stop-polling');

            expect(response.status).toBe(200);
            expect(response.body.status.running).toBe(false);
            expect(response.body.status.wanted).toBe(false);
            expect(isPolled(user)).toBe(false);
            expect(await storedWish(user)).toBe(false);
        });

        it('leaves the poller alone without the lock but reaches the leader through the database', async () => {
            // This process's poller stands in for the leader's.
            await telegramPoller.addUser(user);

            const response = await agent.post('/api/telegram/stop-polling');

            expect(response.status).toBe(200);
            expect(isPolled(user)).toBe(true);
            expect(await storedWish(user)).toBe(false);

            await telegramPoller._pollUpdates();

            expect(getSpy).not.toHaveBeenCalled();
            expect(isPolled(user)).toBe(false);
        });
    });

    describe('stopPolling for a user that is gone', () => {
        it('still reports the stop', async () => {
            const result = await telegramService.stopPolling(user.id + 100000);

            expect(result.success).toBe(true);
        });
    });

    describe('GET /api/telegram/polling-status', () => {
        it('reports a bot with no recorded wish as wanted from a process that does not poll', async () => {
            const response = await agent.get('/api/telegram/polling-status');

            expect(response.status).toBe(200);
            expect(response.body.status.wanted).toBe(true);
            expect(response.body.status.running).toBe(true);
            expect(response.body.status.pollingHere).toBe(false);
        });

        it('reports a stopped bot as not wanted from a process that does not poll', async () => {
            await user.update({ telegram_polling_enabled: false });

            const response = await agent.get('/api/telegram/polling-status');

            expect(response.body.status.wanted).toBe(false);
            expect(response.body.status.running).toBe(false);
        });

        it('reports no bot as not wanted', async () => {
            await user.update({ telegram_bot_token: null });

            const response = await agent.get('/api/telegram/polling-status');

            expect(response.body.status.wanted).toBe(false);
            expect(response.body.status.running).toBe(false);
        });

        it('reports the real poller on the leader', async () => {
            await jobLock.tryBecomeLeader(LEADER_JOB);

            const before = await agent.get('/api/telegram/polling-status');
            expect(before.body.status.wanted).toBe(true);
            expect(before.body.status.running).toBe(false);

            await telegramPoller.addUser(user);

            const after = await agent.get('/api/telegram/polling-status');
            expect(after.body.status.running).toBe(true);
            expect(after.body.status.usersCount).toBe(1);
        });

        it('does not claim a poller under DISABLE_TELEGRAM on SQLite, where no other process exists', async () => {
            getConfig().disableTelegram = true;

            const response = await agent.get('/api/telegram/polling-status');

            expect(response.body.status.wanted).toBe(true);
            expect(response.body.status.running).toBe(isPostgres());
        });
    });

    describe('rescan', () => {
        beforeEach(async () => {
            await jobLock.tryBecomeLeader(LEADER_JOB);
        });

        it('picks up a bot added on another process', async () => {
            await user.update({ telegram_bot_token: null });
            await rescanPolledUsers();
            expect(isPolled(user)).toBe(false);

            // What a request served by another process leaves behind.
            await User.update(
                { telegram_bot_token: TOKEN },
                { where: { id: user.id } }
            );
            await rescanPolledUsers();

            expect(isPolled(user)).toBe(true);
            expect(telegramPoller.getStatus().running).toBe(true);
        });

        it('keeps polling a bot configured before the wish was stored', async () => {
            expect(await storedWish(user)).toBeNull();

            await rescanPolledUsers();

            expect(isPolled(user)).toBe(true);
        });

        it('does not bring back a stopped bot, as after a restart', async () => {
            await user.update({ telegram_polling_enabled: false });

            await rescanPolledUsers();

            expect(isPolled(user)).toBe(false);
        });

        it('removes a bot stopped on another process', async () => {
            await rescanPolledUsers();
            expect(isPolled(user)).toBe(true);

            await User.update(
                { telegram_polling_enabled: false },
                { where: { id: user.id } }
            );
            await rescanPolledUsers();

            expect(isPolled(user)).toBe(false);
            expect(telegramPoller.getStatus().running).toBe(false);
        });

        it('removes a bot whose token was cleared', async () => {
            await rescanPolledUsers();

            await User.update(
                { telegram_bot_token: null },
                { where: { id: user.id } }
            );
            await rescanPolledUsers();

            expect(isPolled(user)).toBe(false);
        });

        it('skips and removes a user whose plan lost Telegram', async () => {
            await rescanPolledUsers();
            expect(isPolled(user)).toBe(true);

            const hasFeature = jest
                .spyOn(entitlements, 'hasFeature')
                .mockResolvedValue(false);
            await rescanPolledUsers();

            expect(hasFeature).toHaveBeenCalledWith(user.id, 'telegram');
            expect(isPolled(user)).toBe(false);
        });

        it('leaves a bot it already polls alone', async () => {
            await rescanPolledUsers();
            expect(isPolled(user)).toBe(true);

            const addUser = jest.spyOn(telegramPoller, 'addUser');
            await rescanPolledUsers();

            expect(isPolled(user)).toBe(true);
            expect(addUser).not.toHaveBeenCalled();
        });

        it('keeps a wanted bot through a poll', async () => {
            await rescanPolledUsers();

            await telegramPoller._pollUpdates();

            expect(isPolled(user)).toBe(true);
        });

        it('keeps polling when the database cannot be read', async () => {
            await rescanPolledUsers();
            jest.spyOn(console, 'error').mockImplementation();
            jest.spyOn(User, 'findAll').mockRejectedValue(
                new Error('database is away')
            );

            await rescanPolledUsers();

            expect(isPolled(user)).toBe(true);
            expect(console.error).toHaveBeenCalledWith(
                'Error rescanning Telegram users:',
                'database is away'
            );
        });

        it('does nothing without the lock', async () => {
            await jobLock.releaseLeadership(LEADER_JOB);

            await rescanPolledUsers();

            expect(isPolled(user)).toBe(false);
        });

        it('does nothing under DISABLE_TELEGRAM', async () => {
            getConfig().disableTelegram = true;

            await rescanPolledUsers();

            expect(isPolled(user)).toBe(false);
        });

        it('does not read the database when Telegram is turned off', async () => {
            const config = getConfig();
            const savedTelegramEnabled = config.telegramEnabled;
            config.telegramEnabled = false;
            const findAll = jest.spyOn(User, 'findAll');

            try {
                await rescanPolledUsers();

                expect(findAll).not.toHaveBeenCalled();
            } finally {
                config.telegramEnabled = savedTelegramEnabled;
            }
        });
    });

    describe('startup', () => {
        it('rescans once it holds the lock, then about once a minute', async () => {
            const config = getConfig();
            const savedEnvironment = config.environment;
            config.environment = 'production';
            jest.spyOn(jobLock, 'tryBecomeLeader').mockResolvedValue(true);
            jest.spyOn(jobLock, 'isLeader').mockReturnValue(true);
            jest.spyOn(entitlements, 'hasFeature').mockResolvedValue(true);
            const findAll = jest.spyOn(User, 'findAll').mockResolvedValue([]);
            jest.useFakeTimers({ doNotFake: ['nextTick'] });

            try {
                await initializeTelegramPolling();
                expect(findAll).not.toHaveBeenCalled();

                await jest.advanceTimersByTimeAsync(10000);
                expect(findAll).toHaveBeenCalledTimes(1);
                expect(isPolled(user)).toBe(false);

                findAll.mockResolvedValue([
                    { id: user.id, telegram_bot_token: TOKEN },
                ]);
                await jest.advanceTimersByTimeAsync(RESCAN_INTERVAL_MS);

                expect(findAll).toHaveBeenCalledTimes(2);
                expect(isPolled(user)).toBe(true);

                await jest.advanceTimersByTimeAsync(2 * RESCAN_INTERVAL_MS);

                expect(findAll.mock.calls.length).toBeGreaterThanOrEqual(3);
            } finally {
                telegramPoller.removeUser(user.id);
                jest.clearAllTimers();
                jest.useRealTimers();
                config.environment = savedEnvironment;
            }
        });

        it('waits for the lock and tries again a minute later', async () => {
            const config = getConfig();
            const savedEnvironment = config.environment;
            config.environment = 'production';
            jest.spyOn(jobLock, 'tryBecomeLeader')
                .mockResolvedValueOnce(false)
                .mockResolvedValue(true);
            jest.spyOn(jobLock, 'isLeader').mockReturnValue(true);
            const findAll = jest.spyOn(User, 'findAll').mockResolvedValue([]);
            jest.useFakeTimers({ doNotFake: ['nextTick'] });

            try {
                await initializeTelegramPolling();

                await jest.advanceTimersByTimeAsync(10000);
                expect(findAll).not.toHaveBeenCalled();

                await jest.advanceTimersByTimeAsync(60000);
                expect(findAll).toHaveBeenCalledTimes(1);
            } finally {
                jest.clearAllTimers();
                jest.useRealTimers();
                config.environment = savedEnvironment;
            }
        });
    });

    describe('backups', () => {
        it('keeps a stop through a backup and restore', async () => {
            await user.update({ telegram_polling_enabled: false });
            const target = await createTestUser({
                email: 'single-poller-target@example.com',
            });

            const backup = await exportUserData(user.id);
            await importUserData(target.id, backup, { merge: true });

            expect(await storedWish(target)).toBe(false);
        });

        it('leaves the wish alone when an older backup has none', async () => {
            const target = await createTestUser({
                email: 'single-poller-target@example.com',
                telegram_polling_enabled: false,
            });

            const backup = await exportUserData(user.id);
            delete backup.user.telegram_polling_enabled;
            await importUserData(target.id, backup, { merge: true });

            expect(await storedWish(target)).toBe(false);
        });
    });
});
