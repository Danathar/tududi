import { resolveTaskTokens, tokenChanges } from '../taskTokens';
import { analyzeInboxText } from '../inboxService';

jest.mock('../inboxService', () => ({
    analyzeInboxText: jest.fn(),
}));

const analysis = (overrides: Record<string, unknown> = {}) => ({
    parsed_tags: [],
    parsed_projects: [],
    cleaned_content: 'water plants',
    parsed_due_date: '2026-10-26',
    parsed_due_time: null,
    parsed_recurrence: null,
    parsed_area: null,
    ...overrides,
});

describe('task title tokens', () => {
    beforeEach(() => {
        (analyzeInboxText as jest.Mock).mockReset();
    });

    it('carries the parsed recurrence and time into the saved changes', async () => {
        const recurrence = {
            recurrence_type: 'weekly',
            recurrence_interval: 1,
            recurrence_weekdays: [1],
        };
        (analyzeInboxText as jest.Mock).mockResolvedValue(
            analysis({
                parsed_due_time: '09:30',
                parsed_recurrence: recurrence,
            })
        );

        const resolved = await resolveTaskTokens(
            'water plants every monday 9:30',
            [],
            []
        );
        const { changes } = tokenChanges(
            'water plants every monday 9:30',
            resolved,
            []
        );

        expect(changes).toEqual({
            name: 'water plants',
            due_date: '2026-10-26',
            due_time: '09:30',
            ...recurrence,
        });
    });

    it('sends no time or recurrence when the text has none', async () => {
        (analyzeInboxText as jest.Mock).mockResolvedValue(analysis());

        const resolved = await resolveTaskTokens('water plants', [], []);
        const { changes } = tokenChanges('water plants', resolved, []);

        expect(changes).toEqual({
            name: 'water plants',
            due_date: '2026-10-26',
        });
    });

    it('drops the time when there is no due date', async () => {
        (analyzeInboxText as jest.Mock).mockResolvedValue(
            analysis({ parsed_due_date: null, parsed_due_time: '09:30' })
        );

        const resolved = await resolveTaskTokens('water plants', [], []);

        expect(resolved?.dueTime).toBeNull();
    });
});
