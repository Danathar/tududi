'use strict';

jest.mock('../../../../modules/views/repository', () => ({
    findByUidAndUser: jest.fn(),
}));

const viewsRepository = require('../../../../modules/views/repository');
const {
    registerViewTools,
} = require('../../../../modules/mcp/tools/viewTools');

const DATE_FILTERS = [
    'today',
    'tomorrow',
    'this_week',
    'next_week',
    'next_month',
];

function findTool(toolName) {
    const tools = [];
    registerViewTools(null, { userId: 1 }, tools);
    return tools.find((entry) => entry.name === toolName);
}

function dueProperty(toolName) {
    return findTool(toolName).inputSchema.properties.due;
}

describe('view tool due filter schema', () => {
    it('lists the date filters create_view and update_view actually apply', () => {
        for (const toolName of ['create_view', 'update_view']) {
            const due = dueProperty(toolName);
            expect(due.enum).toEqual(DATE_FILTERS);
            for (const value of DATE_FILTERS) {
                expect(due.description).toContain(value);
            }
        }
    });
});

describe('update_view due filter handling', () => {
    let view;

    beforeEach(() => {
        view = {
            uid: 'view-1',
            name: 'Old',
            update: jest.fn().mockResolvedValue(undefined),
            toJSON: () => ({}),
        };
        viewsRepository.findByUidAndUser.mockResolvedValue(view);
    });

    it('saves a valid due filter', async () => {
        await findTool('update_view').handler({
            uid: 'view-1',
            due: 'this_week',
        });
        expect(view.update).toHaveBeenCalledWith({ due: 'this_week' });
    });

    it('rejects an unknown due filter without saving', async () => {
        await expect(
            findTool('update_view').handler({ uid: 'view-1', due: 'someday' })
        ).rejects.toThrow();
        expect(view.update).not.toHaveBeenCalled();
    });

    it('leaves due out of the update when it is not given', async () => {
        await findTool('update_view').handler({
            uid: 'view-1',
            name: 'New',
        });
        expect(view.update).toHaveBeenCalledWith({ name: 'New' });
    });
});
