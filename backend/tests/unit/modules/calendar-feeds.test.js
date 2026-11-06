const {
    parseCalendar,
    eventsForDate,
    eventsForRange,
} = require('../../../modules/calendar-feeds/icsEvents');
const axios = require('axios');
const dns = require('dns');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    fetchFeed,
    normalizeFeedUrl,
    FeedFetchError,
} = require('../../../modules/calendar-feeds/fetcher');

const ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    // Weekdays at 08:00 Athens time, skipped on the 25th, moved on the 24th.
    'BEGIN:VEVENT',
    'UID:school',
    'DTSTART;TZID=Europe/Athens:20260901T080000',
    'DTEND;TZID=Europe/Athens:20260901T083000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    'EXDATE;TZID=Europe/Athens:20260925T080000',
    'SUMMARY:School drop-off',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:school',
    'RECURRENCE-ID;TZID=Europe/Athens:20260924T080000',
    'DTSTART;TZID=Europe/Athens:20260924T090000',
    'DTEND;TZID=Europe/Athens:20260924T093000',
    'SUMMARY:School drop-off (late start)',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:call',
    'DTSTART:20260924T090000Z',
    'DTEND:20260924T093000Z',
    'SUMMARY:Call with accountant',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:holiday',
    'DTSTART;VALUE=DATE:20260924',
    'DTEND;VALUE=DATE:20260925',
    'SUMMARY:Name day',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:late',
    'DTSTART;TZID=Europe/Athens:20260924T230000',
    'DTEND;TZID=Europe/Athens:20260925T010000',
    'SUMMARY:Late show',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:cancelled',
    'DTSTART;TZID=Europe/Athens:20260924T140000',
    'DTEND;TZID=Europe/Athens:20260924T150000',
    'STATUS:CANCELLED',
    'SUMMARY:Cancelled',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:free',
    'DTSTART;TZID=Europe/Athens:20260924T150000',
    'DTEND;TZID=Europe/Athens:20260924T153000',
    'TRANSP:TRANSPARENT',
    'SUMMARY:Maybe gym',
    'END:VEVENT',
    'END:VCALENDAR',
].join('\r\n');

describe('eventsForDate', () => {
    const events = parseCalendar(ICS);
    const titles = (date) =>
        eventsForDate(events, date, 'Europe/Athens').map((e) => e.title);

    it('uses the moved instance of a recurring event', () => {
        const day = eventsForDate(events, '2026-09-24', 'Europe/Athens');
        const school = day.find((e) => e.uid === 'school');
        expect(school.title).toBe('School drop-off (late start)');
        expect(school.start_minute).toBe(9 * 60);
    });

    it('skips an excluded date and keeps the others', () => {
        expect(titles('2026-09-25')).not.toContain('School drop-off');
        expect(titles('2026-09-23')).toContain('School drop-off');
        expect(titles('2026-09-26')).not.toContain('School drop-off');
    });

    it('converts UTC times into the user timezone', () => {
        const call = eventsForDate(events, '2026-09-24', 'Europe/Athens').find(
            (e) => e.uid === 'call'
        );
        expect(call.start_minute).toBe(12 * 60);
        expect(call.end_minute).toBe(12 * 60 + 30);
    });

    it('places events by wall clock on a DST change day', () => {
        const dentist = parseCalendar(
            [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//test//EN',
                'BEGIN:VEVENT',
                'UID:dentist',
                'DTSTART;TZID=Europe/Athens:20261025T160000',
                'DTEND;TZID=Europe/Athens:20261025T170000',
                'SUMMARY:Dentist',
                'END:VEVENT',
                'END:VCALENDAR',
            ].join('\r\n')
        );
        const [event] = eventsForDate(dentist, '2026-10-25', 'Europe/Athens');
        expect(event.start_minute).toBe(16 * 60);
        expect(event.end_minute).toBe(17 * 60);
    });

    it('lists all-day events first without minutes', () => {
        const [first] = eventsForDate(events, '2026-09-24', 'Europe/Athens');
        expect(first).toMatchObject({
            title: 'Name day',
            all_day: true,
            start_minute: null,
        });
        expect(titles('2026-09-25')).not.toContain('Name day');
    });

    it('clips an event that crosses midnight to each day', () => {
        const before = eventsForDate(
            events,
            '2026-09-24',
            'Europe/Athens'
        ).find((e) => e.uid === 'late');
        const after = eventsForDate(events, '2026-09-25', 'Europe/Athens').find(
            (e) => e.uid === 'late'
        );
        expect([before.start_minute, before.end_minute]).toEqual([1380, 1440]);
        expect([after.start_minute, after.end_minute]).toEqual([0, 60]);
    });

    it('drops cancelled events and marks free ones as not busy', () => {
        const day = eventsForDate(events, '2026-09-24', 'Europe/Athens');
        expect(day.map((e) => e.title)).not.toContain('Cancelled');
        expect(day.find((e) => e.uid === 'free').busy).toBe(false);
        expect(day.find((e) => e.uid === 'call').busy).toBe(true);
    });
});

describe('eventsForDate on DST-change days', () => {
    const DST_ICS = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//test//EN',
        'BEGIN:VEVENT',
        'UID:standup',
        'DTSTART;TZID=America/New_York:20260301T090000',
        'DTEND;TZID=America/New_York:20260301T093000',
        'RRULE:FREQ=DAILY',
        'SUMMARY:Standup',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:overnight',
        'DTSTART;TZID=America/New_York:20261031T220000',
        'DTEND;TZID=America/New_York:20261101T030000',
        'SUMMARY:Overnight shift',
        'END:VEVENT',
        'END:VCALENDAR',
    ].join('\r\n');
    const events = parseCalendar(DST_ICS);
    const standup = (date) =>
        eventsForDate(events, date, 'America/New_York').find(
            (e) => e.uid === 'standup'
        );

    it('reports local wall-clock minutes across spring forward', () => {
        const minutes = [
            '2026-03-06',
            '2026-03-07',
            '2026-03-08',
            '2026-03-09',
        ].map((date) => [standup(date).start_minute, standup(date).end_minute]);
        expect(minutes).toEqual([
            [540, 570],
            [540, 570],
            [540, 570],
            [540, 570],
        ]);
    });

    it('reports local wall-clock minutes on the fall-back day', () => {
        expect(standup('2026-11-01').start_minute).toBe(540);
        expect(standup('2026-11-01').end_minute).toBe(570);
    });

    it('clips an event crossing midnight into a fall-back day', () => {
        const before = eventsForDate(
            events,
            '2026-10-31',
            'America/New_York'
        ).find((e) => e.uid === 'overnight');
        const after = eventsForDate(
            events,
            '2026-11-01',
            'America/New_York'
        ).find((e) => e.uid === 'overnight');
        expect([before.start_minute, before.end_minute]).toEqual([1320, 1440]);
        expect([after.start_minute, after.end_minute]).toEqual([0, 180]);
    });
});

describe('eventsForRange', () => {
    const events = parseCalendar(ICS);
    const range = eventsForRange(
        events,
        '2026-09-23',
        '2026-09-26',
        'Europe/Athens'
    );
    const titlesOn = (date) =>
        range.filter((e) => e.date === date).map((e) => e.title);

    it('matches eventsForDate for every day in the range', () => {
        for (const date of [
            '2026-09-23',
            '2026-09-24',
            '2026-09-25',
            '2026-09-26',
        ]) {
            const single = eventsForDate(events, date, 'Europe/Athens');
            const fromRange = range
                .filter((e) => e.date === date)
                .map(({ date: _date, ...event }) => event);
            expect(fromRange).toEqual(single);
        }
    });

    it('tags each event with its day and keeps day order', () => {
        expect(titlesOn('2026-09-25')).not.toContain('School drop-off');
        expect(titlesOn('2026-09-24')).toContain('Name day');
        const dates = range.map((e) => e.date);
        expect(dates).toEqual([...dates].sort());
    });

    it('lists an event that crosses midnight on both days', () => {
        expect(titlesOn('2026-09-24')).toContain('Late show');
        expect(titlesOn('2026-09-25')).toContain('Late show');
    });
});

describe('eventsForRange on a long-lived feed', () => {
    const feed = (...events) =>
        parseCalendar(
            [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//test//EN',
                ...events.flatMap((lines) => [
                    'BEGIN:VEVENT',
                    ...lines,
                    'END:VEVENT',
                ]),
                'END:VCALENDAR',
            ].join('\r\n')
        );
    const series = (uid, ...lines) => [
        `UID:${uid}`,
        `SUMMARY:${uid}`,
        ...lines,
    ];
    const datesOf = (
        events,
        start = '2026-11-01',
        end = '2026-11-21',
        timezone = 'Europe/Athens'
    ) => eventsForRange(events, start, end, timezone).map((e) => e.date);

    it('keeps an every-other-week series on its own weeks', () => {
        const events = feed(
            series(
                'gym',
                'DTSTART;TZID=Europe/Athens:20120102T090000',
                'DTEND;TZID=Europe/Athens:20120102T100000',
                'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'
            )
        );
        expect(datesOf(events)).toEqual([
            '2026-11-02',
            '2026-11-05',
            '2026-11-16',
            '2026-11-19',
        ]);
    });

    it('keeps a daily series with an interval on its own days', () => {
        const events = feed(
            series(
                'pills',
                'DTSTART;TZID=Europe/Athens:20100101T070000',
                'DTEND;TZID=Europe/Athens:20100101T071000',
                'RRULE:FREQ=DAILY;INTERVAL=3'
            )
        );
        expect(datesOf(events, '2026-11-01', '2026-11-10')).toEqual([
            '2026-11-03',
            '2026-11-06',
            '2026-11-09',
        ]);
    });

    it('still applies an EXDATE on an old-running series', () => {
        const events = feed(
            series(
                'standup',
                'DTSTART;TZID=Europe/Athens:20120102T090000',
                'DTEND;TZID=Europe/Athens:20120102T100000',
                'RRULE:FREQ=WEEKLY',
                'EXDATE;TZID=Europe/Athens:20261109T090000'
            )
        );
        expect(datesOf(events)).toEqual(['2026-11-02', '2026-11-16']);
    });

    it('counts occurrences from the first one when a rule has a COUNT', () => {
        const events = feed(
            // The 775th Monday from 2012-01-02 is 2026-11-02.
            series(
                'ends-in-window',
                'DTSTART;TZID=Europe/Athens:20120102T090000',
                'DTEND;TZID=Europe/Athens:20120102T100000',
                'RRULE:FREQ=WEEKLY;COUNT=775'
            ),
            series(
                'ended',
                'DTSTART;TZID=Europe/Athens:20120102T090000',
                'DTEND;TZID=Europe/Athens:20120102T100000',
                'RRULE:FREQ=WEEKLY;COUNT=10'
            )
        );
        expect(datesOf(events)).toEqual(['2026-11-02']);
    });

    it('stops a series at its UNTIL', () => {
        const events = feed(
            series(
                'ends-in-window',
                'DTSTART;TZID=Europe/Athens:20120102T090000',
                'DTEND;TZID=Europe/Athens:20120102T100000',
                'RRULE:FREQ=WEEKLY;UNTIL=20261110T000000Z'
            ),
            series(
                'ended',
                'DTSTART;TZID=Europe/Athens:20120102T090000',
                'DTEND;TZID=Europe/Athens:20120102T100000',
                'RRULE:FREQ=WEEKLY;UNTIL=20180101T000000Z'
            )
        );
        expect(datesOf(events)).toEqual(['2026-11-02', '2026-11-09']);
    });

    it('shows an old instance that was moved into the range', () => {
        const events = feed(
            series(
                'review',
                'DTSTART;TZID=Europe/Athens:20200106T100000',
                'DTEND;TZID=Europe/Athens:20200106T110000',
                'RRULE:FREQ=WEEKLY;UNTIL=20210201T000000Z'
            ),
            [
                'UID:review',
                'SUMMARY:review moved',
                'RECURRENCE-ID;TZID=Europe/Athens:20210104T100000',
                'DTSTART;TZID=Europe/Athens:20261111T150000',
                'DTEND;TZID=Europe/Athens:20261111T160000',
            ]
        );
        const range = eventsForRange(
            events,
            '2026-11-11',
            '2026-11-11',
            'Europe/Athens'
        );
        expect(range.map((e) => e.title)).toEqual(['review moved']);
    });

    it('leaves out an instance moved out of the range', () => {
        const events = feed(
            series(
                'review',
                'DTSTART;TZID=Europe/Athens:20200106T100000',
                'DTEND;TZID=Europe/Athens:20200106T110000',
                'RRULE:FREQ=WEEKLY'
            ),
            [
                'UID:review',
                'SUMMARY:review moved',
                'RECURRENCE-ID;TZID=Europe/Athens:20261109T100000',
                'DTSTART;TZID=Europe/Athens:20300101T150000',
                'DTEND;TZID=Europe/Athens:20300101T160000',
            ]
        );
        expect(datesOf(events, '2026-11-08', '2026-11-10')).toEqual([]);
    });

    it('shows a long occurrence that started before the range', () => {
        const events = feed(
            series(
                'trip',
                'DTSTART;VALUE=DATE:20120110',
                'DTEND;VALUE=DATE:20120120',
                'RRULE:FREQ=MONTHLY'
            ),
            series(
                'on-call',
                'DTSTART:20120101T120000Z',
                'DURATION:P10D',
                'RRULE:FREQ=WEEKLY'
            )
        );
        const range = eventsForRange(events, '2026-11-15', '2026-11-15', 'UTC');
        expect(range.find((e) => e.uid === 'trip')).toMatchObject({
            start: '2026-11-10',
            end: '2026-11-20',
        });
        expect(
            range.filter((e) => e.uid === 'on-call').map((e) => e.start)
        ).toEqual(['2026-11-08T12:00:00.000Z', '2026-11-15T12:00:00.000Z']);
    });

    it('finds an event whose printed date is days from the user date', () => {
        const events = feed(
            // 10:00 UTC on the 11th: 23:00 on the 10th in Pago Pago.
            series(
                'far-zone',
                'DTSTART;TZID=Pacific/Kiritimati:20261112T000000',
                'DTEND;TZID=Pacific/Kiritimati:20261112T003000'
            )
        );
        expect(
            datesOf(events, '2026-11-10', '2026-11-10', 'Pacific/Pago_Pago')
        ).toEqual(['2026-11-10']);
    });

    it('does not list one-off events from other years', () => {
        const events = feed(
            series('old', 'DTSTART:20120105T100000Z', 'DTEND:20120105T110000Z'),
            series('now', 'DTSTART:20261105T100000Z', 'DTEND:20261105T110000Z'),
            series(
                'later',
                'DTSTART:20301105T100000Z',
                'DTEND:20301105T110000Z'
            )
        );
        const range = eventsForRange(
            events,
            '2026-11-01',
            '2026-11-21',
            'Europe/Athens'
        );
        expect(range.map((e) => e.uid)).toEqual(['now']);
    });
});

describe('DST change days', () => {
    const dstEvents = parseCalendar(
        [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//test//EN',
            'BEGIN:VEVENT',
            'UID:autumn@test',
            'DTSTART;TZID=Europe/Athens:20261025T160000',
            'DTEND;TZID=Europe/Athens:20261025T170000',
            'SUMMARY:Dentist',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:spring@test',
            'DTSTART;TZID=Europe/Athens:20270328T160000',
            'DTEND;TZID=Europe/Athens:20270328T170000',
            'SUMMARY:Dentist',
            'END:VEVENT',
            'BEGIN:VEVENT',
            'UID:late@test',
            'DTSTART;TZID=Europe/Athens:20261025T230000',
            'DTEND;TZID=Europe/Athens:20261026T010000',
            'SUMMARY:Late show',
            'END:VEVENT',
            'END:VCALENDAR',
        ].join('\r\n')
    );

    it('keeps the clock time on the 25-hour day when clocks go back', () => {
        const day = eventsForDate(dstEvents, '2026-10-25', 'Europe/Athens');
        const dentist = day.find((e) => e.uid === 'autumn@test');
        expect([dentist.start_minute, dentist.end_minute]).toEqual([960, 1020]);
        const late = day.find((e) => e.uid === 'late@test');
        expect([late.start_minute, late.end_minute]).toEqual([1380, 1440]);
    });

    it('keeps the clock time on the 23-hour day when clocks go forward', () => {
        const dentist = eventsForDate(
            dstEvents,
            '2027-03-28',
            'Europe/Athens'
        ).find((e) => e.uid === 'spring@test');
        expect([dentist.start_minute, dentist.end_minute]).toEqual([960, 1020]);
    });
});

describe('normalizeFeedUrl', () => {
    it('turns webcal links into https', () => {
        expect(normalizeFeedUrl('webcal://example.com/a.ics')).toBe(
            'https://example.com/a.ics'
        );
    });

    it('rejects other schemes', () => {
        expect(() => normalizeFeedUrl('file:///etc/passwd')).toThrow();
        expect(() => normalizeFeedUrl('')).toThrow();
    });
});

describe('fetchFeed', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('refuses private and loopback addresses before connecting', async () => {
        const get = jest.spyOn(axios, 'get');
        await expect(fetchFeed('http://127.0.0.1/cal.ics')).rejects.toThrow(
            FeedFetchError
        );
        await expect(fetchFeed('http://10.0.0.5/cal.ics')).rejects.toThrow(
            FeedFetchError
        );
        expect(get).not.toHaveBeenCalled();
    });

    it('refuses a host that resolves to a private address at connect time', async () => {
        jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
        ]);
        jest.spyOn(dns, 'lookup').mockImplementation((host, opts, cb) =>
            cb(null, [{ address: '127.0.0.1', family: 4 }])
        );

        await expect(
            fetchFeed('http://rebind.example/cal.ics')
        ).rejects.toThrow('CALDAV_ALLOW_PRIVATE_HOSTS');
    });

    it('fetches over keep-alive agents', async () => {
        jest.spyOn(dns.promises, 'lookup').mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
        ]);
        const get = jest.spyOn(axios, 'get').mockResolvedValue({
            status: 200,
            headers: {},
            data: ICS,
        });

        await expect(
            fetchFeed('https://calendar.example/basic.ics')
        ).resolves.toContain('BEGIN:VCALENDAR');

        const config = get.mock.calls[0][1];
        expect(config.httpsAgent.keepAlive).toBe(true);
        expect(config.httpAgent.keepAlive).toBe(true);
    });
});

describe('feeds built to cost the server', () => {
    const calendar = (...lines) =>
        [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//test//EN',
            ...lines,
            'END:VCALENDAR',
        ].join('\r\n');

    const series = (uid, start, rule) => [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `SUMMARY:${uid}`,
        `DTSTART:${start}`,
        `RRULE:${rule}`,
        'END:VEVENT',
    ];

    // In a child process: a regression is an endless loop, which would stop
    // this test run for good rather than fail it.
    const expandInChild = (rule) => {
        const icsEvents = path.resolve(
            __dirname,
            '../../../modules/calendar-feeds/icsEvents'
        );
        const script = `
            const { parseCalendar, eventsForRange } = require(${JSON.stringify(icsEvents)});
            const feed = parseCalendar(process.argv[1]);
            eventsForRange(feed, '2026-06-01', '2026-06-30', 'UTC');
        `;
        return spawnSync(
            process.execPath,
            [
                '-e',
                script,
                calendar(...series('never', '20200101T000000Z', rule)),
            ],
            { encoding: 'utf8', timeout: 30000 }
        );
    };

    it.each([
        'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
        'FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30',
        'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30',
        'FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30',
    ])('reports %s, which no date can pass, instead of hanging', (rule) => {
        const child = expandInChild(rule);

        expect(child.signal).toBeNull();
        expect(child.stderr).toContain('repeating event with no dates');
    });

    it('keeps a rule whose dates are years apart', () => {
        const events = parseCalendar(
            calendar(
                ...series(
                    'leap',
                    '20200229T090000Z',
                    'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29'
                )
            )
        );

        const found = eventsForRange(events, '2028-02-29', '2028-02-29', 'UTC');

        expect(found.map((event) => event.title)).toEqual(['leap']);
    });

    it('counts refused dates from the last date a rule passed', () => {
        // Over 100,000 refused hours by 2026, about 8,800 between matches.
        const events = parseCalendar(
            calendar(
                ...series(
                    'new-year',
                    '20100101T000000Z',
                    'FREQ=HOURLY;BYMONTH=1;BYMONTHDAY=1'
                )
            )
        );

        const found = eventsForRange(events, '2026-01-01', '2026-01-01', 'UTC');

        expect(found).toHaveLength(24);
    });

    it('turns a rule down once it has refused too many dates in a row', () => {
        // Called directly: walking the rule to the limit is what the child
        // process tests above do, and they cannot see a change to this file
        // made by a mutation run.
        const [event] = parseCalendar(
            calendar(
                ...series(
                    'never',
                    '20200101T000000Z',
                    'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'
                )
            )
        );
        const iterator = event.component
            .getFirstPropertyValue('rrule')
            .iterator(event.startDate);

        for (let refused = 0; refused < 100000; refused++) {
            iterator.check_contracting_rules();
        }

        expect(() => iterator.check_contracting_rules()).toThrow(
            'This calendar has a repeating event with no dates'
        );
    });

    it('keeps an exception on its own series only', () => {
        const events = parseCalendar(
            calendar(
                ...series('a', '20260601T090000Z', 'FREQ=DAILY;COUNT=5'),
                ...series('b', '20260601T090000Z', 'FREQ=DAILY;COUNT=5'),
                'BEGIN:VEVENT',
                'UID:a',
                'SUMMARY:a moved',
                'RECURRENCE-ID:20260603T090000Z',
                'DTSTART:20260603T150000Z',
                'END:VEVENT'
            )
        );

        const found = eventsForRange(events, '2026-06-03', '2026-06-03', 'UTC');

        expect(found.map((event) => event.title).sort()).toEqual([
            'a moved',
            'b',
        ]);
        for (const event of events) {
            const expected = event.uid === 'a' ? 1 : 0;
            expect(Object.keys(event.exceptions)).toHaveLength(expected);
        }
    });

    it('stops walking series once the feed has used its steps', () => {
        const lines = [];
        for (let i = 0; i < 20; i++) {
            lines.push(
                ...series(
                    `series-${i}`,
                    '10000101T000000Z',
                    'FREQ=MONTHLY;BYMONTHDAY=1'
                )
            );
        }

        const titles = eventsForRange(
            parseCalendar(calendar(...lines)),
            '2026-06-01',
            '2026-06-01',
            'UTC'
        ).map((event) => event.title);

        expect(titles).toContain('series-0');
        expect(titles).not.toContain('series-19');
    });

    it('counts the dates a rule refuses as steps', () => {
        // Monday 29 February comes about once in 28 years, so this series
        // passes few dates and refuses hundreds of thousands.
        const events = parseCalendar(
            calendar(
                ...series(
                    'rare',
                    '10000101T000000Z',
                    'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO'
                ),
                'BEGIN:VEVENT',
                'UID:after',
                'SUMMARY:after',
                'DTSTART:20260601T090000Z',
                'END:VEVENT'
            )
        );

        const found = eventsForRange(events, '2026-06-01', '2026-06-01', 'UTC');

        expect(found).toEqual([]);
    });

    it('counts dates listed one by one, which no rule looks at', () => {
        const dates = [];
        for (let year = 1000; year < 1800; year++) {
            for (let day = 1; day <= 25; day++) {
                dates.push(`${year}01${String(day).padStart(2, '0')}T000000Z`);
            }
        }
        const lines = [];
        for (let i = 0; i < 11; i++) {
            lines.push(
                'BEGIN:VEVENT',
                `UID:listed-${i}`,
                'SUMMARY:listed',
                'DTSTART:10000101T000000Z',
                `RDATE:${dates.join(',')}`,
                'END:VEVENT'
            );
        }
        lines.push(
            'BEGIN:VEVENT',
            'UID:after',
            'SUMMARY:after',
            'DTSTART:20260601T090000Z',
            'END:VEVENT'
        );

        const found = eventsForRange(
            parseCalendar(calendar(...lines)),
            '2026-06-01',
            '2026-06-01',
            'UTC'
        );

        expect(found).toEqual([]);
    });

    it('starts each range with its full allowance of steps', () => {
        const events = parseCalendar(
            calendar(
                ...series(
                    'rare',
                    '10000101T000000Z',
                    'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO'
                ),
                'BEGIN:VEVENT',
                'UID:first',
                'SUMMARY:first',
                'DTSTART:10000101T090000Z',
                'END:VEVENT'
            )
        );

        eventsForRange(events, '2026-06-01', '2026-06-01', 'UTC');
        const found = eventsForRange(
            events.slice(1),
            '1000-01-01',
            '1000-01-01',
            'UTC'
        );

        expect(found.map((event) => event.title)).toEqual(['first']);
    });

    it('stops collecting once the feed has filled its occurrences', () => {
        const lines = [];
        for (let i = 0; i < 400; i++) {
            lines.push(
                'BEGIN:VEVENT',
                `UID:long-${i}`,
                'DTSTART;VALUE=DATE:20260101',
                'DTEND;VALUE=DATE:20270101',
                'END:VEVENT'
            );
        }

        const found = eventsForRange(
            parseCalendar(calendar(...lines)),
            '2026-06-01',
            '2026-08-01',
            'UTC'
        );

        expect(found.length).toBeGreaterThanOrEqual(20000);
        expect(found.length).toBeLessThan(20100);
    });
});
