jest.mock('openai', () => jest.fn());

const request = require('supertest');
const OpenAI = require('openai');
const app = require('../../app');
const entitlements = require('../../services/entitlementsService');
const { createTestUser } = require('../helpers/testUtils');

const OK_RESPONSE = {
    choices: [{ message: { content: '{}' } }],
    model: 'test-model',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

// A request that cannot be answered must be refused with a 400 before the
// user is charged an AI request / credit - and must not crash into a 500.
describe('AI Assistant - task insights input validation', () => {
    let agent;
    let mockCreate;
    let consumeSpy;

    beforeEach(async () => {
        process.env.LLM_API_KEY = 'test-key';
        mockCreate = jest.fn().mockResolvedValue(OK_RESPONSE);
        OpenAI.mockImplementation(() => ({
            chat: { completions: { create: (...args) => mockCreate(...args) } },
        }));
        consumeSpy = jest.spyOn(entitlements, 'consumeUsages');

        await createTestUser({ email: 'ai-insights-validation@example.com' });
        agent = request.agent(app);
        await agent.post('/api/login').send({
            email: 'ai-insights-validation@example.com',
            password: 'password123',
        });
    });

    afterEach(() => {
        delete process.env.LLM_API_KEY;
        consumeSpy.mockRestore();
    });

    it.each([
        ['a number taskNote', { taskName: 'Write', taskNote: 42 }],
        ['an object taskNote', { taskName: 'Write', taskNote: { a: 1 } }],
        ['an array taskNote', { taskName: 'Write', taskNote: ['x'] }],
        ['a non-string taskName', { taskName: 7 }],
        ['a non-string projectDescription', { projectDescription: 5 }],
        ['a non-array taskTags', { taskName: 'Write', taskTags: 'a,b' }],
        ['non-string taskTags items', { taskName: 'Write', taskTags: [1] }],
        ['a non-number subtaskCount', { taskName: 'Write', subtaskCount: '2' }],
    ])('returns 400 and charges nothing for %s', async (_label, body) => {
        const response = await agent
            .post('/api/ai-assistant/task-insights')
            .send(body);

        expect(response.status).toBe(400);
        expect(consumeSpy).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each([
        'taskUid',
        'taskName',
        'taskNote',
        'taskDueDate',
        'projectName',
        'projectDescription',
        'projectStatus',
        'projectGoal',
        'projectArea',
    ])('returns 400 and charges nothing for a number %s', async (field) => {
        const response = await agent
            .post('/api/ai-assistant/task-insights')
            .send({ taskName: 'Write', [field]: 3 });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe(`${field} must be a string.`);
        expect(consumeSpy).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
    });

    it.each([
        ['an object taskStatus', { taskName: 'Write', taskStatus: { a: 1 } }],
        ['a boolean taskStatus', { taskName: 'Write', taskStatus: true }],
        ['an array taskPriority', { taskName: 'Write', taskPriority: [1] }],
        ['a boolean taskPriority', { taskName: 'Write', taskPriority: false }],
        ['a JSON array body', []],
        ['a JSON array body with an object', [{ taskName: 'Write' }]],
    ])('returns 400 and charges nothing for %s', async (_label, body) => {
        const response = await agent
            .post('/api/ai-assistant/task-insights')
            .send(body);

        expect(response.status).toBe(400);
        expect(consumeSpy).not.toHaveBeenCalled();
        expect(mockCreate).not.toHaveBeenCalled();
    });

    // The task page builds this body from the task as stored: status may be
    // a number or a name, a task without a priority sends null, and empty
    // optional fields go out as undefined (dropped by JSON) or [] / 0.
    it.each([
        [
            'a numeric status and null priority',
            {
                taskUid: 'abc123',
                taskName: 'Write the report',
                taskStatus: 0,
                taskPriority: null,
                taskTags: [],
                subtaskCount: 0,
            },
        ],
        [
            'a named status and numeric priority',
            {
                taskUid: 'abc123',
                taskName: 'Write the report',
                taskStatus: 'in_progress',
                taskPriority: 2,
                taskDueDate: '2026-10-20',
                projectName: 'Reports',
                projectStatus: 'active',
            },
        ],
        [
            'every optional field null',
            {
                taskUid: null,
                taskName: 'Write the report',
                taskNote: null,
                taskStatus: null,
                taskPriority: null,
                taskDueDate: null,
                taskTags: null,
                subtaskCount: null,
                projectName: null,
                projectDescription: null,
                projectStatus: null,
                projectGoal: null,
                projectArea: null,
            },
        ],
    ])('charges once and answers a request with %s', async (_label, body) => {
        const response = await agent
            .post('/api/ai-assistant/task-insights')
            .send(body);

        expect(response.status).toBe(200);
        expect(consumeSpy).toHaveBeenCalledTimes(1);
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('still charges once and answers a valid request', async () => {
        const response = await agent
            .post('/api/ai-assistant/task-insights')
            .send({
                taskName: 'Write the report',
                taskNote: 'Quarterly numbers',
                taskTags: ['work'],
                subtaskCount: 2,
            });

        expect(response.status).toBe(200);
        expect(consumeSpy).toHaveBeenCalledTimes(1);
        expect(mockCreate).toHaveBeenCalledTimes(1);
    });
});
