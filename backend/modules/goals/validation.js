'use strict';

const { ValidationError } = require('../../shared/errors');

const HORIZONS = ['season', 'year'];
const STATUSES = ['active', 'achieved', 'paused', 'dropped'];

/**
 * Validate a goal title. Returns the trimmed title.
 */
function validateTitle(title) {
    if (typeof title !== 'string' || !title.trim()) {
        throw new ValidationError('Goal title is required');
    }
    return title.trim();
}

/**
 * Validate a goal horizon.
 */
function validateHorizon(horizon) {
    if (!HORIZONS.includes(horizon)) {
        throw new ValidationError(
            `Goal horizon must be one of: ${HORIZONS.join(', ')}`
        );
    }
    return horizon;
}

/**
 * Validate a goal status.
 */
function validateStatus(status) {
    if (!STATUSES.includes(status)) {
        throw new ValidationError(
            `Goal status must be one of: ${STATUSES.join(', ')}`
        );
    }
    return status;
}

module.exports = {
    validateTitle,
    validateHorizon,
    validateStatus,
};
