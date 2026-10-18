const cron = require('node-cron');
const logger = require('../../../services/logService');
const syncEngine = require('../sync/sync-engine');
const CalendarRepository = require('../repositories/calendar-repository');
const RemoteCalendarRepository = require('../repositories/remote-calendar-repository');

class SyncScheduler {
    constructor() {
        this.jobs = new Map();
        this.isInitialized = false;
        this.globalJob = null;
    }

    async initialize() {
        if (this.isInitialized) {
            logger.logInfo('CalDAV sync scheduler already initialized');
            return;
        }

        logger.logInfo('Initializing CalDAV sync scheduler');

        const syncIntervalMinutes = parseInt(
            process.env.CALDAV_DEFAULT_SYNC_INTERVAL || '15',
            10
        );

        const cronExpression = this._getCronExpression(syncIntervalMinutes);

        this.globalJob = cron.schedule(cronExpression, async () => {
            const { withJobLock } = require('../../../services/jobLock');
            await withJobLock('caldav-sync', () => this.syncAllDueCalendars());
        });

        this.isInitialized = true;
        logger.logInfo(
            `CalDAV sync scheduler initialized with ${syncIntervalMinutes} minute interval`
        );
    }

    async syncAllDueCalendars() {
        try {
            logger.logInfo('Starting scheduled sync for all due calendars');

            const dueCalendars = await CalendarRepository.findDueForSync();

            logger.logInfo(
                `Found ${dueCalendars.length} calendars due for sync`
            );

            for (const calendar of dueCalendars) {
                try {
                    await this._syncCalendar(calendar);
                } catch (error) {
                    logger.logError(
                        `Failed to sync calendar ${calendar.id}: ${error.message}`,
                        error
                    );
                }
            }

            logger.logInfo('Completed scheduled sync for all due calendars');
        } catch (error) {
            logger.logError(
                `Error during scheduled sync: ${error.message}`,
                error
            );
        }
    }

    async _syncCalendar(calendar, options = {}) {
        try {
            const {
                hasFeature,
            } = require('../../../services/entitlementsService');
            if (!(await hasFeature(calendar.user_id, 'caldav'))) {
                return;
            }
            logger.logInfo(
                `Syncing calendar ${calendar.id} for user ${calendar.user_id}`
            );

            const result = await syncEngine.syncCalendar(
                calendar.id,
                calendar.user_id,
                {
                    direction: calendar.sync_direction || 'bidirectional',
                    dryRun: options.dryRun === true,
                    force: options.force === true,
                }
            );

            if (result.success) {
                logger.logInfo(
                    `Successfully synced calendar ${calendar.id}: ${result.stats.pulled} pulled, ${result.stats.pushed} pushed, ${result.stats.conflicts} conflicts`
                );
            } else {
                logger.logWarn(
                    `Sync completed with errors for calendar ${calendar.id}`
                );
            }

            return result;
        } catch (error) {
            logger.logError(
                `Failed to sync calendar ${calendar.id}: ${error.message}`,
                error
            );

            if (!options.dryRun) {
                await CalendarRepository.updateSyncStatus(
                    calendar.id,
                    'error',
                    error.message
                );
            }

            throw error;
        }
    }

    async syncCalendarById(calendarId, userId, options = {}) {
        const calendar = await CalendarRepository.findById(calendarId);

        if (!calendar) {
            throw new Error(`Calendar ${calendarId} not found`);
        }

        if (calendar.user_id !== userId) {
            throw new Error('Unauthorized access to calendar');
        }

        return await this._syncCalendar(calendar, options);
    }

    async syncUserCalendars(userId, options = {}) {
        logger.logInfo(`Syncing all calendars for user ${userId}`);

        const calendars = await CalendarRepository.findByUserId(userId);
        const results = [];

        for (const calendar of calendars) {
            if (!calendar.enabled && !options.force) {
                logger.logInfo(
                    `Skipping disabled calendar ${calendar.id} for user ${userId}`
                );
                continue;
            }

            try {
                const result = await this._syncCalendar(calendar, options);
                results.push(result);
            } catch (error) {
                logger.logError(
                    `Failed to sync calendar ${calendar.id}: ${error.message}`,
                    error
                );
                results.push({
                    calendarId: calendar.id,
                    success: false,
                    error: error.message,
                });
            }
        }

        return {
            userId,
            totalCalendars: calendars.length,
            syncedCalendars: results.filter((r) => r.success).length,
            failedCalendars: results.filter((r) => !r.success).length,
            results,
        };
    }

    _getCronExpression(minutes) {
        if (minutes < 1 || minutes > 1440) {
            throw new Error(
                'Sync interval must be between 1 and 1440 minutes (24 hours)'
            );
        }

        // This expression is only how often the scheduler wakes up to look
        // for calendars that are due; each calendar has its own interval. So
        // a value that does not divide evenly into an hour or a day wakes up
        // at the nearest shorter interval that does, instead of producing an
        // expression such as `0 */0 * * *` that node-cron rejects.
        if (minutes < 60) {
            const step = this._largestDivisorAtMost(60, minutes);
            return step === 1 ? '* * * * *' : `*/${step} * * * *`;
        }

        const hours = Math.floor(minutes / 60);
        if (hours >= 24) {
            return '0 0 * * *';
        }

        const hourStep = this._largestDivisorAtMost(24, hours);
        return hourStep === 1 ? '0 * * * *' : `0 */${hourStep} * * *`;
    }

    _largestDivisorAtMost(total, limit) {
        for (let candidate = limit; candidate > 1; candidate--) {
            if (total % candidate === 0) {
                return candidate;
            }
        }
        return 1;
    }

    async shutdown() {
        logger.logInfo('Shutting down CalDAV sync scheduler');

        if (this.globalJob) {
            this.globalJob.stop();
            this.globalJob = null;
        }

        for (const [calendarId, job] of this.jobs.entries()) {
            job.stop();
            this.jobs.delete(calendarId);
        }

        this.isInitialized = false;
        logger.logInfo('CalDAV sync scheduler shut down');
    }

    getStatus() {
        return {
            initialized: this.isInitialized,
            activeJobs: this.jobs.size,
            globalJobActive: this.globalJob !== null,
        };
    }
}

module.exports = new SyncScheduler();
