const {
    calculateNextDueDate,
    calculateWeeklyRecurrence,
} = require('../../../../modules/tasks/recurringTaskService');

const day = (date) => date.toISOString().slice(0, 10);

describe('Weekly interval when the start day is not a picked weekday', () => {
    const monday = new Date(Date.UTC(2026, 10, 16, 15, 0, 0, 0));

    it('waits 13 weeks when completed on Monday with Saturday picked', () => {
        const next = calculateNextDueDate(
            {
                recurrence_type: 'weekly',
                recurrence_interval: 13,
                recurrence_weekdays: [6],
            },
            monday,
            'UTC'
        );

        expect(day(next)).toBe('2027-02-13');
    });

    it('matches the single weekday field for the same pattern', () => {
        const single = calculateWeeklyRecurrence(monday, 13, 6, null);
        const multi = calculateWeeklyRecurrence(monday, 13, null, [6]);

        expect(day(multi)).toBe(day(single));
    });

    it('applies the interval with several weekdays picked', () => {
        const wednesday = new Date(Date.UTC(2026, 10, 18, 15, 0, 0, 0));

        const next = calculateWeeklyRecurrence(wednesday, 2, null, [2, 4]);

        expect(day(next)).toBe('2026-11-26');
    });

    it('applies the interval when the next picked weekday is tomorrow', () => {
        const friday = new Date(Date.UTC(2026, 10, 20, 15, 0, 0, 0));

        const next = calculateWeeklyRecurrence(friday, 13, null, [6]);

        expect(day(next)).toBe('2027-02-13');
    });

    it('keeps weekly tasks on the next picked weekday', () => {
        const next = calculateWeeklyRecurrence(monday, 1, null, [6]);

        expect(day(next)).toBe('2026-11-21');
    });

    it('still moves between picked weekdays inside one week', () => {
        const tuesday = new Date(Date.UTC(2026, 10, 17, 15, 0, 0, 0));

        const next = calculateWeeklyRecurrence(tuesday, 2, null, [2, 4]);

        expect(day(next)).toBe('2026-11-19');
    });
});

describe('Weekly interval with Sunday and another weekday picked', () => {
    // Weeks start on Monday, so Sunday closes a week. Dates are in
    // November 2026: Sun 15, Mon 16, Wed 18, Fri 20, Sat 21, Sun 22.
    const at = (date) => new Date(Date.UTC(2026, 10, date, 15, 0, 0, 0));

    const cases = [
        // [label, weekdays, interval, from, expected next]
        ['Sun+Wed from Sun', [0, 3], 2, 15, '2026-11-25'],
        ['Sun+Wed from Wed', [0, 3], 2, 18, '2026-11-22'],
        ['Sun+Mon from Sun', [0, 1], 2, 15, '2026-11-23'],
        ['Sun+Mon from Mon', [0, 1], 2, 16, '2026-11-22'],
        ['Sun+Fri from Sun', [0, 5], 2, 15, '2026-11-27'],
        ['Sun+Fri from Fri', [0, 5], 2, 20, '2026-11-22'],
        ['Sat+Sun from Sat', [0, 6], 2, 21, '2026-11-22'],
        ['Sat+Sun from Sun', [0, 6], 2, 22, '2026-12-05'],
        ['Mon+Wed from Mon', [1, 3], 2, 16, '2026-11-18'],
        ['Mon+Wed from Wed', [1, 3], 2, 18, '2026-11-30'],
    ];

    it.each(cases)(
        '%s every 2 weeks',
        (_label, weekdays, interval, from, expected) => {
            const next = calculateWeeklyRecurrence(
                at(from),
                interval,
                null,
                weekdays
            );

            expect(day(next)).toBe(expected);
        }
    );
});
