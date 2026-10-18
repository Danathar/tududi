'use strict';

// Tools that create or change data refuse arguments they do not declare, so a
// misspelled or unsupported field is an error rather than a silent no-op.
// Read tools stay lenient: an extra filter there changes nothing.
const WRITE_TOOL = /^(create|update|add)_/;

function matchesEnum(value, allowed) {
    return allowed.includes(value);
}

// Strings and booleans must arrive as such: the handlers call string methods
// on them. Numbers, arrays and objects are left to the handlers, which accept
// numeric strings, JSON-encoded arrays and the like from MCP clients.
function assertScalarType(key, value, type) {
    const types = [].concat(type || []);
    const checkable = types.every((t) => t === 'string' || t === 'boolean');
    if (!checkable || types.length === 0) return;
    if (!types.includes(typeof value)) {
        throw new Error(
            `Invalid value for ${key}: expected a ${types.join(' or ')}`
        );
    }
}

/**
 * Check a tool call's arguments against the tool's inputSchema: arguments
 * must be an object, required fields must be present, enum fields must hold
 * one of the listed values, and write tools reject undeclared fields.
 * Throws an Error whose message names the problem.
 */
function validateToolArguments(tool, args) {
    const schema = tool.inputSchema || {};
    const properties = schema.properties || {};
    const params = args === undefined || args === null ? {} : args;

    if (typeof params !== 'object' || Array.isArray(params)) {
        throw new Error(`Arguments for ${tool.name} must be an object`);
    }

    if (WRITE_TOOL.test(tool.name)) {
        const unsupported = Object.keys(params).filter(
            (key) => !(key in properties)
        );
        if (unsupported.length > 0) {
            throw new Error(
                `Unsupported field(s) for ${tool.name}: ${unsupported.join(', ')}`
            );
        }
    }

    const missing = (schema.required || []).filter(
        (key) => params[key] === undefined || params[key] === null
    );
    if (missing.length > 0) {
        throw new Error(
            `Missing required field(s) for ${tool.name}: ${missing.join(', ')}`
        );
    }

    for (const [key, definition] of Object.entries(properties)) {
        const value = params[key];
        // null clears a field on several tools; the handler decides on it
        if (value === undefined || value === null) continue;
        assertScalarType(key, value, definition.type);
        if (!Array.isArray(definition.enum)) continue;
        if (!matchesEnum(value, definition.enum)) {
            throw new Error(
                `Invalid value for ${key}: ${JSON.stringify(value)}. Allowed: ${definition.enum.join(', ')}`
            );
        }
    }
}

module.exports = { validateToolArguments };
