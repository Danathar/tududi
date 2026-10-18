'use strict';

const { ValidationError } = require('../../shared/errors');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const VALID_TASK_STATUS_FILTERS = ['active', 'completed', 'all'];

// Specific task statuses a search or view can be narrowed to, mapped to the
// Task.STATUS integers.
const TASK_STATUS_FILTERS = {
    not_started: 0,
    in_progress: 1,
    done: 2,
    archived: 3,
    waiting: 4,
    cancelled: 5,
    planned: 6,
};

/**
 * Return the value when it is a string (or absent); otherwise reject it.
 * Express parses repeated or bracketed params (q[]=a, q=a&q=b) into arrays
 * and objects, which would crash the string handling below.
 */
function requireStringParam(value, name) {
    if (value !== undefined && typeof value !== 'string') {
        throw new ValidationError(`${name} must be a string`);
    }
    return value;
}

/**
 * Parse an integer pagination param. Empty or absent values fall back to the
 * default; anything else must be an integer of at least `min`.
 */
function parseIntegerParam(value, name, fallback, min) {
    if (value === undefined) return fallback;
    requireStringParam(value, name);
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < min) {
        throw new ValidationError(
            `${name} must be an integer greater than or equal to ${min}`
        );
    }
    return parsed;
}

/**
 * Escape LIKE wildcards so user text matches literally. Use together with an
 * ESCAPE clause naming LIKE_ESCAPE_CHAR (SQLite has no default escape char).
 */
const LIKE_ESCAPE_CHAR = '!';

function escapeLike(text) {
    return text.replace(/[!%_]/g, (char) => LIKE_ESCAPE_CHAR + char);
}

/**
 * Parse and validate search query parameters.
 */
function parseSearchParams(query) {
    const {
        q,
        filters,
        priority,
        due,
        defer,
        tags: tagsParam,
        recurring,
        extras: extrasParam,
        limit: limitParam,
        offset: offsetParam,
        excludeSubtasks,
        status: statusParam,
        task_status: taskStatusParam,
        area_uid: areaUid,
        project_uid: projectUid,
    } = query;

    requireStringParam(q, 'q');
    requireStringParam(filters, 'filters');
    requireStringParam(tagsParam, 'tags');

    const searchQuery = q ? q.trim() : '';

    const filterTypes = filters
        ? filters.split(',').map((f) => f.trim())
        : ['Task', 'Project', 'Area', 'Note', 'Tag'];

    const status = VALID_TASK_STATUS_FILTERS.includes(statusParam)
        ? statusParam
        : undefined;

    const taskStatus = Object.prototype.hasOwnProperty.call(
        TASK_STATUS_FILTERS,
        taskStatusParam
    )
        ? TASK_STATUS_FILTERS[taskStatusParam]
        : undefined;

    const tagNames = tagsParam ? tagsParam.split(',').map((t) => t.trim()) : [];

    const extras =
        extrasParam && typeof extrasParam === 'string'
            ? extrasParam
                  .split(',')
                  .map((extra) => extra.trim())
                  .filter(Boolean)
            : [];

    const hasPagination = limitParam !== undefined || offsetParam !== undefined;
    const limit = Math.min(
        parseIntegerParam(limitParam, 'limit', DEFAULT_LIMIT, 1),
        MAX_LIMIT
    );
    const offset = parseIntegerParam(offsetParam, 'offset', 0, 0);

    return {
        searchQuery,
        filterTypes,
        priority,
        due,
        defer,
        tagNames,
        recurring,
        extras: new Set(extras),
        hasPagination,
        limit,
        offset,
        excludeSubtasks: excludeSubtasks === 'true',
        status,
        taskStatus,
        areaUid: typeof areaUid === 'string' ? areaUid.trim() : '',
        projectUid: typeof projectUid === 'string' ? projectUid.trim() : '',
    };
}

/**
 * Convert priority string to integer.
 */
function priorityToInt(priorityStr) {
    const priorityMap = {
        low: 0,
        medium: 1,
        high: 2,
    };
    return priorityMap[priorityStr] !== undefined
        ? priorityMap[priorityStr]
        : null;
}

module.exports = {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    LIKE_ESCAPE_CHAR,
    escapeLike,
    TASK_STATUS_FILTERS,
    parseSearchParams,
    priorityToInt,
};
