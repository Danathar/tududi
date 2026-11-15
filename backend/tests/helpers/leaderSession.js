'use strict';

const { sequelize } = require('../../models');
const { _lockKey } = require('../../services/jobLock');

// Ends, from another connection, the database session that holds the leader
// lock for `name`, as a database restart or a dropped connection would.
// PostgreSQL shows a one-argument advisory lock in pg_locks with the low 32
// bits of the key in objid and objsubid = 1.
async function endLeaderSession(name) {
    const [rows] = await sequelize.query(
        `SELECT pid FROM pg_locks
         WHERE locktype = 'advisory' AND objsubid = 1 AND granted
           AND objid::text::bigint = :objid`,
        { replacements: { objid: _lockKey(name) >>> 0 } }
    );
    if (rows.length !== 1) {
        throw new Error(`expected one session holding "${name}"`);
    }
    await sequelize.query('SELECT pg_terminate_backend(:pid)', {
        replacements: { pid: rows[0].pid },
    });
}

module.exports = { endLeaderSession };
