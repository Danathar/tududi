import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import QuickCaptureInput from '../QuickCaptureInput';
import { resetCaptureSettingsCache } from '../../../utils/captureSettings';
import { analyzeInboxText } from '../../../utils/inboxService';
import { fetchProjects } from '../../../utils/projectsService';

jest.mock('react-i18next', () => ({
    initReactI18next: { type: '3rdParty', init: jest.fn() },
    useTranslation: () => ({
        t: (
            key: string,
            fallback?: string,
            values?: Record<string, string | number>
        ) =>
            (fallback || key).replace(/\{\{(\w+)\}\}/g, (_, name) =>
                String(values?.[name] ?? '')
            ),
    }),
}));

jest.mock('../../Shared/ToastContext', () => ({
    useToast: () => ({
        showSuccessToast: jest.fn(),
        showErrorToast: jest.fn(),
    }),
}));

jest.mock('../../../store/useStore', () => {
    const state = {
        tagsStore: {
            getTags: () => [],
            setTags: jest.fn(),
            refreshTags: jest.fn().mockResolvedValue(undefined),
        },
        tasksStore: { createTask: jest.fn(), deleteTask: jest.fn() },
        projectsStore: { setProjects: jest.fn() },
        areasStore: { areas: [{ id: 7, uid: 'work', name: 'Work' }] },
        notesStore: { addNote: jest.fn() },
        userSettingsStore: { focus: null },
    };
    return {
        useStore: Object.assign(() => state, { getState: () => state }),
    };
});

jest.mock('../../../utils/tagsService', () => ({ createTag: jest.fn() }));
jest.mock('../../../utils/notesService', () => ({
    createNote: jest.fn(),
    deleteNote: jest.fn(),
}));
jest.mock('../../../utils/projectsService', () => ({
    createProject: jest.fn(),
    deleteProject: jest.fn(),
    fetchProjects: jest.fn(),
}));
jest.mock('../../../utils/inboxService', () => ({
    ...jest.requireActual('../../../utils/inboxService'),
    analyzeInboxText: jest.fn(),
    createInboxItemWithStore: jest.fn(),
    deleteInboxItemWithStore: jest.fn(),
}));

// The coloured copy of the text sits right before the textarea, behind it.
const input = () =>
    screen.getByTestId('quick-capture-input') as HTMLTextAreaElement;
const overlay = () => input().previousElementSibling as HTMLElement | null;
const type = (value: string) =>
    fireEvent.change(input(), {
        target: { value, selectionStart: value.length },
    });

const renderBox = (props: Record<string, unknown>) =>
    render(
        <MemoryRouter>
            <QuickCaptureInput projects={[]} {...props} />
        </MemoryRouter>
    );

describe('QuickCaptureInput token colours', () => {
    beforeEach(() => {
        localStorage.clear();
        resetCaptureSettingsCache();
        Object.defineProperty(window, 'matchMedia', {
            value: undefined,
            writable: true,
            configurable: true,
        });
        (fetchProjects as jest.Mock).mockReset().mockResolvedValue([]);
        (analyzeInboxText as jest.Mock).mockReset().mockResolvedValue({
            parsed_tags: [],
            parsed_projects: [],
            cleaned_content: '',
        });
    });

    it('colours each token kind in the main capture box', () => {
        renderBox({ unified: true });
        type('Plan #admin +Launch @Ann ~Work');

        const layer = overlay();
        expect(layer).toHaveAttribute('aria-hidden', 'true');
        expect(layer).toHaveTextContent('Plan #admin +Launch @Ann ~Work');

        const spanFor = (text: string) =>
            Array.from(layer!.querySelectorAll('span')).find(
                (span) => span.textContent === text
            );
        expect(spanFor('#admin')).toHaveClass('text-blue-600');
        expect(spanFor('+Launch')).toHaveClass('text-green-700');
        expect(spanFor('@Ann')).toHaveClass('text-indigo-600');
        expect(spanFor('~Work')).toHaveClass('text-purple-600');
        expect(spanFor('Plan ')?.className).toBe('');

        // The typed text itself is hidden so only the coloured copy shows.
        expect(input()).toHaveClass('text-transparent');
    });

    it('colours tokens in the edit box', () => {
        renderBox({ mode: 'edit', initialValue: 'Call #bank' });

        expect(overlay()).toHaveTextContent('Call #bank');
        expect(input()).toHaveClass('text-transparent');
    });

    it('leaves the plain capture box uncoloured', () => {
        renderBox({});
        type('Call #bank');

        expect(overlay()).toBeNull();
        expect(input()).not.toHaveClass('text-transparent');
    });

    it('pads a trailing line break so the copy keeps the new line', () => {
        renderBox({ unified: true });
        type('Buy milk\n');

        expect(overlay()!.textContent).toBe('Buy milk\n ');
    });
});
