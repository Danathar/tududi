const {
    calculateNextDueDate,
    calculateDailyRecurrence,
    calculateWeeklyRecurrence,
    calculateMonthlyRecurrence,
    calculateMonthlyWeekdayRecurrence,
    calculateMonthlyLastDayRecurrence,
    calculateVirtualOccurrences,
    normalizeRecurrenceInterval,
} = require('../../../../modules/tasks/recurringTaskService');
const moment = require('moment-timezone');
const {
    processDueDateForStorage,
} = require('../../../../utils/timezone-utils');
const { Task } = require('../../../../models');

describe('RecurringTaskService - UTC Consistency', () => {
    describe('calculateDailyRecurrence', () => {
        it('should add days using UTC date methods', () => {
            const startDate = new Date(Date.UTC(2026, 0, 15, 23, 59, 59, 999));
            const result = calculateDailyRecurrence(startDate, 1);

            expect(result.getUTCDate()).toBe(16);
            expect(result.getUTCMonth()).toBe(0);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should handle month boundaries in UTC', () => {
            const jan31 = new Date(Date.UTC(2026, 0, 31, 12, 0, 0, 0));
            const result = calculateDailyRecurrence(jan31, 1);

            expect(result.getUTCDate()).toBe(1);
            expect(result.getUTCMonth()).toBe(1);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should handle year boundaries in UTC', () => {
            const dec31 = new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999));
            const result = calculateDailyRecurrence(dec31, 1);

            expect(result.getUTCDate()).toBe(1);
            expect(result.getUTCMonth()).toBe(0);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should preserve time component', () => {
            const startDate = new Date(Date.UTC(2026, 0, 15, 23, 59, 59, 999));
            const result = calculateDailyRecurrence(startDate, 1);

            expect(result.getUTCHours()).toBe(23);
            expect(result.getUTCMinutes()).toBe(59);
            expect(result.getUTCSeconds()).toBe(59);
            expect(result.getUTCMilliseconds()).toBe(999);
        });

        it('should work correctly for large intervals', () => {
            const startDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
            const result = calculateDailyRecurrence(startDate, 365);

            expect(result.getUTCDate()).toBe(1);
            expect(result.getUTCMonth()).toBe(0);
            expect(result.getUTCFullYear()).toBe(2027);
        });

        it('should work correctly with interval=7 (weekly equivalent)', () => {
            const monday = new Date(Date.UTC(2026, 2, 9, 0, 0, 0, 0));
            const result = calculateDailyRecurrence(monday, 7);

            expect(result.getUTCDate()).toBe(16);
            expect(result.getUTCDay()).toBe(1);
        });
    });

    describe('calculateWeeklyRecurrence', () => {
        it('should calculate next weekday using UTC day of week', () => {
            const tuesday = new Date(Date.UTC(2026, 2, 10, 12, 0, 0, 0));
            const result = calculateWeeklyRecurrence(tuesday, 1, 4, null);

            expect(result.getUTCDay()).toBe(4);
            expect(result.getUTCDate()).toBe(12);
        });

        it('should handle week boundaries across UTC midnight', () => {
            const saturday = new Date(Date.UTC(2026, 2, 14, 23, 59, 59, 999));
            const result = calculateWeeklyRecurrence(saturday, 1, 1, null);

            expect(result.getUTCDay()).toBe(1);
            expect(result.getUTCDate()).toBe(16);
        });

        it('should handle bi-weekly recurrence', () => {
            const monday = new Date(Date.UTC(2026, 2, 9, 0, 0, 0, 0));
            const result = calculateWeeklyRecurrence(monday, 2, 1, null);

            expect(result.getUTCDate()).toBe(23);
            expect(result.getUTCDay()).toBe(1);
        });

        it('should handle multiple weekdays correctly', () => {
            const tuesday = new Date(Date.UTC(2026, 2, 10, 0, 0, 0, 0));
            const weekdays = [2, 4];
            const result = calculateWeeklyRecurrence(
                tuesday,
                1,
                null,
                weekdays
            );

            expect(result.getUTCDay()).toBe(4);
            expect(result.getUTCDate()).toBe(12);
        });

        it('should wrap to next week when past all weekdays in current week', () => {
            const friday = new Date(Date.UTC(2026, 2, 13, 0, 0, 0, 0));
            const weekdays = [1, 3];
            const result = calculateWeeklyRecurrence(friday, 1, null, weekdays);

            expect(result.getUTCDay()).toBe(1);
            expect(result.getUTCDate()).toBe(16);
        });

        it('should handle month boundaries when wrapping weeks', () => {
            const thursday = new Date(Date.UTC(2026, 0, 29, 0, 0, 0, 0));
            const result = calculateWeeklyRecurrence(thursday, 1, 1, null);

            expect(result.getUTCDay()).toBe(1);
            expect(result.getUTCMonth()).toBe(1);
            expect(result.getUTCDate()).toBe(2);
        });

        it('should preserve time component', () => {
            const tuesday = new Date(Date.UTC(2026, 2, 10, 14, 30, 45, 123));
            const result = calculateWeeklyRecurrence(tuesday, 1, 4, null);

            expect(result.getUTCHours()).toBe(14);
            expect(result.getUTCMinutes()).toBe(30);
            expect(result.getUTCSeconds()).toBe(45);
            expect(result.getUTCMilliseconds()).toBe(123);
        });
    });

    describe('calculateMonthlyRecurrence', () => {
        it('should use UTC month and date for calculations', () => {
            const jan15 = new Date(Date.UTC(2026, 0, 15, 12, 0, 0, 0));
            const result = calculateMonthlyRecurrence(jan15, 1, 15);

            expect(result.getUTCDate()).toBe(15);
            expect(result.getUTCMonth()).toBe(1);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should handle Jan 31 → Feb 28 in non-leap year', () => {
            const jan31 = new Date(Date.UTC(2026, 0, 31, 0, 0, 0, 0));
            const result = calculateMonthlyRecurrence(jan31, 1, 31);

            expect(result.getUTCDate()).toBe(28);
            expect(result.getUTCMonth()).toBe(1);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should handle Jan 31 → Feb 29 in leap year', () => {
            const jan31 = new Date(Date.UTC(2024, 0, 31, 0, 0, 0, 0));
            const result = calculateMonthlyRecurrence(jan31, 1, 31);

            expect(result.getUTCDate()).toBe(29);
            expect(result.getUTCMonth()).toBe(1);
            expect(result.getUTCFullYear()).toBe(2024);
        });

        it('should handle month-end clamping for short months', () => {
            const jan31 = new Date(Date.UTC(2026, 0, 31, 0, 0, 0, 0));
            const result = calculateMonthlyRecurrence(jan31, 3, 31);

            expect(result.getUTCDate()).toBe(30);
            expect(result.getUTCMonth()).toBe(3);
        });

        it('should handle year rollover', () => {
            const dec15 = new Date(Date.UTC(2025, 11, 15, 0, 0, 0, 0));
            const result = calculateMonthlyRecurrence(dec15, 1, 15);

            expect(result.getUTCDate()).toBe(15);
            expect(result.getUTCMonth()).toBe(0);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should preserve UTC time component', () => {
            const jan15 = new Date(Date.UTC(2026, 0, 15, 23, 59, 59, 999));
            const result = calculateMonthlyRecurrence(jan15, 1, 15);

            expect(result.getUTCHours()).toBe(23);
            expect(result.getUTCMinutes()).toBe(59);
            expect(result.getUTCSeconds()).toBe(59);
            expect(result.getUTCMilliseconds()).toBe(999);
        });

        it('should handle multi-month intervals', () => {
            const jan15 = new Date(Date.UTC(2026, 0, 15, 0, 0, 0, 0));
            const result = calculateMonthlyRecurrence(jan15, 3, 15);

            expect(result.getUTCDate()).toBe(15);
            expect(result.getUTCMonth()).toBe(3);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should handle intervals that span multiple years', () => {
            const jan15 = new Date(Date.UTC(2026, 0, 15, 0, 0, 0, 0));
            const result = calculateMonthlyRecurrence(jan15, 15, 15);

            expect(result.getUTCDate()).toBe(15);
            expect(result.getUTCMonth()).toBe(3);
            expect(result.getUTCFullYear()).toBe(2027);
        });
    });

    describe('calculateMonthlyWeekdayRecurrence', () => {
        it('should find Nth weekday of month using UTC', () => {
            const firstMonday = new Date(Date.UTC(2026, 2, 2, 0, 0, 0, 0));
            const result = calculateMonthlyWeekdayRecurrence(
                firstMonday,
                1,
                1,
                2
            );

            expect(result.getUTCDay()).toBe(1);
            expect(result.getUTCMonth()).toBe(3);
            const date = result.getUTCDate();
            expect(date).toBeGreaterThanOrEqual(8);
            expect(date).toBeLessThanOrEqual(14);
        });

        it('should handle 1st weekday of month', () => {
            const someMonday = new Date(Date.UTC(2026, 2, 16, 0, 0, 0, 0));
            const result = calculateMonthlyWeekdayRecurrence(
                someMonday,
                1,
                1,
                1
            );

            expect(result.getUTCDay()).toBe(1);
            expect(result.getUTCMonth()).toBe(3);
            expect(result.getUTCDate()).toBeLessThanOrEqual(7);
        });

        it('should handle 3rd Friday of month', () => {
            const someFriday = new Date(Date.UTC(2026, 2, 20, 0, 0, 0, 0));
            const result = calculateMonthlyWeekdayRecurrence(
                someFriday,
                1,
                5,
                3
            );

            expect(result.getUTCDay()).toBe(5);
            expect(result.getUTCMonth()).toBe(3);
            const date = result.getUTCDate();
            expect(date).toBeGreaterThanOrEqual(15);
            expect(date).toBeLessThanOrEqual(21);
        });

        it('should handle overflow when 5th week does not exist', () => {
            const someDay = new Date(Date.UTC(2026, 2, 1, 0, 0, 0, 0));
            const result = calculateMonthlyWeekdayRecurrence(someDay, 1, 1, 5);

            expect(result.getUTCMonth()).toBe(3);
            const date = result.getUTCDate();
            expect(date).toBeLessThan(29);
        });

        it('should preserve UTC time component', () => {
            const monday = new Date(Date.UTC(2026, 2, 2, 15, 30, 45, 500));
            const result = calculateMonthlyWeekdayRecurrence(monday, 1, 1, 1);

            expect(result.getUTCHours()).toBe(15);
            expect(result.getUTCMinutes()).toBe(30);
            expect(result.getUTCSeconds()).toBe(45);
            expect(result.getUTCMilliseconds()).toBe(500);
        });
    });

    describe('calculateMonthlyLastDayRecurrence', () => {
        it('should calculate last day of next month', () => {
            const jan31 = new Date(Date.UTC(2026, 0, 31, 0, 0, 0, 0));
            const result = calculateMonthlyLastDayRecurrence(jan31, 1);

            expect(result.getUTCDate()).toBe(28);
            expect(result.getUTCMonth()).toBe(1);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should handle February in leap year', () => {
            const jan31 = new Date(Date.UTC(2024, 0, 31, 0, 0, 0, 0));
            const result = calculateMonthlyLastDayRecurrence(jan31, 1);

            expect(result.getUTCDate()).toBe(29);
            expect(result.getUTCMonth()).toBe(1);
        });

        it('should handle 31-day months', () => {
            const feb28 = new Date(Date.UTC(2026, 1, 28, 0, 0, 0, 0));
            const result = calculateMonthlyLastDayRecurrence(feb28, 1);

            expect(result.getUTCDate()).toBe(31);
            expect(result.getUTCMonth()).toBe(2);
        });

        it('should handle 30-day months', () => {
            const mar31 = new Date(Date.UTC(2026, 2, 31, 0, 0, 0, 0));
            const result = calculateMonthlyLastDayRecurrence(mar31, 1);

            expect(result.getUTCDate()).toBe(30);
            expect(result.getUTCMonth()).toBe(3);
        });

        it('should handle year boundaries', () => {
            const dec31 = new Date(Date.UTC(2025, 11, 31, 0, 0, 0, 0));
            const result = calculateMonthlyLastDayRecurrence(dec31, 1);

            expect(result.getUTCDate()).toBe(31);
            expect(result.getUTCMonth()).toBe(0);
            expect(result.getUTCFullYear()).toBe(2026);
        });

        it('should preserve UTC time component', () => {
            const jan31 = new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 999));
            const result = calculateMonthlyLastDayRecurrence(jan31, 1);

            expect(result.getUTCHours()).toBe(23);
            expect(result.getUTCMinutes()).toBe(59);
            expect(result.getUTCSeconds()).toBe(59);
            expect(result.getUTCMilliseconds()).toBe(999);
        });
    });

    describe('calculateVirtualOccurrences', () => {
        it('should generate consistent dates in UTC', () => {
            const task = {
                recurrence_type: 'daily',
                recurrence_interval: 1,
            };
            const startDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));

            const occurrences = calculateVirtualOccurrences(task, 7, startDate);

            expect(occurrences).toHaveLength(7);
            expect(occurrences[0].due_date).toBe('2026-01-01');
            expect(occurrences[1].due_date).toBe('2026-01-02');
            expect(occurrences[6].due_date).toBe('2026-01-07');
        });

        it('should respect end date limit', () => {
            const task = {
                recurrence_type: 'daily',
                recurrence_interval: 1,
                recurrence_end_date: new Date(Date.UTC(2026, 0, 5, 23, 59, 59)),
            };
            const startDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));

            const occurrences = calculateVirtualOccurrences(
                task,
                10,
                startDate
            );

            expect(occurrences.length).toBeLessThanOrEqual(5);
        });

        it('should handle weekly recurrence', () => {
            const task = {
                recurrence_type: 'weekly',
                recurrence_interval: 1,
                recurrence_weekday: 1,
            };
            const monday = new Date(Date.UTC(2026, 2, 9, 0, 0, 0, 0));

            const occurrences = calculateVirtualOccurrences(task, 3, monday);

            expect(occurrences).toHaveLength(3);
            expect(occurrences[0].due_date).toBe('2026-03-09');
            expect(occurrences[1].due_date).toBe('2026-03-16');
            expect(occurrences[2].due_date).toBe('2026-03-23');
        });

        it('should handle monthly recurrence across months', () => {
            const task = {
                recurrence_type: 'monthly',
                recurrence_interval: 1,
                recurrence_month_day: 15,
            };
            const jan15 = new Date(Date.UTC(2026, 0, 15, 0, 0, 0, 0));

            const occurrences = calculateVirtualOccurrences(task, 3, jan15);

            expect(occurrences).toHaveLength(3);
            expect(occurrences[0].due_date).toBe('2026-01-15');
            expect(occurrences[1].due_date).toBe('2026-02-15');
            expect(occurrences[2].due_date).toBe('2026-03-15');
        });

        it('should mark all occurrences as virtual', () => {
            const task = {
                recurrence_type: 'daily',
                recurrence_interval: 1,
            };
            const startDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));

            const occurrences = calculateVirtualOccurrences(task, 3, startDate);

            occurrences.forEach((occurrence) => {
                expect(occurrence.is_virtual).toBe(true);
            });
        });

        it('should respect MAX_ITERATIONS to prevent infinite loops', () => {
            const task = {
                recurrence_type: 'daily',
                recurrence_interval: 1,
            };
            const startDate = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));

            const occurrences = calculateVirtualOccurrences(
                task,
                1000,
                startDate
            );

            expect(occurrences.length).toBeLessThanOrEqual(100);
        });
    });

    describe('calculateNextDueDate - UTC Independence', () => {
        it('should calculate daily recurrence identically regardless of server timezone', () => {
            const startDate = new Date(Date.UTC(2026, 0, 15, 12, 0, 0, 0));
            const task = {
                recurrence_type: 'daily',
                recurrence_interval: 1,
            };

            const result = calculateNextDueDate(task, startDate);

            expect(result.toISOString().split('T')[0]).toBe('2026-01-16');
            expect(result.getUTCDate()).toBe(16);
        });

        it('should preserve UTC midnight when calculating', () => {
            const midnight = new Date(Date.UTC(2026, 0, 15, 0, 0, 0, 0));
            const task = {
                recurrence_type: 'daily',
                recurrence_interval: 1,
            };

            const result = calculateNextDueDate(task, midnight);

            expect(result.getUTCHours()).toBe(0);
            expect(result.getUTCMinutes()).toBe(0);
            expect(result.getUTCSeconds()).toBe(0);
            expect(result.getUTCMilliseconds()).toBe(0);
        });

        it('should handle null or invalid input gracefully', () => {
            expect(calculateNextDueDate(null, new Date())).toBeNull();
            expect(calculateNextDueDate({}, new Date())).toBeNull();
            expect(
                calculateNextDueDate({ recurrence_type: 'daily' }, null)
            ).toBeNull();
            expect(
                calculateNextDueDate(
                    { recurrence_type: 'daily' },
                    new Date('invalid')
                )
            ).toBeNull();
        });

        it('should return null for unknown recurrence type', () => {
            const task = {
                recurrence_type: 'unknown',
                recurrence_interval: 1,
            };
            const result = calculateNextDueDate(
                task,
                new Date(Date.UTC(2026, 0, 1))
            );

            expect(result).toBeNull();
        });
    });
});

describe('RecurringTaskService - user timezone calendar (#238)', () => {
    const tz = 'America/Los_Angeles';
    // Due dates are stored as local end-of-day converted to UTC.
    const due = (dateString) => processDueDateForStorage(dateString, tz);
    const local = (date) =>
        moment.tz(date, tz).format('YYYY-MM-DD HH:mm:ss.SSS');

    it('steps a daily task one local day across spring forward', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'daily', recurrence_interval: 1 },
            due('2026-03-07'),
            tz
        );
        expect(local(next)).toBe('2026-03-08 23:59:59.999');
    });

    it('steps a daily task one local day across fall back', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'daily', recurrence_interval: 1 },
            due('2026-10-31'),
            tz
        );
        expect(local(next)).toBe('2026-11-01 23:59:59.999');
    });

    it('keeps the local day of month for a monthly task after DST', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'monthly', recurrence_interval: 1 },
            due('2026-03-05'),
            tz
        );
        expect(local(next)).toBe('2026-04-05 23:59:59.999');
    });

    it('does not skip February for monthly_last_day west of UTC', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'monthly_last_day', recurrence_interval: 1 },
            due('2026-01-31'),
            tz
        );
        expect(local(next)).toBe('2026-02-28 23:59:59.999');
    });

    it('does not skip February for monthly day 31 west of UTC', () => {
        const next = calculateNextDueDate(
            {
                recurrence_type: 'monthly',
                recurrence_interval: 1,
                recurrence_month_day: 31,
            },
            due('2026-01-31'),
            tz
        );
        expect(local(next)).toBe('2026-02-28 23:59:59.999');
    });

    it('lands monthly_weekday on the local weekday west of UTC', () => {
        const next = calculateNextDueDate(
            {
                recurrence_type: 'monthly_weekday',
                recurrence_interval: 1,
                recurrence_weekday: 1, // Monday
                recurrence_week_of_month: 1,
            },
            due('2026-01-05'),
            tz
        );
        expect(local(next)).toBe('2026-02-02 23:59:59.999');
        expect(moment.tz(next, tz).day()).toBe(1);
    });

    it('does not overflow monthly_weekday from the 31st', () => {
        const next = calculateNextDueDate(
            {
                recurrence_type: 'monthly_weekday',
                recurrence_interval: 1,
                recurrence_weekday: 6, // Saturday
                recurrence_week_of_month: 5,
            },
            due('2026-01-31'),
            tz
        );
        // February 2026 has four Saturdays; the last is the 28th.
        expect(local(next)).toBe('2026-02-28 23:59:59.999');
    });

    it('keeps a weekly task on its local weekday across spring forward', () => {
        const next = calculateNextDueDate(
            {
                recurrence_type: 'weekly',
                recurrence_interval: 1,
                recurrence_weekday: 6, // Saturday
            },
            due('2026-03-07'),
            tz
        );
        expect(local(next)).toBe('2026-03-14 23:59:59.999');
    });

    it('keeps local end-of-day for a positive-offset timezone', () => {
        const tokyo = 'Asia/Tokyo';
        const next = calculateNextDueDate(
            { recurrence_type: 'monthly_last_day', recurrence_interval: 1 },
            processDueDateForStorage('2026-01-31', tokyo),
            tokyo
        );
        expect(moment.tz(next, tokyo).format('YYYY-MM-DD HH:mm')).toBe(
            '2026-02-28 23:59'
        );
    });
});

describe('RecurringTaskService - recurrence interval normalization (#209)', () => {
    it.each([
        [3, 3],
        ['2', 2],
        [null, 1],
        [undefined, 1],
        [0, 1],
        [-3, 1],
        ['abc', 1],
        [1.5, 1],
    ])('normalizes %p to %p', (input, expected) => {
        expect(normalizeRecurrenceInterval(input)).toBe(expected);
    });

    it('never moves the next due date backwards for a negative interval', () => {
        const from = new Date(Date.UTC(2026, 0, 1, 7, 59, 59, 999));
        for (const type of ['daily', 'weekly', 'monthly', 'monthly_last_day']) {
            const next = calculateNextDueDate(
                { recurrence_type: type, recurrence_interval: -3 },
                from
            );
            expect(next.getTime()).toBeGreaterThan(from.getTime());
        }
    });

    it('never returns an Invalid Date for a non-numeric interval', () => {
        const from = new Date(Date.UTC(2026, 0, 1, 7, 59, 59, 999));
        const next = calculateNextDueDate(
            { recurrence_type: 'monthly', recurrence_interval: 'abc' },
            from
        );
        expect(isNaN(next.getTime())).toBe(false);
        expect(next.toISOString()).toBe('2026-02-01T07:59:59.999Z');
    });
});

describe('RecurringTaskService - yearly recurrence (#297)', () => {
    const tz = 'America/Los_Angeles';
    const due = (dateString) => processDueDateForStorage(dateString, tz);
    const local = (date) =>
        moment.tz(date, tz).format('YYYY-MM-DD HH:mm:ss.SSS');

    it('keeps the same local month and day one year later', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'yearly', recurrence_interval: 1 },
            due('2026-05-20'),
            tz
        );
        expect(local(next)).toBe('2027-05-20 23:59:59.999');
    });

    it('steps recurrence_interval years', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'yearly', recurrence_interval: 3 },
            due('2026-11-05'),
            tz
        );
        expect(local(next)).toBe('2029-11-05 23:59:59.999');
    });

    it('lands Feb 29 on Feb 28 in a year without Feb 29', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'yearly', recurrence_interval: 1 },
            due('2028-02-29'),
            tz
        );
        expect(local(next)).toBe('2029-02-28 23:59:59.999');
    });

    it('keeps Feb 29 when the target year has one', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'yearly', recurrence_interval: 4 },
            due('2028-02-29'),
            tz
        );
        expect(local(next)).toBe('2032-02-29 23:59:59.999');
    });

    it('defaults to UTC when no timezone is given', () => {
        const next = calculateNextDueDate(
            { recurrence_type: 'yearly', recurrence_interval: 1 },
            new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999))
        );
        expect(next.toISOString()).toBe('2027-12-31T23:59:59.999Z');
    });

    it('can schedule every repeat type in Task.RECURRENCE_TYPE', () => {
        const from = new Date(Date.UTC(2026, 0, 15, 12, 0, 0, 0));
        const types = Object.values(Task.RECURRENCE_TYPE).filter(
            (type) => type !== Task.RECURRENCE_TYPE.NONE
        );
        expect(types).toContain('yearly');
        for (const type of types) {
            const next = calculateNextDueDate(
                {
                    recurrence_type: type,
                    recurrence_interval: 1,
                    recurrence_weekday: 4,
                    recurrence_week_of_month: 3,
                },
                from
            );
            expect(next).toBeInstanceOf(Date);
            expect(next.getTime()).toBeGreaterThan(from.getTime());
        }
    });
});
