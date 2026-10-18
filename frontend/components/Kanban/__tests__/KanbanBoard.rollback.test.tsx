import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import KanbanBoard from '../KanbanBoard';

const mockShowErrorToast = jest.fn();

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key: string, fallback: string) => fallback,
    }),
}));

jest.mock('../../Shared/ToastContext', () => ({
    useToast: () => ({ showErrorToast: mockShowErrorToast }),
}));

jest.mock('../../../utils/csrfService', () => ({
    getCsrfToken: jest.fn().mockResolvedValue('csrf'),
}));

jest.mock('../../Task/TaskItem', () => ({
    __esModule: true,
    default: ({ task }: { task: { id: number; name: string } }) => (
        <div data-testid={`card-${task.id}`}>{task.name}</div>
    ),
}));

const response = (ok: boolean, body: unknown) => ({
    ok,
    status: ok ? 200 : 403,
    headers: { get: () => null },
    json: async () => body,
});

// The column element that holds the header with the given label.
const column = (label: string) =>
    screen.getByText(label).parentElement!.parentElement!;

describe('KanbanBoard move that the server rejects', () => {
    const dataTransfer = { effectAllowed: '', setData: jest.fn() };

    beforeEach(() => {
        mockShowErrorToast.mockClear();
        (global as any).fetch = jest.fn((_url: string, init?: any) =>
            Promise.resolve(
                init?.method === 'PATCH'
                    ? response(false, {})
                    : response(true, {
                          tasks: [
                              {
                                  id: 1,
                                  uid: 'u1',
                                  name: 'Pay rent',
                                  status: 0,
                                  tags: [],
                              },
                          ],
                      })
            )
        );
    });

    it('puts the card back and shows an error', async () => {
        render(<KanbanBoard />);

        const card = await screen.findByTestId('card-1');
        expect(column('To Do')).toContainElement(card);

        fireEvent.dragStart(card.parentElement!, { dataTransfer });
        fireEvent.drop(column('In Progress'), { dataTransfer });

        await waitFor(() => expect(mockShowErrorToast).toHaveBeenCalledTimes(1));
        expect(column('To Do')).toContainElement(screen.getByTestId('card-1'));
        expect(column('In Progress')).not.toContainElement(
            screen.getByTestId('card-1')
        );
    });
});
