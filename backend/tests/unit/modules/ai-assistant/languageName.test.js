// Fork-only cases for the daily brief's language name, kept apart from
// languageRule.test.js so that file stays identical to upstream's.
const mockCreate = jest.fn();

jest.mock('openai', () => jest.fn());

const OpenAI = require('openai');
const { createTestUser } = require('../../../helpers/testUtils');
const aiAssistantService = require('../../../../modules/ai-assistant/service');

async function briefLanguageRule(slug, language) {
    const user = await createTestUser({
        email: `ai-lang-name-${slug}@example.com`,
        language,
    });

    await aiAssistantService.generateDailyBrief(user.id);

    const params = mockCreate.mock.calls[0][0];
    return params.messages.find((m) => m.role === 'system').content;
}

describe('AI Assistant - language name', () => {
    let savedKey;

    beforeEach(() => {
        savedKey = process.env.LLM_API_KEY;
        process.env.LLM_API_KEY = 'test-key';
        mockCreate.mockReset();
        mockCreate.mockResolvedValue({
            choices: [
                {
                    message: {
                        content:
                            '{"overview":"ok","focus":"ok","priority_actions":[],"watch_out":[],"insight":"ok"}',
                    },
                },
            ],
            model: 'test-model',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
        });
        OpenAI.mockImplementation(() => ({
            chat: { completions: { create: (...args) => mockCreate(...args) } },
        }));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (savedKey === undefined) delete process.env.LLM_API_KEY;
        else process.env.LLM_API_KEY = savedKey;
    });

    it('maps the app code ua to Ukrainian', async () => {
        expect(await briefLanguageRule('ua', 'ua')).toMatch(
            /LANGUAGE RULE: .*in Ukrainian/
        );
    });

    it('falls back to English when the user has no language', async () => {
        expect(await briefLanguageRule('empty', '')).toMatch(
            /LANGUAGE RULE: .*in English/
        );
    });

    it('passes on a code Intl cannot name', async () => {
        expect(await briefLanguageRule('bad', 'x')).toMatch(
            /LANGUAGE RULE: .* in x,/
        );
    });

    it('names the language in English on a server with another locale', async () => {
        const { DisplayNames } = Intl;
        jest.spyOn(Intl, 'DisplayNames').mockImplementation(
            (locales, options) =>
                new DisplayNames(locales.length ? locales : ['de'], options)
        );

        expect(await briefLanguageRule('locale', 'el')).toMatch(
            /LANGUAGE RULE: .*in Greek/
        );
    });
});
