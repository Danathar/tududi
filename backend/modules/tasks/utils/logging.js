const moment = require('moment-timezone');
const { logError } = require('../../../services/logService');
const { logTaskUpdate, logEvent } = require('../taskEventService');
const { parsePriority, parseStatus } = require('../core/parsers');
const {
    getSafeTimezone,
    utcToUserDateString,
} = require('../../../utils/timezone-utils');

// Priority and status arrive as names ('high', 'done'), numbers or numeric
// strings, but are stored as integers. Compare and log them as integers.
const ENUM_PARSERS = { priority: parsePriority, status: parseStatus };

function normalizeEnum(field, value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string' && value.trim() !== '' && !isNaN(value)) {
        return Number(value);
    }
    return ENUM_PARSERS[field](value);
}

// The calendar date (YYYY-MM-DD) a due date value names in the user's
// timezone. A stored due date is the user's local end-of-day as a UTC
// instant, so its UTC date is the next day for users west of UTC.
function dueDateInTimezone(value, timezone) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return utcToUserDateString(value, timezone);
    const local = moment.tz(String(value), timezone);
    return local.isValid() ? local.format('YYYY-MM-DD') : String(value);
}

async function resolveTimezone(timezone, userId) {
    if (timezone) return getSafeTimezone(timezone);
    const { User } = require('../../../models');
    const user = userId
        ? await User.findByPk(userId, { attributes: ['timezone'] })
        : null;
    return getSafeTimezone(user?.timezone);
}

function captureOldValues(task) {
    return {
        name: task.name,
        status: task.status,
        priority: task.priority,
        due_date: task.due_date,
        defer_until: task.defer_until,
        project_id: task.project_id,
        assigned_to: task.assigned_to,
        note: task.note,
        recurrence_type: task.recurrence_type,
        recurrence_interval: task.recurrence_interval,
        recurrence_end_date: task.recurrence_end_date,
        recurrence_weekday: task.recurrence_weekday,
        recurrence_month_day: task.recurrence_month_day,
        recurrence_week_of_month: task.recurrence_week_of_month,
        completion_based: task.completion_based,
        tags: task.Tags
            ? task.Tags.map((tag) => ({ id: tag.id, name: tag.name }))
            : [],
    };
}

async function logTaskChanges(
    task,
    oldValues,
    reqBody,
    tagsData,
    userId,
    source = 'web',
    timezone = null
) {
    try {
        const changes = {};
        const fields = [
            'name',
            'status',
            'priority',
            'project_id',
            'note',
            'recurrence_type',
            'recurrence_interval',
            'recurrence_end_date',
            'recurrence_weekday',
            'recurrence_month_day',
            'recurrence_week_of_month',
            'completion_based',
        ];

        fields.forEach((field) => {
            if (reqBody[field] === undefined) return;
            const newValue = ENUM_PARSERS[field]
                ? normalizeEnum(field, reqBody[field])
                : reqBody[field];
            if (newValue !== oldValues[field]) {
                changes[field] = {
                    oldValue: oldValues[field],
                    newValue,
                };
            }
        });

        if (reqBody.due_date !== undefined) {
            const userTimezone = await resolveTimezone(timezone, userId);
            const oldDateStr = dueDateInTimezone(
                oldValues.due_date,
                userTimezone
            );
            const newDateStr = dueDateInTimezone(
                reqBody.due_date,
                userTimezone
            );

            if (oldDateStr !== newDateStr) {
                changes.due_date = {
                    oldValue: oldDateStr,
                    newValue: reqBody.due_date || null,
                };
            }
        }

        if (reqBody.defer_until !== undefined) {
            const oldDeferStr = oldValues.defer_until
                ? oldValues.defer_until.toISOString()
                : null;
            const newDeferStr = reqBody.defer_until || null;

            if (oldDeferStr !== newDeferStr) {
                changes.defer_until = {
                    oldValue: oldValues.defer_until,
                    newValue: reqBody.defer_until,
                };
            }
        }

        if (Object.keys(changes).length > 0) {
            await logTaskUpdate(task.id, userId, changes, { source });
        }

        if (tagsData) {
            const newTags = tagsData.map((tag) => ({
                id: tag.id,
                name: tag.name,
            }));
            const oldTagNames = oldValues.tags.map((tag) => tag.name).sort();
            const newTagNames = newTags.map((tag) => tag.name).sort();

            if (JSON.stringify(oldTagNames) !== JSON.stringify(newTagNames)) {
                await logEvent({
                    taskId: task.id,
                    userId: userId,
                    eventType: 'tags_changed',
                    fieldName: 'tags',
                    oldValue: oldValues.tags,
                    newValue: newTags,
                    metadata: { source, action: 'tags_update' },
                });
            }
        }
    } catch (eventError) {
        logError('Error logging task update events:', eventError);
    }
}

module.exports = {
    captureOldValues,
    logTaskChanges,
};
