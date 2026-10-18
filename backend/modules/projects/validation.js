'use strict';

const { ValidationError } = require('../../shared/errors');
const { isValidUid, extractUidFromSlug } = require('../../utils/slug-utils');

/**
 * Validate project UID.
 */
function validateUid(uidOrSlug) {
    if (!uidOrSlug || typeof uidOrSlug !== 'string') {
        throw new ValidationError('Project UID is required.');
    }

    const uid = extractUidFromSlug(uidOrSlug);
    if (!uid || !isValidUid(uid)) {
        throw new ValidationError('Invalid project UID format.');
    }

    return uid;
}

/**
 * Validate project name.
 */
function validateName(name) {
    if (!name || typeof name !== 'string' || !name.trim()) {
        throw new ValidationError('Project name is required');
    }
    return name.trim();
}

const PROJECT_PRIORITY_NAMES = ['low', 'medium', 'high'];

/**
 * Validate a project status against the allowed values.
 */
function validateStatus(status, allowedStatuses) {
    if (!allowedStatuses.includes(status)) {
        throw new ValidationError(
            `Project status must be one of: ${allowedStatuses.join(', ')}`
        );
    }
    return status;
}

/**
 * Validate a project priority: a whole number from 0 to 2, or low, medium
 * or high. Empty values clear it.
 */
function validatePriority(priority) {
    if (priority === null || priority === undefined || priority === '') {
        return null;
    }
    if (
        PROJECT_PRIORITY_NAMES.includes(priority) ||
        (Number.isInteger(priority) && priority >= 0 && priority <= 2)
    ) {
        return priority;
    }
    throw new ValidationError(
        'Project priority must be 0, 1, 2, low, medium or high'
    );
}

/**
 * Safely format dates.
 */
function formatDate(date) {
    if (!date) return null;
    try {
        const dateObj = new Date(date);
        if (isNaN(dateObj.getTime())) return null;
        return dateObj.toISOString();
    } catch (error) {
        return null;
    }
}

module.exports = {
    validateUid,
    validateName,
    validateStatus,
    validatePriority,
    formatDate,
};
