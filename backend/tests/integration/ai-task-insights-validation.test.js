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
