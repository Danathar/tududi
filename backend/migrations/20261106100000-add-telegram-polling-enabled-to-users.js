'use strict';

const {
    safeAddColumns,
    safeRemoveColumn,
} = require('../utils/migration-utils');

// The user's wish about Telegram polling. It stays nullable with no default on
// purpose: NULL means "no wish recorded", which counts as wanted, so bots that
// are configured today keep being polled after the upgrade with no backfill.
module.exports = {
    async up(queryInterface, Sequelize) {
        await safeAddColumns(queryInterface, 'users', [
            {
                name: 'telegram_polling_enabled',
                definition: { type: Sequelize.BOOLEAN, allowNull: true },
            },
        ]);
    },

    async down(queryInterface) {
        await safeRemoveColumn(
            queryInterface,
            'users',
            'telegram_polling_enabled'
        );
    },
};
