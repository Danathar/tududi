'use strict';

const https = require('https');
const request = require('supertest');
const app = require('../../app');
const { User, InboxItem } = require('../../models');
const telegramPoller = require('../../modules/telegram/telegramPoller');
const { createTestUser } = require('../helpers/testUtils');

// Fake https.get: answers getUpdates with the given updates.
const mockGetUpdates = (updates) =>
    jest.spyOn(https, 'get').mockImplementation((url, options, callback) => {
        const res = {
            on: (event, handler) => {
                if (event === 'data')
                    handler(JSON.stringify({ ok: true, result: updates }));
                if (event === 'end') handler();
                return res;
            },
        };
        callback(res);
        const req = { on: () => req };
        return req;
    });

// Fake https.request: every sendMessage succeeds.
const mockSendMessage = () =>
    jest.spyOn(https, 'request').mockImplementation((url, options, cb) => {
        const res = {
            on: (event, handler) => {
                if (event === 'data') handler(JSON.stringify({ ok: true }));
                if (event === 'end') handler();
                return res;
            },
        };
        cb(res);
        return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    });

describe('Telegram poller picks up profile changes', () => {
    let user;

    beforeEach(async () => {
        jest.spyOn(console, 'log').mockImplementation();
        user = await createTestUser({
            email: 'poller-refresh@example.com',
            telegram_bot_token: 'old-token',
            telegram_allowed_users: 'alice',
            telegram_chat_id: '555',
        });
        telegramPoller.stopPolling();
        telegramPoller.removeUser(user.id);
    });

    afterEach(() => {
        telegramPoller.stopPolling();
        telegramPoller.removeUser(user.id);
        jest.restoreAllMocks();
    });

    const aliceUpdate = (updateId) => ({
        update_id: updateId,
        message: {
            message_id: updateId,
            from: { id: 1, username: 'alice' },
            chat: { id: 555 },
            text: `hello from alice ${updateId}`,
        },
    });

    it('applies an allow-list change on the next poll', async () => {
        await telegramPoller.addUser(await User.findByPk(user.id));
        await User.update(
            { telegram_allowed_users: 'bob' },
            { where: { id: user.id } }
        );
        mockGetUpdates([aliceUpdate(9001)]);
        mockSendMessage();

        await telegramPoller._pollUpdates();

        expect(await InboxItem.count({ where: { user_id: user.id } })).toBe(0);
    });

    it('stops polling the old bot once the token is cleared', async () => {
        await telegramPoller.addUser(await User.findByPk(user.id));
        await User.update(
            { telegram_bot_token: null },
            { where: { id: user.id } }
        );
        const getSpy = mockGetUpdates([aliceUpdate(9002)]);

        await telegramPoller._pollUpdates();

        expect(getSpy).not.toHaveBeenCalled();
        expect(telegramPoller.getStatus().usersCount).toBe(0);
    });

    it('polls with the new token after it changes', async () => {
        await telegramPoller.addUser(await User.findByPk(user.id));
        await User.update(
            { telegram_bot_token: 'new-token' },
            { where: { id: user.id } }
        );
        const getSpy = mockGetUpdates([]);

        await telegramPoller._pollUpdates();

        expect(getSpy).toHaveBeenCalledTimes(1);
        expect(getSpy.mock.calls[0][0]).toContain('botnew-token/');
    });

    it('resets telegram_chat_id when the profile token changes', async () => {
        const agent = request.agent(app);
        await agent.post('/api/login').send({
            email: 'poller-refresh@example.com',
            password: 'password123',
        });

        const response = await agent
            .patch('/api/profile')
            .send({ telegram_bot_token: 'another-token' });

        expect(response.status).toBe(200);
        const reloaded = await User.findByPk(user.id);
        expect(reloaded.telegram_bot_token).toBe('another-token');
        expect(reloaded.telegram_chat_id).toBeNull();
    });

    it('keeps telegram_chat_id when the profile token is unchanged', async () => {
        const agent = request.agent(app);
        await agent.post('/api/login').send({
            email: 'poller-refresh@example.com',
            password: 'password123',
        });

        await agent
            .patch('/api/profile')
            .send({ telegram_bot_token: 'old-token' });

        const reloaded = await User.findByPk(user.id);
        expect(reloaded.telegram_chat_id).toBe('555');
    });
});
