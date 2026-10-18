const { Task } = require('../../../models');
const { ValidationError } = require('../../../shared/errors');

function parsePriority(priority) {
    if (priority === undefined) return null;
    return typeof priority === 'string'
        ? Task.getPriorityValue(priority)
        : priority;
}

function parseStatus(status, defaultStatus = Task.STATUS.NOT_STARTED) {
    if (status === undefined) return defaultStatus;
    return typeof status === 'string' ? Task.getStatusValue(status) : status;
}

// A rough task length in minutes; empty values clear it.
function parseEstimatedMinutes(value) {
    if (value === null || value === '' || value === 0) return null;
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 720) {
        throw new ValidationError(
            'estimated_minutes must be a whole number between 5 and 720'
        );
    }
    return minutes;
}

const TASK_STATUS_NAMES = [
    'not_started',
    'in_progress',
    'done',
    'archived',
    'waiting',
    'cancelled',
    'planned',
];

const RECURRENCE_TYPES = [
    'none',
    'daily',
    'weekly',
    'monthly',
    'monthly_weekday',
    'monthly_last_day',
    'yearly',
    'weekdays',
];

// Checks the fields of a task update that would otherwise be stored as sent
// (a blank name, an unknown status or recurrence type). Create already
// rejects a blank name.
function validateTaskUpdateInput(body) {
    if (
        body.name !== undefined &&
        (typeof body.name !== 'string' || !body.name.trim())
    ) {
        throw new ValidationError('Task name is required.');
    }
    if (
        body.status !== undefined &&
        typeof body.status === 'string' &&
        !TASK_STATUS_NAMES.includes(body.status)
    ) {
        throw new ValidationError(
            `Task status must be one of: ${TASK_STATUS_NAMES.join(', ')}`
        );
    }
    if (
        body.recurrence_type !== undefined &&
        !RECURRENCE_TYPES.includes(body.recurrence_type)
    ) {
        throw new ValidationError(
            `Task recurrence_type must be one of: ${RECURRENCE_TYPES.join(', ')}`
        );
    }
}

module.exports = {
    validateTaskUpdateInput,
    parsePriority,
    parseStatus,
    parseEstimatedMinutes,
};
