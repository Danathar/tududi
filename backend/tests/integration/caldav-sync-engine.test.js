const request = require('supertest');
const bcrypt = require('bcrypt');
const axios = require('axios');
const app = require('../../app');
const {
    sequelize,
    User,
    Task,
    CalDAVCalendar,
    CalDAVRemoteCalendar,
    CalDAVSyncState,
} = require('../../models');
const syncEngine = require('../../modules/caldav/sync/sync-engine');
const MergePhase = require('../../modules/caldav/sync/merge-phase');
const PullPhase = require('../../modules/caldav/sync/pull-phase');
const syncScheduler = require('../../modules/caldav/services/sync-scheduler');
const syncController = require('../../modules/caldav/api/sync-controller');
const remoteCalendarController = require('../../modules/caldav/api/remote-calendar-controller');
const encryptionService = require('../../modules/caldav/services/encryption-service');
const {
    serializeTaskToVTODO,
} = require('../../modules/caldav/icalendar/vtodo-serializer');

jest.mock('axios');
// The fake calendar host does not resolve, and these tests are about sync
// behavior, not the address guard (see caldav-safe-request.test.js).
jest.mock('../../modules/url/ssrfGuard', () => ({
    ...jest.requireActual('../../modules/url/ssrfGuard'),
    assertPublicHostname: jest.fn().mockResolvedValue(undefined),
}));

describe('CalDAV Sync Engine', () => {
    let testUser;
    let calendar;
    let remoteCalendar;

    beforeAll(async () => {
        await sequelize.sync({ force: true });
    });

    beforeEach(async () => {
        testUser = await User.create({
            email: 'synctest@test.com',
            password_digest: await bcrypt.hash('password', 10),
            verified: true,
        });

        calendar = await CalDAVCalendar.create({
            uid: 'calendar-uid-1',
            user_id: testUser.id,
            name: 'Test Calendar',
            enabled: true,
            sync_direction: 'bidirectional',
            sync_interval_minutes: 15,
            conflict_resolution: 'last_write_wins',
        });

        remoteCalendar = await CalDAVRemoteCalendar.create({
            user_id: testUser.id,
            local_calendar_id: calendar.id,
            name: 'Remote Test Calendar',
            server_url: 'https://caldav.example.com',
            calendar_path: '/calendars/test/tasks/',
            username: 'testuser',
            password_encrypted: encryptionService.encrypt('password123'),
            auth_type: 'basic',
            enabled: true,
            sync_direction: 'bidirectional',
        });
    });

    afterEach(async () => {
        await CalDAVSyncState.destroy({ where: {} });
        await CalDAVRemoteCalendar.destroy({ where: {} });
        await CalDAVCalendar.destroy({ where: {} });
        await Task.destroy({ where: {} });
        await User.destroy({ where: {} });
        jest.clearAllMocks();
    });

    afterAll(async () => {
        await sequelize.close();
    });

    describe('Pull Phase', () => {
        test('should fetch and create new tasks from remote', async () => {
            const mockReportResponse = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/test/tasks/task-1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-task-1"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Tududi//EN
BEGIN:VTODO
UID:remote-task-1
SUMMARY:Remote Task
STATUS:NEEDS-ACTION
PRIORITY:5
END:VTODO
END:VCALENDAR</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:sync-token>new-sync-token-123</d:sync-token>
</d:multistatus>`;

            axios.mockResolvedValue({
                status: 207,
                data: mockReportResponse,
                headers: {},
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'pull' }
            );

            expect(result.success).toBe(true);
            expect(result.stats.pulled).toBeGreaterThan(0);

            const createdTask = await Task.findOne({
                where: { uid: 'remote-task-1' },
            });
            expect(createdTask).toBeTruthy();
            expect(createdTask.name).toBe('Remote Task');
        });

        // RFC 5545 3.8.1.9: no PRIORITY (or PRIORITY:0) is "undefined
        // priority". Storing that as Low is what made a task created in 2Do
        // come back to every client as PRIORITY:7 (#1907).
        test('should keep a remote task without PRIORITY as having no priority', async () => {
            const icalFor = (uid, priorityLine) =>
                [
                    'BEGIN:VCALENDAR',
                    'VERSION:2.0',
                    'PRODID:-//Tududi//EN',
                    'BEGIN:VTODO',
                    `UID:${uid}`,
                    `SUMMARY:${uid}`,
                    'STATUS:NEEDS-ACTION',
                    ...(priorityLine ? [priorityLine] : []),
                    'END:VTODO',
                    'END:VCALENDAR',
                ].join('\r\n');

            const responseFor = (uid, priorityLine) => `<d:response>
  <d:href>/calendars/test/tasks/${uid}.ics</d:href>
  <d:propstat>
    <d:prop>
      <d:getetag>"etag-${uid}"</d:getetag>
      <cal:calendar-data>${icalFor(uid, priorityLine)}</cal:calendar-data>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;

            axios.mockResolvedValue({
                status: 207,
                data: `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
${responseFor('no-priority-task')}
${responseFor('priority-zero-task', 'PRIORITY:0')}
${responseFor('priority-five-task', 'PRIORITY:5')}
</d:multistatus>`,
                headers: {},
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'pull' }
            );
            expect(result.success).toBe(true);

            const noPriority = await Task.findOne({
                where: { uid: 'no-priority-task' },
            });
            expect(noPriority).not.toBeNull();
            expect(noPriority.priority).toBeNull();

            const zeroPriority = await Task.findOne({
                where: { uid: 'priority-zero-task' },
            });
            expect(zeroPriority.priority).toBeNull();

            const mediumPriority = await Task.findOne({
                where: { uid: 'priority-five-task' },
            });
            expect(mediumPriority.priority).toBe(1);

            // What the client gets back: no PRIORITY property at all.
            const served = await serializeTaskToVTODO(noPriority);
            expect(served).not.toContain('PRIORITY');
        });

        test('should detect deleted tasks from remote', async () => {
            const localTask = await Task.create({
                uid: 'task-to-delete',
                user_id: testUser.id,
                name: 'Task to Delete',
                status: 0,
            });

            await CalDAVSyncState.create({
                task_id: localTask.id,
                calendar_id: calendar.id,
                etag: 'old-etag',
                last_modified: new Date(),
                last_synced_at: new Date(),
                sync_status: 'synced',
            });

            const mockReportResponse = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/calendars/test/tasks/task-to-delete.ics</d:href>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:response>
</d:multistatus>`;

            axios.mockResolvedValue({
                status: 207,
                data: mockReportResponse,
                headers: {},
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'pull' }
            );

            expect(result.success).toBe(true);

            const deletedTask = await Task.findOne({
                where: { uid: 'task-to-delete' },
            });
            expect(deletedTask).toBeNull();
        });

        test('should handle authentication failure', async () => {
            axios.mockRejectedValue({
                response: { status: 401 },
                message: 'Unauthorized',
            });

            await expect(
                syncEngine.syncCalendar(calendar.id, testUser.id, {
                    direction: 'pull',
                })
            ).rejects.toThrow();
        });
    });

    describe('Merge Phase', () => {
        test('should update task from remote when only remote modified', async () => {
            const task = await Task.create({
                uid: 'test-task',
                user_id: testUser.id,
                name: 'Original Name',
                status: 0,
            });

            const pastTime = new Date(Date.now() - 10000);
            await CalDAVSyncState.create({
                task_id: task.id,
                calendar_id: calendar.id,
                etag: 'old-etag',
                last_modified: pastTime,
                last_synced_at: pastTime,
                sync_status: 'synced',
            });

            const mockReportResponse = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/test/tasks/test-task.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"new-etag"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:test-task
SUMMARY:Updated Name from Remote
STATUS:IN-PROCESS
END:VTODO
END:VCALENDAR</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

            axios.mockResolvedValue({
                status: 207,
                data: mockReportResponse,
                headers: {},
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'pull' }
            );

            expect(result.success).toBe(true);

            await task.reload();
            expect(task.name).toBe('Updated Name from Remote');
            expect(task.status).toBe(1);
        });

        test('should detect conflict when both local and remote modified', async () => {
            const task = await Task.create({
                uid: 'conflict-task',
                user_id: testUser.id,
                name: 'Original Name',
                status: 0,
            });

            const pastTime = new Date(Date.now() - 10000);
            await CalDAVSyncState.create({
                task_id: task.id,
                calendar_id: calendar.id,
                etag: 'old-etag',
                last_modified: pastTime,
                last_synced_at: pastTime,
                sync_status: 'synced',
            });

            await task.update({ name: 'Local Update' });

            const mockReportResponse = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/test/tasks/conflict-task.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"new-etag"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:conflict-task
SUMMARY:Remote Update
STATUS:IN-PROCESS
END:VTODO
END:VCALENDAR</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

            axios.mockResolvedValue({
                status: 207,
                data: mockReportResponse,
                headers: {},
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'pull' }
            );

            expect(result.success).toBe(true);
        });
    });

    describe('Push Phase', () => {
        test('should push new local task to remote', async () => {
            const task = await Task.create({
                uid: 'new-local-task',
                user_id: testUser.id,
                name: 'New Local Task',
                status: 0,
            });

            axios.mockResolvedValue({
                status: 201,
                headers: {
                    etag: '"new-task-etag"',
                },
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'push' }
            );

            expect(result.success).toBe(true);
            expect(result.stats.pushed).toBeGreaterThan(0);
            expect(axios).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'PUT',
                    url: expect.stringContaining('new-local-task.ics'),
                })
            );
        });

        test('should push modified local task to remote', async () => {
            const task = await Task.create({
                uid: 'modified-task',
                user_id: testUser.id,
                name: 'Modified Task',
                status: 1,
            });

            const pastTime = new Date(Date.now() - 10000);
            await CalDAVSyncState.create({
                task_id: task.id,
                calendar_id: calendar.id,
                etag: 'old-etag',
                last_modified: pastTime,
                last_synced_at: pastTime,
                sync_status: 'synced',
            });

            await task.update({ name: 'Updated Locally' });

            axios.mockResolvedValue({
                status: 204,
                headers: {
                    etag: '"updated-etag"',
                },
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'push' }
            );

            expect(result.success).toBe(true);
            expect(result.stats.pushed).toBeGreaterThan(0);
        });

        test('should detect conflict on push with precondition failed', async () => {
            const task = await Task.create({
                uid: 'push-conflict-task',
                user_id: testUser.id,
                name: 'Task',
                status: 0,
            });

            await CalDAVSyncState.create({
                task_id: task.id,
                calendar_id: calendar.id,
                etag: 'etag-1',
                last_modified: new Date(),
                // Backdated: the push phase only considers a task changed when
                // updated_at is strictly greater than last_synced_at, and both
                // stamps land in the same millisecond often enough to make this
                // test flaky when it uses "now".
                last_synced_at: new Date(Date.now() - 60000),
                sync_status: 'synced',
            });

            await task.update({ name: 'Local Update' });

            axios.mockRejectedValue({
                response: { status: 412 },
                message: 'Precondition Failed',
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'push' }
            );

            expect(result.success).toBe(true);
            expect(result.phases.push.errors.length).toBeGreaterThan(0);
        });
    });

    describe('Bidirectional Sync', () => {
        test('should complete full bidirectional sync', async () => {
            const localTask = await Task.create({
                uid: 'local-task',
                user_id: testUser.id,
                name: 'Local Task',
                status: 0,
            });

            const mockReportResponse = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/test/tasks/remote-task.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"remote-etag"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:remote-task
SUMMARY:Remote Task
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

            axios.mockImplementation((config) => {
                if (config.method === 'REPORT') {
                    return Promise.resolve({
                        status: 207,
                        data: mockReportResponse,
                        headers: {},
                    });
                } else if (config.method === 'PUT') {
                    return Promise.resolve({
                        status: 201,
                        headers: { etag: '"new-etag"' },
                    });
                }
                return Promise.reject(new Error('Unexpected request'));
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'bidirectional' }
            );

            expect(result.success).toBe(true);
            expect(result.stats.pulled).toBeGreaterThan(0);
            expect(result.stats.pushed).toBeGreaterThan(0);

            const remoteTaskLocal = await Task.findOne({
                where: { uid: 'remote-task' },
            });
            expect(remoteTaskLocal).toBeTruthy();
        });
    });

    describe('Dry Run Mode', () => {
        test('should not apply changes in dry run mode', async () => {
            const mockReportResponse = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/test/tasks/dry-run-task.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"dry-run-etag"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:dry-run-task
SUMMARY:Dry Run Task
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

            axios.mockResolvedValue({
                status: 207,
                data: mockReportResponse,
                headers: {},
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'pull', dryRun: true }
            );

            expect(result.success).toBe(true);
            expect(result.dryRun).toBe(true);

            const task = await Task.findOne({ where: { uid: 'dry-run-task' } });
            expect(task).toBeNull();
        });
    });

    describe('Sync Status', () => {
        test('should update calendar sync status on success', async () => {
            axios.mockResolvedValue({
                status: 207,
                data: '<?xml version="1.0" encoding="utf-8" ?><d:multistatus xmlns:d="DAV:"></d:multistatus>',
                headers: {},
            });

            await syncEngine.syncCalendar(calendar.id, testUser.id);

            await calendar.reload();
            expect(calendar.last_sync_at).toBeTruthy();
            expect(calendar.last_sync_status).toBe('success');
        });

        test('should update calendar sync status on error', async () => {
            axios.mockRejectedValue(new Error('Network error'));

            await expect(
                syncEngine.syncCalendar(calendar.id, testUser.id)
            ).rejects.toThrow();

            await calendar.reload();
            expect(calendar.last_sync_status).toBe('error');
        });
    });

    describe('Conflict Resolution Strategies', () => {
        test('should use local_wins strategy', async () => {
            await calendar.update({ conflict_resolution: 'local_wins' });

            const task = await Task.create({
                uid: 'strategy-test-task',
                user_id: testUser.id,
                name: 'Local Version',
                status: 1,
            });

            const pastTime = new Date(Date.now() - 10000);
            await CalDAVSyncState.create({
                task_id: task.id,
                calendar_id: calendar.id,
                etag: 'old-etag',
                last_modified: pastTime,
                last_synced_at: pastTime,
                sync_status: 'synced',
            });

            await task.update({ name: 'Updated Local Version' });

            const mockReportResponse = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/test/tasks/strategy-test-task.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"new-etag"</d:getetag>
        <cal:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTODO
UID:strategy-test-task
SUMMARY:Remote Version
STATUS:COMPLETED
END:VTODO
END:VCALENDAR</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

            axios.mockResolvedValue({
                status: 207,
                data: mockReportResponse,
                headers: {},
            });

            const result = await syncEngine.syncCalendar(
                calendar.id,
                testUser.id,
                { direction: 'pull' }
            );

            expect(result.success).toBe(true);

            await task.reload();
            expect(task.name).toBe('Updated Local Version');
        });
    });

    describe('Sync engine regressions', () => {
        const HREF_BASE = '/calendars/test/tasks/';
        const LONG_AGO = () => new Date(Date.now() - 60000);

        const vcalendar = (uid, lines = []) =>
            [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//Tududi//EN',
                'BEGIN:VTODO',
                `UID:${uid}`,
                ...lines,
                'END:VTODO',
                'END:VCALENDAR',
            ].join('\r\n');

        const multistatus = (responses, syncToken = null) => {
            const token = syncToken
                ? `<d:sync-token>${syncToken}</d:sync-token>`
                : '';
            return `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
${responses.join('\n')}
${token}
</d:multistatus>`;
        };

        const taskResponse = (uid, etag, lines) => {
            return `<d:response>
  <d:href>${HREF_BASE}${uid}.ics</d:href>
  <d:propstat>
    <d:prop>
      <d:getetag>"${etag}"</d:getetag>
      <cal:calendar-data>${vcalendar(uid, lines)}</cal:calendar-data>
    </d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
</d:response>`;
        };

        // A task synced with the remote copy at etag-<uid>. By default the
        // last sync is later than the task's updated_at, so it counts as not
        // edited locally; pass an earlier syncedAt to make it locally edited.
        const syncedTask = async (uid, fields = {}, syncedAt = null) => {
            const task = await Task.create({
                uid,
                user_id: testUser.id,
                name: uid,
                status: 0,
                ...fields,
            });
            const lastSync = syncedAt || new Date(Date.now() + 60000);
            await CalDAVSyncState.create({
                task_id: task.id,
                calendar_id: calendar.id,
                etag: `etag-${uid}`,
                remote_href: `${HREF_BASE}${uid}.ics`,
                last_modified: lastSync,
                last_synced_at: lastSync,
                sync_status: 'synced',
            });
            return task;
        };

        const requestsBy = (method) =>
            axios.mock.calls.filter(([config]) => config.method === method);

        describe('pull: 404 propstats (#223)', () => {
            test('a 404 propstat for one unsupported property does not delete the task', async () => {
                await remoteCalendar.update({ server_sync_token: 'token-1' });
                const task = await syncedTask('kept-task');

                const partial404 = `<d:response>
  <d:href>${HREF_BASE}kept-task.ics</d:href>
  <d:propstat>
    <d:prop><d:getetag>"etag-kept-task"</d:getetag></d:prop>
    <d:status>HTTP/1.1 200 OK</d:status>
  </d:propstat>
  <d:propstat>
    <d:prop><d:getcontenttype/></d:prop>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
</d:response>`;
                const ics = vcalendar('kept-task', ['SUMMARY:kept-task']);

                axios.mockImplementation((config) => {
                    if (config.method === 'REPORT') {
                        return Promise.resolve({
                            status: 207,
                            headers: {},
                            data: multistatus([partial404], 'token-2'),
                        });
                    }
                    if (config.method === 'GET') {
                        return Promise.resolve({
                            status: 200,
                            headers: { etag: '"etag-kept-task"' },
                            data: ics,
                        });
                    }
                    return Promise.reject(
                        new Error(`Unexpected ${config.method}`)
                    );
                });

                const result = await syncEngine.syncCalendar(
                    calendar.id,
                    testUser.id,
                    { direction: 'pull' }
                );

                expect(result.success).toBe(true);
                expect(result.phases.merge.deleted).toHaveLength(0);
                expect(await Task.findByPk(task.id)).not.toBeNull();
            });

            test('a response whose only propstat is 404 is still a deletion', async () => {
                const gone = `<d:response>
  <d:href>${HREF_BASE}gone.ics</d:href>
  <d:propstat>
    <d:prop><d:getetag/></d:prop>
    <d:status>HTTP/1.1 404 Not Found</d:status>
  </d:propstat>
</d:response>`;

                const pull = new PullPhase();
                const changes = await pull._parseReportResponse(
                    multistatus([gone]),
                    remoteCalendar,
                    calendar,
                    'UTC'
                );

                expect(changes).toHaveLength(1);
                expect(changes[0]).toMatchObject({
                    action: 'delete',
                    href: `${HREF_BASE}gone.ics`,
                });
            });
        });

        describe('sync direction and dry run (#224)', () => {
            const mockRemote = (reportData = multistatus([])) =>
                axios.mockImplementation((config) => {
                    if (config.method === 'REPORT') {
                        return Promise.resolve({
                            status: 207,
                            headers: {},
                            data: reportData,
                        });
                    }
                    if (config.method === 'PUT') {
                        return Promise.resolve({
                            status: 201,
                            headers: { etag: '"pushed-etag"' },
                        });
                    }
                    return Promise.reject(
                        new Error(`Unexpected ${config.method}`)
                    );
                });

            const createLocalTask = () =>
                Task.create({
                    uid: 'local-only',
                    user_id: testUser.id,
                    name: 'Local only',
                    status: 0,
                });

            test('a scheduled sync of a pull_only calendar pulls and never pushes', async () => {
                await calendar.update({ sync_direction: 'pull_only' });
                await createLocalTask();
                mockRemote();

                const stored = await CalDAVCalendar.findByPk(calendar.id);
                const result = await syncScheduler._syncCalendar(stored);

                expect(result.success).toBe(true);
                expect(result.phases.pull).toBeDefined();
                expect(result.phases.push).toBeUndefined();
                expect(requestsBy('REPORT')).toHaveLength(1);
                expect(requestsBy('PUT')).toHaveLength(0);
            });

            test('a scheduled sync of a push_only calendar pushes and never pulls', async () => {
                await calendar.update({ sync_direction: 'push_only' });
                await createLocalTask();
                mockRemote();

                const stored = await CalDAVCalendar.findByPk(calendar.id);
                const result = await syncScheduler._syncCalendar(stored);

                expect(result.success).toBe(true);
                expect(result.phases.pull).toBeUndefined();
                expect(result.phases.push).toBeDefined();
                expect(requestsBy('REPORT')).toHaveLength(0);
                expect(requestsBy('PUT')).toHaveLength(1);
            });

            test('Sync now follows the calendar setting when no direction is given', async () => {
                await calendar.update({ sync_direction: 'pull_only' });
                await createLocalTask();
                mockRemote();

                const res = { json: jest.fn() };
                const next = jest.fn();
                await syncController.syncCalendar(
                    {
                        params: { id: calendar.id },
                        currentUser: { id: testUser.id },
                        body: { dryRun: false },
                    },
                    res,
                    next
                );

                expect(next).not.toHaveBeenCalled();
                const [[body]] = res.json.mock.calls;
                expect(body.direction).toBe('pull');
                expect(requestsBy('PUT')).toHaveLength(0);
            });

            test('sync of all calendars honours dryRun', async () => {
                const remoteTask = taskResponse('dry-run-all', 'etag-dry', [
                    'SUMMARY:Dry run',
                ]);
                mockRemote(multistatus([remoteTask]));

                const result = await syncScheduler.syncUserCalendars(
                    testUser.id,
                    { dryRun: true }
                );

                expect(result.failedCalendars).toBe(0);
                const created = await Task.findOne({
                    where: { uid: 'dry-run-all' },
                });
                expect(created).toBeNull();
                expect(requestsBy('PUT')).toHaveLength(0);
            });

            test('an unknown direction is an error, not a silent success', async () => {
                await expect(
                    syncEngine.syncCalendar(calendar.id, testUser.id, {
                        direction: 'sideways',
                    })
                ).rejects.toThrow('Invalid sync direction');
                expect(axios).not.toHaveBeenCalled();
            });
        });

        describe('resolving a deleted-remotely conflict (#225)', () => {
            const deleteConflict = async (uid) => {
                await calendar.update({ conflict_resolution: 'manual' });
                const task = await syncedTask(uid, {}, LONG_AGO());

                const merge = await new MergePhase().execute(calendar, [
                    { action: 'delete', href: `${HREF_BASE}${uid}.ics` },
                ]);
                expect(merge.conflicts).toHaveLength(1);

                return task;
            };

            test('keep local keeps the task and recreates it on the server', async () => {
                const task = await deleteConflict('keep-local');

                const phase = new MergePhase();
                await phase.resolveConflict(task.id, calendar.id, 'local');

                const state = await CalDAVSyncState.findOne({
                    where: { task_id: task.id, calendar_id: calendar.id },
                });
                expect(state.sync_status).toBe('pending');
                expect(state.remote_href).toBeNull();
                expect(state.etag).toBeFalsy();

                // The next full listing (still without the resource) must not
                // delete the task.
                const pull = new PullPhase();
                const deletions = await pull._findRemoteDeletions(calendar, []);
                expect(deletions).toHaveLength(0);
                expect(await Task.findByPk(task.id)).not.toBeNull();
            });

            test('keep remote deletes the task', async () => {
                const task = await deleteConflict('keep-remote');

                const phase = new MergePhase();
                await phase.resolveConflict(task.id, calendar.id, 'remote');

                expect(await Task.findByPk(task.id)).toBeNull();
                const states = await CalDAVSyncState.count({
                    where: { task_id: task.id },
                });
                expect(states).toBe(0);
            });
        });

        describe('remote calendar location and sync token (#227)', () => {
            const updateRemote = async (body) => {
                const res = { json: jest.fn() };
                const next = jest.fn();
                await remoteCalendarController.updateRemoteCalendar(
                    {
                        params: { id: remoteCalendar.id },
                        currentUser: { id: testUser.id },
                        body,
                    },
                    res,
                    next
                );
                expect(next).not.toHaveBeenCalled();
            };

            const syncStateCount = () =>
                CalDAVSyncState.count({ where: { calendar_id: calendar.id } });

            test('pointing the calendar at a new URL resets sync state without deleting tasks', async () => {
                await remoteCalendar.update({ server_sync_token: 'old' });
                const first = await syncedTask('moved-1');
                const second = await syncedTask('moved-2');

                await updateRemote({ server_url: 'https://new.example.com' });

                await remoteCalendar.reload();
                expect(remoteCalendar.server_url).toBe(
                    'https://new.example.com'
                );
                expect(remoteCalendar.server_sync_token).toBeNull();
                expect(await syncStateCount()).toBe(0);

                axios.mockResolvedValue({
                    status: 207,
                    headers: {},
                    data: multistatus([]),
                });
                const result = await syncEngine.syncCalendar(
                    calendar.id,
                    testUser.id,
                    { direction: 'pull' }
                );

                expect(result.phases.merge.deleted).toHaveLength(0);
                expect(await Task.findByPk(first.id)).not.toBeNull();
                expect(await Task.findByPk(second.id)).not.toBeNull();
            });

            test('an update that keeps the URL keeps the sync state', async () => {
                await remoteCalendar.update({ server_sync_token: 'kept' });
                await syncedTask('unchanged');

                await updateRemote({ name: 'Renamed' });

                await remoteCalendar.reload();
                expect(remoteCalendar.server_sync_token).toBe('kept');
                expect(await syncStateCount()).toBe(1);
            });

            test('a rejected sync token falls back to a full listing', async () => {
                await remoteCalendar.update({ server_sync_token: 'stale<&>' });
                const remoteTask = taskResponse('after-reset', 'etag-reset', [
                    'SUMMARY:After reset',
                ]);

                axios.mockImplementation((config) => {
                    if (
                        config.method === 'REPORT' &&
                        config.data.includes('sync-collection')
                    ) {
                        return Promise.reject({
                            response: { status: 403 },
                            message: 'Forbidden',
                        });
                    }
                    if (config.method === 'REPORT') {
                        return Promise.resolve({
                            status: 207,
                            headers: {},
                            data: multistatus([remoteTask]),
                        });
                    }
                    return Promise.reject(
                        new Error(`Unexpected ${config.method}`)
                    );
                });

                const result = await syncEngine.syncCalendar(
                    calendar.id,
                    testUser.id,
                    { direction: 'pull' }
                );

                expect(result.success).toBe(true);
                const reports = requestsBy('REPORT');
                expect(reports).toHaveLength(2);
                expect(reports[0][0].data).toContain(
                    '<D:sync-token>stale&lt;&amp;&gt;</D:sync-token>'
                );
                const created = await Task.findOne({
                    where: { uid: 'after-reset' },
                });
                expect(created).not.toBeNull();

                await remoteCalendar.reload();
                expect(remoteCalendar.server_sync_token).toBeNull();
            });
        });

        describe('statuses iCalendar cannot express (#228)', () => {
            const pullUpdate = async (uid, lines) => {
                axios.mockResolvedValue({
                    status: 207,
                    headers: {},
                    data: multistatus([
                        taskResponse(uid, `etag-${uid}-2`, lines),
                    ]),
                });
                const result = await syncEngine.syncCalendar(
                    calendar.id,
                    testUser.id,
                    { direction: 'pull' }
                );
                expect(result.success).toBe(true);
            };

            test.each([
                ['waiting', 4, 'NEEDS-ACTION'],
                ['planned', 6, 'NEEDS-ACTION'],
                ['archived', 3, 'COMPLETED'],
            ])(
                'a remote rename keeps a %s task at its status',
                async (label, status, icalStatus) => {
                    const task = await syncedTask(`${label}-task`, {
                        status,
                    });

                    await pullUpdate(`${label}-task`, [
                        'SUMMARY:New title',
                        `STATUS:${icalStatus}`,
                    ]);

                    await task.reload();
                    expect(task.name).toBe('New title');
                    expect(task.status).toBe(status);
                }
            );

            test('a real remote status change still applies', async () => {
                const task = await syncedTask('waiting-started', {
                    status: 4,
                });

                await pullUpdate('waiting-started', [
                    'SUMMARY:waiting-started',
                    'STATUS:IN-PROCESS',
                ]);

                await task.reload();
                expect(task.status).toBe(1);
            });
        });
    });
});
