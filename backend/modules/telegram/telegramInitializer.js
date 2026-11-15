const { Op } = require('sequelize');
const telegramPoller = require('./telegramPoller');
const { User } = require('../../models');
const { getConfig } = require('../../config/config');
const jobLock = require('../../services/jobLock');
const config = getConfig();

const LEADER_JOB = 'telegram-poller';

// How often the polling process re-reads who should be polled. Also the
// longest a bot configured on another process waits before polling starts.
const RESCAN_INTERVAL_MS = 60000; // 1 minute

// Telegram's getUpdates confirms updates by offset, and the offsets live in
// this process's memory, so exactly one process may poll. Everything that
// touches the in-memory poller asks this first.
function canPollHere() {
    const { disableTelegram, telegramEnabled } = getConfig();
    return (
        !disableTelegram &&
        telegramEnabled === true &&
        jobLock.isLeader(LEADER_JOB)
    );
}

// Makes the in-memory poller match the database. The database is the record,
// so requests served by any process reach the poller through here. A failed
// read leaves the poller as it is and the next rescan tries again.
async function rescanPolledUsers() {
    if (!canPollHere()) return;

    try {
        const { hasFeature } = require('../../services/entitlementsService');

        // Find users with configured Telegram tokens
        const usersWithTelegram = await User.findAll({
            where: { telegram_bot_token: { [Op.ne]: null } },
        });

        const wanted = [];
        for (const user of usersWithTelegram) {
            if (!telegramPoller.isPollingWanted(user)) continue;
            if (await hasFeature(user.id, 'telegram')) wanted.push(user);
        }

        const polledIds = new Set(telegramPoller.getPolledUserIds());
        const wantedIds = new Set(wanted.map((user) => user.id));

        for (const userId of polledIds) {
            if (!wantedIds.has(userId)) telegramPoller.removeUser(userId);
        }

        const newUsers = wanted.filter((user) => !polledIds.has(user.id));
        if (newUsers.length > 0) {
            console.log(
                `Initializing Telegram polling for ${newUsers.length} user(s)...`
            );
        }
        for (const user of newUsers) {
            await telegramPoller.addUser(user);
        }
    } catch (error) {
        console.error('Error rescanning Telegram users:', error.message);
    }
}

// Empties this process's poller, for when it has lost the leader lock and
// another process may already be polling the same bots.
function stopPollingHere() {
    for (const userId of telegramPoller.getPolledUserIds()) {
        telegramPoller.removeUser(userId);
    }
}

// One run of the minute-by-minute rescan on the polling process. It first
// checks that the leader lock is still held: the database lets the lock go
// when the session behind it ends, and does not tell this process. Returns
// false, with the poller emptied, when the lock is gone.
async function rescanIfStillLeader() {
    if (!(await jobLock.confirmLeadership(LEADER_JOB))) {
        stopPollingHere();
        return false;
    }
    await rescanPolledUsers();
    return true;
}

async function initializeTelegramPolling() {
    if (
        config.environment === 'test' ||
        config.disableTelegram ||
        !config.telegramEnabled
    ) {
        return;
    }

    // Add a delay before starting Telegram polling to allow the system to settle
    // and prevent immediate error floods if Telegram is temporarily unreachable
    const startupDelay = 10000; // 10 seconds
    const leaderRetryDelay = 60000; // 1 minute

    // Whoever holds the leader lock polls; the others retry in case it goes
    // away. A process that loses the lock goes back to retrying, so it can
    // win it again or leave polling to the process that holds it now.
    const scheduleRescan = () => {
        setTimeout(async () => {
            if (await rescanIfStillLeader()) {
                scheduleRescan();
            } else {
                await startWhenLeader();
            }
        }, RESCAN_INTERVAL_MS);
    };

    const startWhenLeader = async () => {
        if (!(await jobLock.tryBecomeLeader(LEADER_JOB))) {
            setTimeout(startWhenLeader, leaderRetryDelay);
            return;
        }
        await rescanPolledUsers();
        scheduleRescan();
    };

    setTimeout(startWhenLeader, startupDelay);
}

module.exports = {
    initializeTelegramPolling,
    canPollHere,
    rescanPolledUsers,
    rescanIfStillLeader,
    RESCAN_INTERVAL_MS,
};
