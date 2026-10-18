const {
    parseOrderBy,
    parseIntegerParam,
} = require('../../../utils/list-params');
const { ValidationError } = require('../../../shared/errors');

describe('list-params', () => {
    describe('parseOrderBy', () => {
        const columns = ['title', 'created_at'];

        it('parses column and direction', () => {
            expect(parseOrderBy('created_at:desc', columns)).toEqual({
                column: 'created_at',
                direction: 'desc',
            });
        });

        it('defaults the direction to asc', () => {
            expect(parseOrderBy('title', columns)).toEqual({
                column: 'title',
                direction: 'asc',
            });
        });

        it('normalizes the direction case', () => {
            expect(parseOrderBy('title:DESC', columns).direction).toBe('desc');
        });

        it.each([
            ['bogus:asc'],
            ['title:sideways'],
            ['title:'],
            ['title:asc:desc'],
            [''],
        ])('rejects %p', (value) => {
            expect(() => parseOrderBy(value, columns)).toThrow(ValidationError);
        });

        it('rejects non-string values', () => {
            expect(() => parseOrderBy(['title', 'title'], columns)).toThrow(
                ValidationError
            );
            expect(() => parseOrderBy({ a: 1 }, columns)).toThrow(
                ValidationError
            );
        });
    });

    describe('parseIntegerParam', () => {
        const opts = { min: 1, max: 100, fallback: 20 };

        it('returns the fallback when missing', () => {
            expect(parseIntegerParam(undefined, 'limit', opts)).toBe(20);
            expect(parseIntegerParam('', 'limit', opts)).toBe(20);
        });

        it('parses numeric strings and numbers', () => {
            expect(parseIntegerParam('50', 'limit', opts)).toBe(50);
            expect(parseIntegerParam(7, 'limit', opts)).toBe(7);
        });

        it.each([['abc'], ['1.5'], ['10x'], ['0'], ['-3'], ['101'], ['1e3']])(
            'rejects %p',
            (value) => {
                expect(() => parseIntegerParam(value, 'limit', opts)).toThrow(
                    ValidationError
                );
            }
        );

        it('rejects arrays and objects', () => {
            expect(() => parseIntegerParam(['1', '2'], 'limit', opts)).toThrow(
                ValidationError
            );
            expect(() => parseIntegerParam({ a: 1 }, 'limit', opts)).toThrow(
                ValidationError
            );
        });
    });
});
