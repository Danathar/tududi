const request = require('supertest');
const app = require('../../app');
const { sequelize, User, Task, CalDAVCalendar } = require('../../models');
const bcrypt = require('bcrypt');
const xml2js = require('xml2js');
const { propfind, report } = require('../helpers/caldav-test-utils');

describe('CalDAV Protocol - Phase 3', () => {
    let testUser;
    let testCalendar;
    let authHeader;
    let testTask;

    beforeEach(async () => {
        const hashedPassword = await bcrypt.hash('password123', 10);
        testUser = await User.create({
            email: 'caldav@test.com',
            password_digest: hashedPassword,
            verified: true,
        });

        testCalendar = await CalDAVCalendar.create({
            uid: 'test-calendar-uid',
            user_id: testUser.id,
            name: 'Test Calendar',
            description: 'Calendar for testing',
            enabled: true,
        });

        authHeader =
            'Basic ' +
            Buffer.from('caldav@test.com:password123').toString('base64');
    });

    afterAll(async () => {
        await sequelize.close();
    });

    describe('Discovery', () => {
        test('GET /.well-known/caldav should redirect to /caldav/', async () => {
            const response = await request(app)
                .get('/.well-known/caldav')
                .expect(301);

            expect(response.headers.location).toContain('/caldav/');
        });

        test('PROPFIND /caldav/ should return current-user-principal', async () => {
            const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
                <D:propfind xmlns:D="DAV:">
                    <D:prop>
                        <D:current-user-principal/>
                    </D:prop>
                </D:propfind>`;

            const response = await request(app)
                .propfind('/caldav/')
                .set('Authorization', authHeader)
                .set('Content-Type', 'application/xml')
                .send(propfindBody)
                .expect(207);

            expect(response.text).toContain('current-user-principal');
            expect(response.text).toContain(
                `/caldav/${encodeURIComponent(testUser.email)}/`
            );
        });

        test('PROPFIND /caldav/:username/ should return calendar-home-set', async () => {
            const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
                <D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
                    <D:prop>
                        <C:calendar-home-set/>
                    </D:prop>
                </D:propfind>`;

            const response = await request(app)
                .propfind(`/caldav/${testUser.email}/`)
                .set('Authorization', authHeader)
                .set('Content-Type', 'application/xml')
                .send(propfindBody)
                .expect(207);

            expect(response.text).toContain('calendar-home-set');
            // calendar-home-set now points to the principal so clients can
            // discover the tasks/ calendar as a depth-1 child (fixes Tasks.org)
            expect(response.text).toContain(
                `/caldav/${encodeURIComponent(testUser.email)}/`
            );
        });

        test('PROPFIND /caldav/:username/ depth 1 should expose tasks calendar as child', async () => {
            const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
                <D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
                    <D:allprop/>
                </D:propfind>`;

            const response = await request(app)
                .propfind(`/caldav/${testUser.email}/`)
                .set('Authorization', authHeader)
                .set('Content-Type', 'application/xml')
                .set('Depth', '1')
                .send(propfindBody)
                .expect(207);

            const tasksHref = `/caldav/${encodeURIComponent(testUser.email)}/tasks/`;
            expect(response.text).toContain(tasksHref);
            expect(response.text).toContain('C:calendar');
        });

        test('MKCOL inside tasks calendar should return 409 Conflict', async () => {
            await request(app)
                .mkcol(`/caldav/${testUser.email}/tasks/new-collection/`)
                .set('Authorization', authHeader)
                .expect(409);
        });

        test('MKCOL on tasks calendar itself should return 405', async () => {
            await request(app)
                .mkcol(`/caldav/${testUser.email}/tasks/`)
                .set('Authorization', authHeader)
                .expect(405);
        });
    });

    describe('Authentication', () => {
        // eslint-disable-next-line jest/expect-expect
        test('should reject requests without authentication', async () => {
            await request(app)
                .get('/caldav/caldav@test.com/tasks/')
                .expect(401);
        });

        // eslint-disable-next-line jest/expect-expect
        test('should reject requests with invalid credentials', async () => {
            const badAuth =
                'Basic ' +
                Buffer.from('caldav@test.com:wrongpass').toString('base64');

            await request(app)
                .get('/caldav/caldav@test.com/tasks/')
                .set('Authorization', badAuth)
                .expect(401);
        });

        // eslint-disable-next-line jest/expect-expect
        test('should accept requests with valid HTTP Basic Auth', async () => {
            // Collection GET now returns 200 with iCalendar data and an ETag.
            const response = await request(app)
                .get('/caldav/caldav@test.com/tasks/')
                .set('Authorization', authHeader)
                .expect(200);
            expect(response.headers.etag).toBeDefined();
        });

        // eslint-disable-next-line jest/expect-expect
        test('should reject access to other users calendars', async () => {
            const otherUser = await User.create({
                email: 'other@test.com',
                password_digest: await bcrypt.hash('password', 10),
                verified: true,
            });

            await request(app)
                .get(`/caldav/${otherUser.email}/tasks/`)
                .set('Authorization', authHeader)
                .expect(403);
        });
    });

    describe('OPTIONS', () => {
        test('should return DAV capabilities', async () => {
            const response = await request(app)
                .options('/caldav/caldav@test.com/tasks/')
                .set('Authorization', authHeader)
                .expect(204);

            expect(response.headers.dav).toContain('calendar-access');
            expect(response.headers.allow).toContain('PROPFIND');
            expect(response.headers.allow).toContain('REPORT');
            expect(response.headers.allow).toContain('GET');
            expect(response.headers.allow).toContain('PUT');
            expect(response.headers.allow).toContain('DELETE');
        });
    });

    describe('PROPFIND', () => {
        beforeEach(async () => {
            testTask = await Task.create({
                uid: 'test-task-1',
                user_id: testUser.id,
                name: 'Test Task',
                status: 0,
                priority: 1,
            });
        });

        afterEach(async () => {
            await Task.destroy({ where: { user_id: testUser.id } });
        });

        test('PROPFIND on calendar collection (depth 0) should return calendar properties', async () => {
            const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <C:getctag/>
  </D:prop>
</D:propfind>`;

            const response = await propfind(
                app,
                '/caldav/caldav@test.com/tasks/'
            )
                .set('Authorization', authHeader)
                .set('Depth', '0')
                .set('Content-Type', 'application/xml')
                .send(propfindXml)
                .expect(207);

            expect(response.text).toContain('Tududi Tasks');
            expect(response.text).toContain('getctag');
            expect(response.text).toContain('resourcetype');
        });

        test('PROPFIND on calendar collection (depth 1) should return tasks', async () => {
            const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:getetag/>
  </D:prop>
</D:propfind>`;

            const response = await propfind(
                app,
                '/caldav/caldav@test.com/tasks/'
            )
                .set('Authorization', authHeader)
                .set('Depth', '1')
                .set('Content-Type', 'application/xml')
                .send(propfindXml)
                .expect(207);

            expect(response.text).toContain('test-task-1.ics');
            expect(response.text).toContain('Test Task');
        });

        // #226: XML cannot carry most control characters. One task name
        // with one used to fail the whole multistatus with a 500.
        test('PROPFIND depth 1 strips control characters from a task name', async () => {
            await Task.create({
                uid: 'test-task-ctrl',
                user_id: testUser.id,
                name: 'bad\u0001name',
                note: 'note\u0002with\u001Fcontrols',
                status: 0,
            });

            const response = await propfind(
                app,
                '/caldav/caldav@test.com/tasks/'
            )
                .set('Authorization', authHeader)
                .set('Depth', '1')
                .set('Content-Type', 'application/xml')
                .send(
                    '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>'
                )
                .expect(207);

            expect(response.text).toContain('test-task-1.ics');
            expect(response.text).toContain('test-task-ctrl.ics');
            expect(response.text).toContain('badname');
            expect(response.text).not.toContain('\u0001');
        });

        test('PROPFIND on individual task should return task properties', async () => {
            const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getetag/>
    <D:getcontenttype/>
    <D:getlastmodified/>
  </D:prop>
</D:propfind>`;

            const response = await propfind(
                app,
                '/caldav/caldav@test.com/tasks/test-task-1.ics'
            )
                .set('Authorization', authHeader)
                .set('Depth', '0')
                .set('Content-Type', 'application/xml')
                .send(propfindXml)
                .expect(207);

            expect(response.text).toContain('getetag');
            expect(response.text).toContain('getcontenttype');
            expect(response.text).toContain('getlastmodified');
        });
    });

    describe('REPORT (calendar-query)', () => {
        beforeEach(async () => {
            await Task.create({
                uid: 'report-task-1',
                user_id: testUser.id,
                name: 'Report Test Task',
                status: 0,
                priority: 1,
                due_date: new Date('2026-06-15T10:00:00Z'),
            });
        });

        afterEach(async () => {
            await Task.destroy({ where: { user_id: testUser.id } });
        });

        test('REPORT should filter tasks by time range', async () => {
            const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VTODO">
      <C:time-range start="20260601T000000Z" end="20260630T235959Z"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

            const response = await report(app, '/caldav/caldav@test.com/tasks/')
                .set('Authorization', authHeader)
                .set('Content-Type', 'application/xml')
                .send(reportXml)
                .expect(207);

            expect(response.text).toContain('report-task-1.ics');
            expect(response.text).toContain('BEGIN:VCALENDAR');
            expect(response.text).toContain('BEGIN:VTODO');
        });

        test('REPORT should return only requested properties', async () => {
            const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VTODO"/>
  </C:filter>
</C:calendar-query>`;

            const response = await report(app, '/caldav/caldav@test.com/tasks/')
                .set('Authorization', authHeader)
                .set('Content-Type', 'application/xml')
                .send(reportXml)
                .expect(207);

            expect(response.text).toContain('getetag');
            expect(response.text).not.toContain('BEGIN:VCALENDAR');
        });

        // #226: the note travels inside calendar-data.
        test('REPORT with calendar-data strips control characters from a note', async () => {
            await Task.create({
                uid: 'report-task-ctrl',
                user_id: testUser.id,
                name: 'Control\u0007 chars',
                note: 'line\u0001one\u000Bline two',
                status: 0,
                due_date: new Date('2026-06-16T10:00:00Z'),
            });

            const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VTODO"/>
  </C:filter>
</C:calendar-query>`;

            const response = await report(app, '/caldav/caldav@test.com/tasks/')
                .set('Authorization', authHeader)
                .set('Content-Type', 'application/xml')
                .send(reportXml)
                .expect(207);

            expect(response.text).toContain('report-task-1.ics');
            expect(response.text).toContain('report-task-ctrl.ics');
            expect(response.text).toContain('lineoneline two');
            // eslint-disable-next-line no-control-regex
            expect(response.text).not.toMatch(/[\u0001\u0007\u000B]/);
        });
    });

    describe('GET Task', () => {
        beforeEach(async () => {
            testTask = await Task.create({
                uid: 'get-task-1',
                user_id: testUser.id,
                name: 'Get Task Test',
                status: 0,
                priority: 1,
            });
        });

        afterEach(async () => {
            await Task.destroy({ where: { user_id: testUser.id } });
        });

        test('GET should return VTODO for existing task', async () => {
            const response = await request(app)
                .get('/caldav/caldav@test.com/tasks/get-task-1.ics')
                .set('Authorization', authHeader)
                .expect(200);

            expect(response.text).toContain('BEGIN:VCALENDAR');
            expect(response.text).toContain('BEGIN:VTODO');
            expect(response.text).toContain('UID:get-task-1');
            expect(response.text).toContain('SUMMARY:Get Task Test');
            expect(response.text).toContain('END:VTODO');
            expect(response.text).toContain('END:VCALENDAR');
            expect(response.headers.etag).toBeDefined();
        });

        // eslint-disable-next-line jest/expect-expect
        test('GET should return 404 for non-existent task', async () => {
            await request(app)
                .get('/caldav/caldav@test.com/tasks/non-existent.ics')
                .set('Authorization', authHeader)
                .expect(404);
        });

        // eslint-disable-next-line jest/expect-expect
        test('GET should support If-None-Match (304 Not Modified)', async () => {
            const firstResponse = await request(app)
                .get('/caldav/caldav@test.com/tasks/get-task-1.ics')
                .set('Authorization', authHeader)
                .expect(200);

            const etag = firstResponse.headers.etag;

            await request(app)
                .get('/caldav/caldav@test.com/tasks/get-task-1.ics')
                .set('Authorization', authHeader)
                .set('If-None-Match', etag)
                .expect(304);
        });
    });

    describe('PUT Task', () => {
        afterEach(async () => {
            await Task.destroy({ where: { user_id: testUser.id } });
        });

        test('PUT should create new task from VTODO', async () => {
            const vtodo = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Tududi//CalDAV//EN
BEGIN:VTODO
UID:put-task-new
SUMMARY:New Task via PUT
STATUS:NEEDS-ACTION
PRIORITY:5
END:VTODO
END:VCALENDAR`;

            const response = await request(app)
                .put('/caldav/caldav@test.com/tasks/put-task-new.ics')
                .set('Authorization', authHeader)
                .set('Content-Type', 'text/calendar')
                .send(vtodo)
                .expect(201);

            expect(response.headers.etag).toBeDefined();

            const created = await Task.findOne({
                where: { uid: 'put-task-new' },
            });
            expect(created).toBeDefined();
            expect(created.name).toBe('New Task via PUT');
            expect(created.status).toBe(0);
        });

        test('PUT should update existing task', async () => {
            const existing = await Task.create({
                uid: 'put-task-update',
                user_id: testUser.id,
                name: 'Original Name',
                status: 0,
            });

            const vtodo = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Tududi//CalDAV//EN
BEGIN:VTODO
UID:put-task-update
SUMMARY:Updated Name
STATUS:COMPLETED
END:VTODO
END:VCALENDAR`;

            await request(app)
                .put('/caldav/caldav@test.com/tasks/put-task-update.ics')
                .set('Authorization', authHeader)
                .set('Content-Type', 'text/calendar')
                .send(vtodo)
                .expect(204);

            await existing.reload();
            expect(existing.name).toBe('Updated Name');
            expect(existing.status).toBe(2);
        });

        // eslint-disable-next-line jest/expect-expect
        test('PUT should respect If-Match precondition', async () => {
            const existing = await Task.create({
                uid: 'put-task-match',
                user_id: testUser.id,
                name: 'Test Task',
                status: 0,
            });

            const vtodo = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:put-task-match
SUMMARY:Updated
END:VTODO
END:VCALENDAR`;

            await request(app)
                .put('/caldav/caldav@test.com/tasks/put-task-match.ics')
                .set('Authorization', authHeader)
                .set('If-Match', '"wrong-etag"')
                .set('Content-Type', 'text/calendar')
                .send(vtodo)
                .expect(412);
        });

        // #231: If-None-Match: * means "create only".
        test('PUT with If-None-Match: * does not overwrite an existing task', async () => {
            const put = (summary) =>
                request(app)
                    .put('/caldav/caldav@test.com/tasks/n1.ics')
                    .set('Authorization', authHeader)
                    .set('If-None-Match', '*')
                    .set('Content-Type', 'text/calendar')
                    .send(
                        `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:n1\r\nSUMMARY:${summary}\r\nEND:VTODO\r\nEND:VCALENDAR`
                    );

            await put('original').expect(201);
            await put('overwritten').expect(412);

            const task = await Task.findOne({ where: { uid: 'n1' } });
            expect(task.name).toBe('original');
        });

        test('PUT of a VTODO without SUMMARY creates a task with a fallback name', async () => {
            await request(app)
                .put('/caldav/caldav@test.com/tasks/o1.ics')
                .set('Authorization', authHeader)
                .set('Content-Type', 'text/calendar')
                .send(
                    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:o1\r\nEND:VTODO\r\nEND:VCALENDAR'
                )
                .expect(201);

            const task = await Task.findOne({ where: { uid: 'o1' } });
            expect(task.name).toBe('Untitled');
        });

        test('PUT of a VTODO without SUMMARY keeps the existing name', async () => {
            const existing = await Task.create({
                uid: 'o2',
                user_id: testUser.id,
                name: 'Keep me',
                status: 0,
            });

            await request(app)
                .put('/caldav/caldav@test.com/tasks/o2.ics')
                .set('Authorization', authHeader)
                .set('Content-Type', 'text/calendar')
                .send(
                    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:o2\r\nSTATUS:COMPLETED\r\nEND:VTODO\r\nEND:VCALENDAR'
                )
                .expect(204);

            await existing.reload();
            expect(existing.name).toBe('Keep me');
            expect(existing.status).toBe(2);
        });

        // #230: the habit fields are Tududi-only. A client that edits the
        // task and drops the X-TUDUDI-* properties must not reset them.
        test('PUT without X-TUDUDI-HABIT-* properties keeps the habit data', async () => {
            const existing = await Task.create({
                uid: 'habit-put',
                user_id: testUser.id,
                name: 'Habit',
                status: 0,
                habit_mode: true,
                habit_current_streak: 7,
                habit_total_completions: 20,
            });

            await request(app)
                .put('/caldav/caldav@test.com/tasks/habit-put.ics')
                .set('Authorization', authHeader)
                .set('Content-Type', 'text/calendar')
                .send(
                    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:habit-put\r\nSUMMARY:Habit renamed\r\nEND:VTODO\r\nEND:VCALENDAR'
                )
                .expect(204);

            await existing.reload();
            expect(existing.name).toBe('Habit renamed');
            expect(existing.habit_mode).toBe(true);
            expect(existing.habit_current_streak).toBe(7);
            expect(existing.habit_total_completions).toBe(20);
        });

        // #229: a date-only UNTIL used to be stored as 'Invalid date'.
        test('PUT keeps an RRULE with a date-only UNTIL', async () => {
            await request(app)
                .put('/caldav/caldav@test.com/tasks/m1.ics')
                .set('Authorization', authHeader)
                .set('Content-Type', 'text/calendar')
                .send(
                    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:m1\r\nSUMMARY:Daily until NYE\r\nDTSTART;VALUE=DATE:20250101\r\nRRULE:FREQ=DAILY;UNTIL=20251231\r\nEND:VTODO\r\nEND:VCALENDAR'
                )
                .expect(201);

            const task = await Task.findOne({ where: { uid: 'm1' } });
            expect(task.recurrence_type).toBe('daily');
            expect(task.recurrence_end_date).not.toBeNull();
            expect(
                Number.isNaN(new Date(task.recurrence_end_date).getTime())
            ).toBe(false);

            const response = await request(app)
                .get('/caldav/caldav@test.com/tasks/m1.ics')
                .set('Authorization', authHeader)
                .expect(200);
            expect(response.text).toMatch(/RRULE:FREQ=DAILY;UNTIL=2025123\d/);
        });

        // eslint-disable-next-line jest/expect-expect
        test('PUT should reject invalid VTODO', async () => {
            const invalidVtodo = 'This is not valid iCalendar data';

            await request(app)
                .put('/caldav/caldav@test.com/tasks/invalid.ics')
                .set('Authorization', authHeader)
                .set('Content-Type', 'text/calendar')
                .send(invalidVtodo)
                .expect(400);
        });
    });

    describe('DELETE Task', () => {
        beforeEach(async () => {
            testTask = await Task.create({
                uid: 'delete-task-1',
                user_id: testUser.id,
                name: 'Task to Delete',
                status: 0,
            });
        });

        afterEach(async () => {
            await Task.destroy({ where: { user_id: testUser.id } });
        });

        test('DELETE should remove existing task', async () => {
            await request(app)
                .delete('/caldav/caldav@test.com/tasks/delete-task-1.ics')
                .set('Authorization', authHeader)
                .expect(204);

            const deleted = await Task.findOne({
                where: { uid: 'delete-task-1' },
            });
            expect(deleted).toBeNull();
        });

        // eslint-disable-next-line jest/expect-expect
        test('DELETE should return 404 for non-existent task', async () => {
            await request(app)
                .delete('/caldav/caldav@test.com/tasks/non-existent.ics')
                .set('Authorization', authHeader)
                .expect(404);
        });

        test('DELETE should respect If-Match precondition', async () => {
            await request(app)
                .delete('/caldav/caldav@test.com/tasks/delete-task-1.ics')
                .set('Authorization', authHeader)
                .set('If-Match', '"wrong-etag"')
                .expect(412);

            const stillExists = await Task.findOne({
                where: { uid: 'delete-task-1' },
            });
            expect(stillExists).toBeDefined();
        });
    });

    describe('ETag and CTag', () => {
        beforeEach(async () => {
            testTask = await Task.create({
                uid: 'etag-task',
                user_id: testUser.id,
                name: 'ETag Test',
                status: 0,
            });
        });

        afterEach(async () => {
            await Task.destroy({ where: { user_id: testUser.id } });
        });

        test('ETag should change when task is updated', async () => {
            const response1 = await request(app)
                .get('/caldav/caldav@test.com/tasks/etag-task.ics')
                .set('Authorization', authHeader)
                .expect(200);

            const etag1 = response1.headers.etag;

            await testTask.update({ name: 'Updated Name' });

            const response2 = await request(app)
                .get('/caldav/caldav@test.com/tasks/etag-task.ics')
                .set('Authorization', authHeader)
                .expect(200);

            const etag2 = response2.headers.etag;

            expect(etag1).not.toBe(etag2);
        });

        test('CTag should be present in calendar PROPFIND', async () => {
            const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:getctag/>
  </D:prop>
</D:propfind>`;

            const response = await propfind(
                app,
                '/caldav/caldav@test.com/tasks/'
            )
                .set('Authorization', authHeader)
                .set('Depth', '0')
                .set('Content-Type', 'application/xml')
                .send(propfindXml)
                .expect(207);

            expect(response.text).toContain('getctag');
            expect(response.text).toContain('ctag-');
        });
    });
});
