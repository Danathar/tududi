const { WEEKDAY_REVERSE_MAP } = require('./field-mappings');
const { processDueDateForStorage } = require('../../../utils/timezone-utils');

// UNTIL is a DATE-TIME (20251231T000000Z) or, when DTSTART is a DATE, a DATE
// (20251231, RFC 5545 3.3.10). A DATE means the recurrence runs through that
// whole day, so it is stored as the end of the day in the user's timezone,
// the same way a DATE due date is. Anything else is unreadable: return null
// rather than an Invalid Date, which would be stored as the text
// 'Invalid date' and drop the RRULE from every later GET.
function parseUntil(until, userTimezone) {
    const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(until);
    if (dateOnly) {
        const [, year, month, day] = dateOnly;
        const end = processDueDateForStorage(
            `${year}-${month}-${day}`,
            userTimezone || 'UTC'
        );
        return end && !Number.isNaN(end.getTime()) ? end : null;
    }

    const date = new Date(
        until.replace(
            /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/,
            '$1-$2-$3T$4:$5:$6Z'
        )
    );
    return Number.isNaN(date.getTime()) ? null : date;
}

function parseRRULE(rruleString, userTimezone) {
    if (!rruleString) {
        return null;
    }

    try {
        const parts = rruleString.split(';');
        const rruleData = {};

        parts.forEach((part) => {
            const [key, value] = part.split('=');
            rruleData[key] = value;
        });

        const result = {
            recurrence_type: null,
            recurrence_interval: 1,
            recurrence_end_date: null,
            recurrence_count: null,
            recurrence_weekdays: null,
            recurrence_month_day: null,
            recurrence_weekday: null,
            recurrence_week_of_month: null,
        };

        if (!rruleData.FREQ) {
            return null;
        }

        if (rruleData.INTERVAL) {
            result.recurrence_interval = parseInt(rruleData.INTERVAL, 10);
        }

        if (rruleData.COUNT) {
            result.recurrence_count = parseInt(rruleData.COUNT, 10);
        }

        if (rruleData.UNTIL) {
            try {
                result.recurrence_end_date = parseUntil(
                    rruleData.UNTIL,
                    userTimezone
                );
            } catch (error) {
                console.error('Error parsing UNTIL:', error);
            }
        }

        switch (rruleData.FREQ) {
            case 'DAILY':
                result.recurrence_type = 'daily';
                break;

            case 'WEEKLY':
                result.recurrence_type = 'weekly';
                if (rruleData.BYDAY) {
                    const days = rruleData.BYDAY.split(',')
                        .map((day) => {
                            const cleanDay = day.replace(/[0-9-]/g, '');
                            return WEEKDAY_REVERSE_MAP[cleanDay];
                        })
                        .filter((d) => d !== undefined);
                    result.recurrence_weekdays = days;
                }
                break;

            case 'MONTHLY':
                if (rruleData.BYDAY) {
                    result.recurrence_type = 'monthly_weekday';
                    const byDayMatch =
                        rruleData.BYDAY.match(/(-?\d+)([A-Z]{2})/);
                    if (byDayMatch) {
                        result.recurrence_week_of_month = parseInt(
                            byDayMatch[1],
                            10
                        );
                        result.recurrence_weekday =
                            WEEKDAY_REVERSE_MAP[byDayMatch[2]];
                    }
                } else if (rruleData.BYMONTHDAY === '-1') {
                    result.recurrence_type = 'monthly_last_day';
                } else if (rruleData.BYMONTHDAY) {
                    result.recurrence_type = 'monthly';
                    result.recurrence_month_day = parseInt(
                        rruleData.BYMONTHDAY,
                        10
                    );
                } else {
                    result.recurrence_type = 'monthly';
                }
                break;

            case 'YEARLY':
                result.recurrence_type = 'yearly';
                break;

            default:
                return null;
        }

        return result;
    } catch (error) {
        console.error('Error parsing RRULE:', error);
        return null;
    }
}

module.exports = {
    parseRRULE,
};
