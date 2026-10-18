import {
    buildEventDropChanges,
    fromDueParts,
    isDeferAfterDueDay,
    toDueParts,
} from '../dueDateTime';

describe('dueDateTime', () => {
    it('round-trips a date with a time', () => {
        const iso = fromDueParts('2026-10-15', '15:30');
        expect(toDueParts(iso)).toEqual({ date: '2026-10-15', time: '15:30' });
    });

    it('treats midnight as a whole-day due date', () => {
        const iso = fromDueParts('2026-10-15', null);
        expect(toDueParts(iso)).toEqual({ date: '2026-10-15', time: null });
    });

    it('returns empty parts for an empty value', () => {
        expect(fromDueParts(null, '15:30')).toBe('');
        expect(toDueParts('')).toEqual({ date: null, time: null });
    });
});

describe('isDeferAfterDueDay', () => {
    // Local times, so the result does not depend on the machine's timezone.
    const local = (y: number, m: number, d: number, hh: number, mm = 0) =>
        new Date(y, m - 1, d, hh, mm).toISOString();

    it('accepts a defer in the evening of the due day', () => {
        expect(
            isDeferAfterDueDay(local(2026, 3, 10, 20), '2026-03-10')
        ).toBe(false);
        expect(
            isDeferAfterDueDay(local(2026, 3, 10, 23, 59), '2026-03-10')
        ).toBe(false);
    });

    it('rejects a defer early on the day after the due date', () => {
        expect(isDeferAfterDueDay(local(2026, 3, 11, 0, 30), '2026-03-10')).toBe(
            true
        );
    });

    it('reads a datetime-local value and a due date with a time part', () => {
        expect(isDeferAfterDueDay('2026-03-10T20:00', '2026-03-10')).toBe(false);
        expect(isDeferAfterDueDay('2026-03-11T08:00', '2026-03-10T00:00')).toBe(
            true
        );
    });

    it('does not reject values it cannot read', () => {
        expect(isDeferAfterDueDay('not a date', '2026-03-10')).toBe(false);
        expect(isDeferAfterDueDay(local(2026, 3, 11, 8), '')).toBe(false);
    });
});

describe('buildEventDropChanges', () => {
    // Evening local time: its ISO string can fall on another UTC day.
    const dropped = new Date(2026, 9, 22, 0, 30);

    it('moves a timed due date to the new local day and keeps its time', () => {
        expect(
            buildEventDropChanges({ due_time: '15:00' }, dropped, false)
        ).toEqual({ due_date: '2026-10-22', due_time: '15:00' });
    });

    it('sends only the day for a whole-day task', () => {
        expect(buildEventDropChanges({ due_time: null }, dropped, false)).toEqual(
            { due_date: '2026-10-22' }
        );
        expect(buildEventDropChanges({}, dropped, false)).toEqual({
            due_date: '2026-10-22',
        });
    });

    it('sends the full instant for a defer-until', () => {
        expect(
            buildEventDropChanges({ due_time: '15:00' }, dropped, true)
        ).toEqual({ defer_until: dropped.toISOString() });
    });
});
