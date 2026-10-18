const pad = (n: number) => String(n).padStart(2, '0');

// Splits the ISO value from DateTimePicker into the API's due_date and
// due_time. Midnight means "no time": the picker always carries a time, but
// a whole-day due date must not turn into a timed one.
export const toDueParts = (
    iso: string
): { date: string | null; time: string | null } => {
    if (!iso) return { date: null, time: null };
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { date: null, time: null };
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return { date, time: time === '00:00' ? null : time };
};

// Builds the ISO value DateTimePicker expects from the API's due_date and due_time.
export const fromDueParts = (
    date: string | null | undefined,
    time: string | null | undefined
): string => {
    if (!date) return '';
    const [y, m, d] = date.split('T')[0].split('-').map(Number);
    const [hh, mm] = (time || '00:00').split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm).toISOString();
};

// True when a defer-until time falls on a later local calendar day than the
// due date. Due dates are date-only (YYYY-MM-DD), so the comparison is made
// on the user's calendar days; building a UTC end of day from the due date
// would reject valid evening defers west of UTC and accept next-day ones
// east of it.
export const isDeferAfterDueDay = (
    deferUntil: string,
    dueDate: string
): boolean => {
    const defer = new Date(deferUntil);
    const dueDay = String(dueDate).split('T')[0];
    if (Number.isNaN(defer.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDay)) {
        return false;
    }
    const deferDay = `${defer.getFullYear()}-${pad(defer.getMonth() + 1)}-${pad(defer.getDate())}`;
    return deferDay > dueDay;
};

// The PATCH body for dropping a calendar event on a new day. A due date goes
// as the local YYYY-MM-DD (an ISO string would shift the day east of UTC)
// and keeps the task's due time, because a due_date sent without due_time
// turns a timed task into a whole-day one. A defer-until is a full instant.
export const buildEventDropChanges = (
    task: { due_time?: string | null },
    newDateTime: Date,
    isDeferEvent: boolean
): Record<string, string> => {
    if (isDeferEvent) return { defer_until: newDateTime.toISOString() };
    const due_date = `${newDateTime.getFullYear()}-${pad(newDateTime.getMonth() + 1)}-${pad(newDateTime.getDate())}`;
    return task.due_time ? { due_date, due_time: task.due_time } : { due_date };
};
