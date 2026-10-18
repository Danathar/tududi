const moment = require('moment-timezone');
const { getWeekdayInTimezone } = require('../../utils/timezone-utils');

// The largest "every N days/weeks/months" interval accepted on input.
const MAX_RECURRENCE_INTERVAL = 1000;

// Returns the interval as a positive whole number. Stored rows from before
// input validation may hold 0, a negative number or a non-numeric string;
// those fall back to 1 so the next date always moves forward and is never
// an Invalid Date.
const normalizeRecurrenceInterval = (interval) => {
    const value = Number(interval);
    if (
        Number.isInteger(value) &&
        value >= 1 &&
        value <= MAX_RECURRENCE_INTERVAL
    ) {
        return value;
    }
    return 1;
};

// The instant as a moment in the user's timezone. Recurrence arithmetic is
// done on this local calendar (days, months, weekdays) and the local
// wall-clock time is kept, so a due date stored as local end-of-day stays
// local end-of-day across DST changes and month ends.
const toLocal = (date, timezone) => moment.tz(date, timezone || 'UTC');

// Copies the local time of day from `local` onto `target`.
const withLocalTime = (target, local) =>
    target.set({
        hour: local.hour(),
        minute: local.minute(),
        second: local.second(),
        millisecond: local.millisecond(),
    });

const calculateNextDueDate = (task, fromDate, timezone = 'UTC') => {
    if (
        !task ||
        !task.recurrence_type ||
        !fromDate ||
        isNaN(fromDate.getTime())
    ) {
        return null;
    }

    const startDate = new Date(fromDate.getTime());
    const interval = normalizeRecurrenceInterval(task.recurrence_interval);

    switch (task.recurrence_type) {
        case 'daily':
            return calculateDailyRecurrence(startDate, interval, timezone);

        case 'weekly':
            return calculateWeeklyRecurrence(
                startDate,
                interval,
                task.recurrence_weekday,
                task.recurrence_weekdays,
                timezone
            );

        case 'monthly':
            return calculateMonthlyRecurrence(
                startDate,
                interval,
                task.recurrence_month_day,
                timezone
            );

        case 'monthly_weekday':
            return calculateMonthlyWeekdayRecurrence(
                startDate,
                interval,
                task.recurrence_weekday,
                task.recurrence_week_of_month,
                timezone
            );

        case 'monthly_last_day':
            return calculateMonthlyLastDayRecurrence(
                startDate,
                interval,
                timezone
            );

        default:
            return null;
    }
};

// Adds whole calendar days in the user's timezone. Adding 24-hour blocks in
// UTC instead shifts the local time by an hour across a DST change, which
// for a 23:59:59.999 due date moves it to the wrong day.
const addLocalDays = (date, days, timezone) =>
    toLocal(date, timezone).add(days, 'days').toDate();

const calculateDailyRecurrence = (fromDate, interval, timezone = 'UTC') =>
    addLocalDays(fromDate, interval, timezone);

const calculateWeeklyRecurrence = (
    fromDate,
    interval,
    weekday,
    weekdays,
    timezone = 'UTC'
) => {
    const nextDate = new Date(fromDate);

    // Handle multiple weekdays (e.g. Tuesday AND Thursday)
    const parsedWeekdays = weekdays
        ? Array.isArray(weekdays)
            ? weekdays
            : JSON.parse(weekdays)
        : null;

    if (parsedWeekdays && parsedWeekdays.length > 0) {
        const sorted = [...parsedWeekdays].sort((a, b) => a - b);
        // Read the weekday in the user's timezone, not getUTCDay(): fromDate
        // may represent "local midnight" as a UTC instant, whose UTC calendar
        // day is the previous day for positive-UTC-offset timezones.
        const currentDay = getWeekdayInTimezone(nextDate, timezone);

        // Find next weekday in calendar order (accounting for week wrap)
        let nextWeekday = null;
        let daysToNext = null;

        for (let i = 1; i <= 7; i++) {
            const testDay = (currentDay + i) % 7;
            if (sorted.includes(testDay)) {
                nextWeekday = testDay;
                daysToNext = i;
                break;
            }
        }

        if (daysToNext === null) {
            // No weekday found (shouldn't happen), fallback
            daysToNext = interval * 7;
        } else if (daysToNext < 7) {
            // Next weekday is within current 7-day period
            // Determine if we should skip weeks based on interval
            const isAdjacentDay = daysToNext === 1;

            // Determine if current day is the last weekday in the pattern
            // (considering calendar order, where the highest day number is last,
            // except Sunday(0) which wraps around)
            const maxWeekday = Math.max(...sorted);
            const isOnLastWeekday = currentDay === maxWeekday;

            // Special case: if pattern includes Sunday(0), check if we're on it
            // and all other weekdays are higher (meaning we're at the end of the pattern)
            const hasSunday = sorted.includes(0);
            const isOnSundayWithHigherDays =
                currentDay === 0 && sorted.every((d) => d === 0 || d > 0);

            if (
                interval > 1 &&
                !isAdjacentDay &&
                (isOnLastWeekday || isOnSundayWithHigherDays)
            ) {
                // We're on the last weekday of the pattern cycle, add interval skip
                daysToNext += (interval - 1) * 7;
            }
        } else {
            // Next occurrence is 7 days away, add interval skip
            daysToNext += (interval - 1) * 7;
        }

        return addLocalDays(nextDate, daysToNext, timezone);
    } else if (weekday !== null && weekday !== undefined) {
        const currentWeekday = getWeekdayInTimezone(nextDate, timezone);
        let daysUntilTarget = (weekday - currentWeekday + 7) % 7;

        if (daysUntilTarget === 0) {
            daysUntilTarget = interval * 7;
        } else if (interval > 1 && daysUntilTarget < 7) {
            daysUntilTarget += (interval - 1) * 7;
        }

        return addLocalDays(nextDate, daysUntilTarget, timezone);
    }

    return addLocalDays(nextDate, interval * 7, timezone);
};

const calculateMonthlyRecurrence = (
    fromDate,
    interval,
    dayOfMonth,
    timezone = 'UTC'
) => {
    const local = toLocal(fromDate, timezone);
    const targetDay = dayOfMonth || local.date();

    const target = local.clone().startOf('month').add(interval, 'months');
    target.date(Math.min(targetDay, target.daysInMonth()));

    return withLocalTime(target, local).toDate();
};

const calculateMonthlyWeekdayRecurrence = (
    fromDate,
    interval,
    weekday,
    weekOfMonth,
    timezone = 'UTC'
) => {
    const local = toLocal(fromDate, timezone);
    // Start from the 1st so that e.g. Jan 31 + 1 month does not overflow
    // into March.
    const firstOfMonth = local.clone().startOf('month').add(interval, 'months');
    const targetMonth = firstOfMonth.month();

    const daysToAdd = (weekday - firstOfMonth.day() + 7) % 7;
    const target = firstOfMonth
        .clone()
        .add(daysToAdd + (weekOfMonth - 1) * 7, 'days');

    if (target.month() !== targetMonth) {
        target.subtract(7, 'days');
    }

    return withLocalTime(target, local).toDate();
};

const calculateMonthlyLastDayRecurrence = (
    fromDate,
    interval,
    timezone = 'UTC'
) => {
    const local = toLocal(fromDate, timezone);
    // Start from the 1st to avoid date overflow (e.g. Jan 31 + 1 month
    // would otherwise land in March).
    const target = local.clone().startOf('month').add(interval, 'months');
    target.date(target.daysInMonth());

    return withLocalTime(target, local).toDate();
};

const getFirstWeekdayOfMonth = (year, month, weekday) => {
    const firstOfMonth = new Date(year, month, 1);
    const firstWeekday = firstOfMonth.getDay();
    const daysToAdd = (weekday - firstWeekday + 7) % 7;
    return new Date(year, month, 1 + daysToAdd);
};

const getLastWeekdayOfMonth = (year, month, weekday) => {
    const lastOfMonth = new Date(year, month + 1, 0);
    const lastWeekday = lastOfMonth.getDay();
    const daysToSubtract = (lastWeekday - weekday + 7) % 7;
    return new Date(year, month, lastOfMonth.getDate() - daysToSubtract);
};

const getNthWeekdayOfMonth = (year, month, weekday, n) => {
    const firstOccurrence = getFirstWeekdayOfMonth(year, month, weekday);
    const targetDate = new Date(firstOccurrence);
    targetDate.setDate(firstOccurrence.getDate() + (n - 1) * 7);

    if (targetDate.getMonth() !== month) {
        return null;
    }

    return targetDate;
};

const shouldGenerateNextTask = (task, nextDate) => {
    if (!task.recurrence_end_date) {
        return true;
    }
    return nextDate < task.recurrence_end_date;
};

const calculateVirtualOccurrences = (
    task,
    count = 7,
    startFrom = null,
    userTimezone = 'UTC'
) => {
    const occurrences = [];

    // Parse start date properly in user's timezone
    let currentDate;
    if (startFrom) {
        if (typeof startFrom === 'string') {
            // Parse date string in user's timezone
            currentDate = moment.tz(startFrom, userTimezone).toDate();
        } else {
            currentDate = new Date(startFrom);
        }
    } else if (task.due_date) {
        // Parse task due_date in UTC (since it comes from database)
        currentDate = new Date(task.due_date);
    } else {
        // Get current date in user's timezone
        currentDate = moment.tz(userTimezone).startOf('day').toDate();
    }

    let iterationCount = 0;
    const MAX_ITERATIONS = 100;

    while (occurrences.length < count && iterationCount < MAX_ITERATIONS) {
        if (
            task.recurrence_end_date &&
            currentDate > new Date(task.recurrence_end_date)
        ) {
            break;
        }

        // Convert UTC date to user timezone date string
        const dateInUserTz = moment
            .utc(currentDate)
            .tz(userTimezone)
            .format('YYYY-MM-DD');

        occurrences.push({
            due_date: dateInUserTz,
            is_virtual: true,
        });

        currentDate = calculateNextDueDate(task, currentDate, userTimezone);
        if (!currentDate) break;

        iterationCount++;
    }

    return occurrences;
};

module.exports = {
    MAX_RECURRENCE_INTERVAL,
    normalizeRecurrenceInterval,
    calculateNextDueDate,
    calculateDailyRecurrence,
    calculateWeeklyRecurrence,
    calculateMonthlyRecurrence,
    calculateMonthlyWeekdayRecurrence,
    calculateMonthlyLastDayRecurrence,
    calculateVirtualOccurrences,
    shouldGenerateNextTask,
    getFirstWeekdayOfMonth,
    getLastWeekdayOfMonth,
    getNthWeekdayOfMonth,
    _getFirstWeekdayOfMonth: getFirstWeekdayOfMonth,
    _getLastWeekdayOfMonth: getLastWeekdayOfMonth,
    _getNthWeekdayOfMonth: getNthWeekdayOfMonth,
    _shouldGenerateNextTask: shouldGenerateNextTask,
};
