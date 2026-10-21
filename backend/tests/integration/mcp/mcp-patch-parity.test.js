'use strict';

// MCP's update_task and complete_task re-implement, by hand, what
// PATCH /api/task/:uid does after it saves a task: completed_at, recurring
// advance, subtask cascade, task history, clearing the example mark, due time
// and reminders. Each piece was copied over separately (#163, #165, #179), and
// every upstream sync can add one more step to PATCH that MCP never learns.
//
// This suite makes the same edit to two identical tasks, one through PATCH and
// one through MCP, and requires the stored results to match. A step added to
// PATCH but not to MCP (or the reverse) shows up here as a named difference
// instead of as a bug report later.

const request = require('supertest');
const app = require('../../../app');
const { Task, TaskEvent, RecurringCompletion } = require('../../../models');
const { createTestUser } = require('../../helpers/testUtils');
const { createApiToken } = require('../../../modules/users/apiTokenService');

// Columns PATCH and MCP can both change. Two dates match when they are less
// than a minute apart (or both empty), so the two requests running a few
// milliseconds apart do not count as a difference in completed_at, even when
// they fall either side of a minute boundary.
const COMPARED_COLUMNS = [
    'name',
    'note',
    'status',
    'priority',
    'today',
    'due_date',
    'due_has_time',
    'reminder_at',
    'reminder_sent_at',
    'defer_until',
    'completed_at',
    'example_of',
];

const MCP_STATUS = {
    not_started: Task.STATUS.NOT_STARTED,
    in_progress: Task.STATUS.IN_PROGRESS,
    done: Task.STATUS.DONE,
};
const MCP_PRIORITY = { low: 0, medium: 1, high: 2 };

const DAILY = { recurrence_type: 'daily', recurrence_interval: 1 };

const DATE_TOLERANCE_MS = 60_000;

function comparable(value) {
    return value ?? null;
}

function sameValue(a, b) {
    if (a instanceof Date && b instanceof Date) {
        return Math.abs(a - b) < DATE_TOLERANCE_MS;
    }
    return JSON.stringify(a) === JSON.stringify(b);
}

// Dates are shown to the minute in a reported difference.
function shown(value) {
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString().slice(0, 16));
    }
    return JSON.stringify(value);
}

// The same edit in PATCH's body shape: numeric status and priority.
function asPatchBody(mcpArguments) {
    const body = { ...mcpArguments };
    if (body.status !== undefined) body.status = MCP_STATUS[body.status];
    if (body.priority !== undefined)
        body.priority = MCP_PRIORITY[body.priority];
    return body;
}

describe('MCP task edits match PATCH /api/task/:uid', () => {
    let user, apiToken;

    beforeEach(async () => {
        user = await createTestUser({
            email: `mcp_parity_${Date.now()}@example.com`,
        });
        ({ rawToken: apiToken } = await createApiToken({
            userId: user.id,
            name: 'MCP Parity Token',
            expiresAt: null,
        }));
    });

    async function createTask(seed, { withSubtask }) {
        const task = await Task.create({
            user_id: user.id,
            name: 'Task',
            status: Task.STATUS.NOT_STARTED,
            ...seed,
        });
        if (withSubtask) {
            await Task.create({
                user_id: user.id,
                name: 'Subtask',
                status: Task.STATUS.NOT_STARTED,
                parent_task_id: task.id,
            });
        }
        return task;
    }

    // Everything an edit can leave behind: the row, its subtasks' statuses,
    // its history (without the web/mcp source, which is meant to differ) and
    // its recorded recurring completions.
    async function storedState(task) {
        const row = await Task.findByPk(task.id);
        const state = {};
        for (const column of COMPARED_COLUMNS) {
            state[column] = comparable(row[column]);
        }
        const subtasks = await Task.findAll({
            where: { parent_task_id: task.id },
            order: [['id', 'ASC']],
        });
        state.subtask_statuses = subtasks.map((subtask) => subtask.status);
        const events = await TaskEvent.findAll({
            where: { task_id: task.id },
            order: [['id', 'ASC']],
        });
        state.history = events.map(
            (event) => `${event.event_type}:${event.field_name}`
        );
        state.recurring_completions = await RecurringCompletion.count({
            where: { task_id: task.id },
        });
        return state;
    }

    function differences(viaPatch, viaMcp) {
        return Object.keys(viaPatch)
            .filter((key) => !sameValue(viaPatch[key], viaMcp[key]))
            .map(
                (key) =>
                    `${key}: PATCH=${shown(viaPatch[key])} MCP=${shown(viaMcp[key])}`
            );
    }

    function patchTask(task, body) {
        return request(app)
            .patch(`/api/task/${task.uid}`)
            .set('Authorization', `Bearer ${apiToken}`)
            .send(body);
    }

    function callMcpTool(name, args) {
        return request(app)
            .post('/api/mcp')
            .set('Authorization', `Bearer ${apiToken}`)
            .set('Content-Type', 'application/json')
            .set('Accept', 'application/json, text/event-stream')
            .send({
                jsonrpc: '2.0',
                method: 'tools/call',
                params: { name, arguments: args },
                id: 1,
            });
    }

    function expectMcpSuccess(response) {
        expect(response.status).toBe(200);
        expect(response.text).not.toContain('"isError":true');
    }

    describe('update_task', () => {
        const cases = [
            ['completing a task with a subtask', {}, true, { status: 'done' }],
            [
                'completing a recurring task',
                { ...DAILY, due_date: new Date('2030-01-10T23:59:00Z') },
                false,
                { status: 'done' },
            ],
            [
                'completing a recurring task whose reminder was sent',
                {
                    ...DAILY,
                    due_date: new Date('2030-01-10T17:00:00Z'),
                    due_has_time: true,
                    reminder_at: new Date('2030-01-10T16:00:00Z'),
                    reminder_sent_at: new Date('2030-01-10T16:00:05Z'),
                },
                false,
                { status: 'done' },
            ],
            [
                'reopening a done task with a subtask',
                { status: Task.STATUS.DONE, completed_at: new Date() },
                true,
                { status: 'not_started' },
            ],
            [
                'starting a task with a subtask',
                {},
                true,
                { status: 'in_progress' },
            ],
            [
                'setting a due date with a time',
                {},
                false,
                { due_date: '2030-02-01', due_time: '09:30' },
            ],
            [
                'adding a time to an existing due date',
                { due_date: new Date('2030-02-01T23:59:59Z') },
                false,
                { due_time: '09:30' },
            ],
            [
                'changing only the due date drops its time',
                {
                    due_date: new Date('2030-02-01T09:30:00Z'),
                    due_has_time: true,
                },
                false,
                { due_date: '2030-02-03' },
            ],
            [
                'setting a reminder',
                {},
                false,
                { reminder_at: '2030-03-01T10:00:00Z' },
            ],
            [
                'removing a sent reminder',
                {
                    reminder_at: new Date('2030-03-01T10:00:00Z'),
                    reminder_sent_at: new Date('2030-03-01T10:00:01Z'),
                },
                false,
                { reminder_at: null },
            ],
            [
                'deferring a task',
                { due_date: new Date('2030-05-01T23:59:00Z') },
                false,
                { defer_until: '2030-04-01T08:00:00Z' },
            ],
            [
                'editing an example task',
                { example_of: 'welcome-1' },
                false,
                { priority: 'high' },
            ],
            ['renaming', {}, false, { name: 'Renamed' }],
            ['editing the note', {}, false, { note: 'Updated note' }],
            ['adding to Today', {}, false, { today: true }],
        ];

        it.each(cases)('%s', async (_label, seed, withSubtask, edit) => {
            const viaPatch = await createTask(seed, { withSubtask });
            const viaMcp = await createTask(seed, { withSubtask });

            const patchResponse = await patchTask(viaPatch, asPatchBody(edit));
            expect(patchResponse.status).toBe(200);
            expectMcpSuccess(
                await callMcpTool('update_task', { id: viaMcp.uid, ...edit })
            );

            expect(
                differences(
                    await storedState(viaPatch),
                    await storedState(viaMcp)
                )
            ).toEqual([]);
        });
    });

    // complete_task toggles between done and not started, so it is compared
    // with PATCH sending the status the toggle lands on.
    describe('complete_task', () => {
        const cases = [
            ['completing a task with a subtask', {}, true],
            [
                'completing a recurring task',
                { ...DAILY, due_date: new Date('2030-01-10T23:59:00Z') },
                false,
            ],
            [
                'reopening a done task with a subtask',
                { status: Task.STATUS.DONE, completed_at: new Date() },
                true,
            ],
            ['completing an example task', { example_of: 'welcome-1' }, false],
        ];

        it.each(cases)('%s', async (_label, seed, withSubtask) => {
            const viaPatch = await createTask(seed, { withSubtask });
            const viaMcp = await createTask(seed, { withSubtask });
            const toggledStatus =
                viaPatch.status === Task.STATUS.DONE
                    ? Task.STATUS.NOT_STARTED
                    : Task.STATUS.DONE;

            const patchResponse = await patchTask(viaPatch, {
                status: toggledStatus,
            });
            expect(patchResponse.status).toBe(200);
            expectMcpSuccess(
                await callMcpTool('complete_task', { id: viaMcp.uid })
            );

            expect(
                differences(
                    await storedState(viaPatch),
                    await storedState(viaMcp)
                )
            ).toEqual([]);
        });
    });
});
