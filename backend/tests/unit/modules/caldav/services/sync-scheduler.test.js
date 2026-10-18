const cron = require('node-cron');

jest.mock('../../../../../modules/caldav/sync/sync-engine', () => ({}));
jest.mock(
    '../../../../../modules/caldav/repositories/calendar-repository',
    () => ({})
);
jest.mock(
    '../../../../../modules/caldav/repositories/remote-calendar-repository',
    () => ({})
);
jest.mock('../../../../../services/logService', () => ({
    logInfo: jest.fn(),
    logError: jest.fn(),
    logWarn: jest.fn(),
    logDebug: jest.fn(),
}));

const scheduler = require('../../../../../modules/caldav/services/sync-scheduler');

describe('CalDAV sync scheduler cron expression', () => {
    it('produces a valid expression for every interval from 1 to 1440', () => {
        for (let minutes = 1; minutes <= 1440; minutes++) {
            const expression = scheduler._getCronExpression(minutes);
            expect(cron.validate(expression)).toBe(true);
        }
    });

    it('keeps exact intervals that divide an hour', () => {
        expect(scheduler._getCronExpression(1)).toBe('* * * * *');
        expect(scheduler._getCronExpression(15)).toBe('*/15 * * * *');
        expect(scheduler._getCronExpression(30)).toBe('*/30 * * * *');
    });

    it('wakes more often, never less, for minutes that do not divide 60', () => {
        expect(scheduler._getCronExpression(7)).toBe('*/6 * * * *');
        expect(scheduler._getCronExpression(45)).toBe('*/30 * * * *');
    });

    it('handles hour and day intervals', () => {
        expect(scheduler._getCronExpression(60)).toBe('0 * * * *');
        expect(scheduler._getCronExpression(90)).toBe('0 * * * *');
        expect(scheduler._getCronExpression(360)).toBe('0 */6 * * *');
        expect(scheduler._getCronExpression(1440)).toBe('0 0 * * *');
    });

    it('still rejects values outside 1-1440', () => {
        expect(() => scheduler._getCronExpression(0)).toThrow();
        expect(() => scheduler._getCronExpression(1441)).toThrow();
    });
});
