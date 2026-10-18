'use strict';

const { ValidationError } = require('../shared/errors');

const DIRECTIONS = ['asc', 'desc'];

/**
 * Parse an `order_by` query value of the form `column` or `column:direction`
 * against an allow-list of columns. A missing direction defaults to `asc`.
 * Throws a ValidationError (400) for an unknown column or direction, or a
 * value that is not a single string.
 */
function parseOrderBy(value, allowedColumns) {
    if (typeof value !== 'string') {
        throw new ValidationError('order_by must be a string.');
    }

    const parts = value.split(':');
    const [column, direction = 'asc'] = parts;
    const normalizedDirection = direction.toLowerCase();

    if (parts.length > 2 || !allowedColumns.includes(column)) {
        throw new ValidationError('Invalid order column specified.');
    }
    if (!DIRECTIONS.includes(normalizedDirection)) {
        throw new ValidationError('Invalid order direction specified.');
    }

    return { column, direction: normalizedDirection };
}

/**
 * Parse an integer query parameter. A missing (or empty) value yields
 * `fallback`; anything that is not a whole number within [min, max] throws a
 * ValidationError (400).
 */
function parseIntegerParam(value, name, { min, max, fallback }) {
    if (value === undefined || value === '') {
        return fallback;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new ValidationError(`${name} must be an integer.`);
    }

    const text = String(value).trim();
    if (!/^-?\d+$/.test(text)) {
        throw new ValidationError(`${name} must be an integer.`);
    }

    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new ValidationError(`${name} must be between ${min} and ${max}.`);
    }

    return parsed;
}

module.exports = { parseOrderBy, parseIntegerParam };
