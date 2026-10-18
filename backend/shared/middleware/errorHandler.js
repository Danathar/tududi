'use strict';

const { AppError } = require('../errors');
const { logError } = require('../../services/logService');

// body-parser (and raw-body) tag their errors with a `type`.
const CLIENT_ERROR_CODES = {
    'entity.parse.failed': 'INVALID_JSON',
    'entity.too.large': 'PAYLOAD_TOO_LARGE',
    'encoding.unsupported': 'UNSUPPORTED_ENCODING',
    'charset.unsupported': 'UNSUPPORTED_CHARSET',
    'request.aborted': 'REQUEST_ABORTED',
    'request.size.invalid': 'BAD_REQUEST',
    'stream.encoding.set': 'BAD_REQUEST',
    'parameters.too.many': 'BAD_REQUEST',
};

/**
 * Global error handler middleware.
 * Converts errors to consistent JSON responses.
 */
function errorHandler(err, req, res, next) {
    // Log error for debugging
    if (process.env.NODE_ENV === 'development') {
        console.error(err);
    } else {
        logError('Error:', err);
    }

    // Handle our custom AppError instances
    if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
    }

    // Handle Sequelize validation errors
    if (err.name === 'SequelizeValidationError') {
        return res.status(400).json({
            error: err.errors.map((e) => e.message).join(', '),
            code: 'VALIDATION_ERROR',
        });
    }

    // Handle Sequelize unique constraint errors
    if (err.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({
            error: 'A resource with this identifier already exists.',
            code: 'CONFLICT',
        });
    }

    // The CSRF middleware (lusca) sets the response to 403 and passes on a plain
    // Error, so without this the request would be answered as a server error.
    if (/^CSRF token (missing|mismatch)$/.test(err.message)) {
        return res.status(403).json({
            error: err.message,
            code: 'CSRF_ERROR',
        });
    }

    // Handle express-rate-limit trust proxy validation errors
    if (err.code === 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR') {
        return res.status(500).json({
            error: 'Trust proxy configuration error',
            message:
                'X-Forwarded-For header detected but trust proxy is not configured. ' +
                'Please set TUDUDI_TRUST_PROXY=true in your environment variables. ' +
                'See documentation: https://github.com/chrisvel/tududi#reverse-proxy-setup',
            code: 'TRUST_PROXY_ERROR',
        });
    }
    if (err.code === 'ERR_ERL_PERMISSIVE_TRUST_PROXY') {
        return res.status(500).json({
            error: 'Trust proxy configuration error',
            message:
                'Express trust proxy is set to true, which is permissive. ' +
                'Consider setting TUDUDI_TRUST_PROXY to a specific hop count (e.g. 1) instead of true.',
            code: 'TRUST_PROXY_ERROR',
        });
    }

    // Client errors raised by Express and body-parser (invalid JSON, a body
    // over the size limit, an unsupported encoding) carry a 4xx status and a
    // message that is safe to show. Only 5xx errors are masked below.
    const statusCode = err.statusCode || err.status || 500;
    if (statusCode >= 400 && statusCode < 500) {
        return res.status(statusCode).json({
            error: err.message,
            code: CLIENT_ERROR_CODES[err.type] || 'BAD_REQUEST',
        });
    }

    // Handle unknown errors
    const message =
        process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : err.message;

    res.status(statusCode).json({
        error: message,
        code: 'INTERNAL_ERROR',
    });
}

module.exports = errorHandler;
