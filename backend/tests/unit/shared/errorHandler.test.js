const errorHandler = require('../../../shared/middleware/errorHandler');
const {
    AppError,
    NotFoundError,
    ValidationError,
    ConflictError,
    UnauthorizedError,
    ForbiddenError,
} = require('../../../shared/errors');

describe('errorHandler middleware', () => {
    let req, res, next;

    beforeEach(() => {
        req = {};
        res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        next = jest.fn();
    });

    // --- AppError subclasses ---

    it('should handle NotFoundError with 404', () => {
        const err = new NotFoundError('Task not found');
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Task not found',
            code: 'NOT_FOUND',
        });
    });

    it('should handle ValidationError with 400', () => {
        const err = new ValidationError('Title is required');
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Title is required',
            code: 'VALIDATION_ERROR',
        });
    });

    it('should handle ConflictError with 409', () => {
        const err = new ConflictError();
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Resource already exists',
            code: 'CONFLICT',
        });
    });

    it('should handle UnauthorizedError with 401', () => {
        const err = new UnauthorizedError();
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Unauthorized',
            code: 'UNAUTHORIZED',
        });
    });

    it('should handle ForbiddenError with 403', () => {
        const err = new ForbiddenError();
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Forbidden',
            code: 'FORBIDDEN',
        });
    });

    it('should handle generic AppError with custom status', () => {
        const err = new AppError('Rate limited', 429, 'RATE_LIMITED');
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Rate limited',
            code: 'RATE_LIMITED',
        });
    });

    // --- Sequelize errors ---

    it('should handle SequelizeValidationError with 400', () => {
        const err = {
            name: 'SequelizeValidationError',
            errors: [
                { message: 'email must be unique' },
                { message: 'name cannot be null' },
            ],
        };
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: 'email must be unique, name cannot be null',
            code: 'VALIDATION_ERROR',
        });
    });

    it('should handle SequelizeUniqueConstraintError with 409', () => {
        const err = { name: 'SequelizeUniqueConstraintError' };
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith({
            error: 'A resource with this identifier already exists.',
            code: 'CONFLICT',
        });
    });

    // --- CSRF errors ---

    it.each(['CSRF token missing', 'CSRF token mismatch'])(
        'should answer "%s" with 403 and a CSRF code',
        (message) => {
            errorHandler(new Error(message), req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith({
                error: message,
                code: 'CSRF_ERROR',
            });
        }
    );

    it('should not treat other errors that mention CSRF as CSRF errors', () => {
        errorHandler(new Error('CSRF token missing in log'), req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
    });

    // --- Unknown errors ---

    it('should handle unknown errors with 500 in non-production', () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'test';

        const err = new Error('Something unexpected');
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Something unexpected',
            code: 'INTERNAL_ERROR',
        });

        process.env.NODE_ENV = originalEnv;
    });

    it('should hide error message in production', () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        const err = new Error('Database credentials leaked');
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
        });

        process.env.NODE_ENV = originalEnv;
    });

    it('should use statusCode from unknown error if present', () => {
        const err = new Error('Bad gateway');
        err.statusCode = 502;
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(502);
    });

    it('should default to 500 when no statusCode on unknown error', () => {
        const err = new Error('Oops');
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(500);
    });

    // --- Client errors from Express / body-parser ---

    it('should keep the message and use INVALID_JSON for a body-parser parse error', () => {
        const err = new SyntaxError('Expected property name');
        err.statusCode = 400;
        err.type = 'entity.parse.failed';
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Expected property name',
            code: 'INVALID_JSON',
        });
    });

    it('should use PAYLOAD_TOO_LARGE for an oversized body', () => {
        const err = new Error('request entity too large');
        err.statusCode = 413;
        err.type = 'entity.too.large';
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(413);
        expect(res.json).toHaveBeenCalledWith({
            error: 'request entity too large',
            code: 'PAYLOAD_TOO_LARGE',
        });
    });

    it('should not mask a 4xx message in production', () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        const err = new SyntaxError('Unexpected token');
        err.status = 400;
        err.type = 'entity.parse.failed';
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Unexpected token',
            code: 'INVALID_JSON',
        });

        process.env.NODE_ENV = originalEnv;
    });

    it('should fall back to BAD_REQUEST for other 4xx errors', () => {
        const err = new Error('Teapot');
        err.statusCode = 418;
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(418);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Teapot',
            code: 'BAD_REQUEST',
        });
    });

    it('should still mask 5xx messages in production', () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';

        const err = new Error('Upstream exploded');
        err.statusCode = 502;
        errorHandler(err, req, res, next);

        expect(res.status).toHaveBeenCalledWith(502);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
        });

        process.env.NODE_ENV = originalEnv;
    });
});
