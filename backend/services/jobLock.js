const crypto = require('crypto');
const { sequelize } = require('../models');
const { logError, logInfo } = require('./logService');

// Background jobs (task summaries, due-task notifications, CalDAV sync,
// Telegram polling) used to run in every process. With two app containers
// that means duplicate notifications and stolen Telegram updates. A
// PostgreSQL advisory lock makes exactly one process run each job.

// Stable 32-bit key for pg advisory locks, derived from the job name.
const lockKey = (name) =>
    crypto.createHash('sha256').update(name).digest().readInt32BE(0);

const runningLocally = new Set();

// Runs `fn` if no other process (or this one) is already running the job
// named `name`. Returns { ran: true, result } or { ran: false }.
async function withJobLock(name, fn) {
    if (runningLocally.has(name)) {
        return { ran: false };
    }

    // A transaction-scoped advisory lock releases itself when the
    // transaction ends, even if the process dies mid-job.
    const tx = await sequelize.transaction();
    try {
        const [[{ locked }]] = await sequelize.query(
            'SELECT pg_try_advisory_xact_lock(:key) AS locked',
            { replacements: { key: lockKey(name) }, transaction: tx }
        );
        if (!locked) {
            await tx.rollback();
            return { ran: false };
        }

        runningLocally.add(name);
        try {
            const result = await fn();
            return { ran: true, result };
        } finally {
            runningLocally.delete(name);
            await tx.rollback();
        }
    } catch (error) {
        if (!tx.finished) {
            await tx.rollback().catch(() => {});
        }
        throw error;
    }
}

// Long-lived leadership for jobs that must not switch processes between
// runs (the Telegram poller keeps per-bot update offsets in memory). The
// lock is held by an open transaction until the process exits or the
// database session behind it ends. PostgreSQL drops the lock when the
// session ends (a server restart, a dropped connection, pg_terminate_backend,
// idle_in_transaction_session_timeout) without telling this process, so
// callers must check confirmLeadership() regularly.
const leaderTransactions = new Map();

async function tryBecomeLeader(name) {
    if (leaderTransactions.has(name)) {
        return true;
    }

    const tx = await sequelize.transaction();
    try {
        const [[{ locked }]] = await sequelize.query(
            'SELECT pg_try_advisory_xact_lock(:key) AS locked',
            { replacements: { key: lockKey(name) }, transaction: tx }
        );
        if (!locked) {
            await tx.rollback();
            return false;
        }
        leaderTransactions.set(name, tx);
        logInfo(`This process is now the leader for "${name}"`);
        return true;
    } catch (error) {
        await tx.rollback().catch(() => {});
        logError(`Failed to acquire leader lock for "${name}":`, error);
        return false;
    }
}

async function releaseLeadership(name) {
    const tx = leaderTransactions.get(name);
    leaderTransactions.delete(name);
    if (tx && !tx.finished) {
        await tx.rollback().catch(() => {});
    }
}

// Checks that the session holding the leader lock is still alive. If it is
// not, forgets the leadership and returns false, so the caller can stop its
// job and try to win the lock again.
async function confirmLeadership(name) {
    const tx = leaderTransactions.get(name);
    if (!tx) {
        return false;
    }

    try {
        if (tx.finished) {
            throw new Error('the leader transaction has already ended');
        }
        await sequelize.query('SELECT 1', { transaction: tx });
        return true;
    } catch (error) {
        if (leaderTransactions.get(name) === tx) {
            leaderTransactions.delete(name);
        }
        if (!tx.finished) {
            await tx.rollback().catch(() => {});
        }
        logError(`Lost leadership for "${name}":`, error);
        return false;
    }
}

function isLeader(name) {
    return leaderTransactions.has(name);
}

module.exports = {
    withJobLock,
    tryBecomeLeader,
    releaseLeadership,
    confirmLeadership,
    isLeader,
    _lockKey: lockKey,
};
