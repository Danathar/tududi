import React from 'react';
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import AreaDetails from '../AreaDetails';
import { fetchTasks } from '../../../utils/tasksService';
import { ToastProvider } from '../../Shared/ToastContext';

jest.mock('../../../i18n', () => ({
    __esModule: true,
    default: {},
}));

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key: string, fallback: string) => fallback,
    }),
}));

const area: Record<string, unknown> = {
    id: 1,
    uid: 'areauid1',
    name: 'Work',
    description: '',
    color: null,
};

const otherArea: Record<string, unknown> = {
    id: 2,
    uid: 'areauid2',
    name: 'Home',
    description: '',
    color: null,
};

const mockLeaveShare = jest.fn<Promise<void>, unknown[]>(() =>
    Promise.resolve()
);
const mockSetAreas = jest.fn();
const mockNavigate = jest.fn();

jest.mock('../../../utils/sharesService', () => ({
    leaveShare: (...args: unknown[]) => mockLeaveShare(...args),
}));

jest.mock('react-router-dom', () => ({
    ...jest.requireActual('react-router-dom'),
    useNavigate: () => mockNavigate,
}));

jest.mock('../../Roadmap/RoadmapChart', () => ({
    __esModule: true,
    default: ({ areaUid }: { areaUid: string }) => (
        <div>roadmap chart for {areaUid}</div>
    ),
}));

jest.mock('../../Shared/ShareModal', () => ({
    __esModule: true,
    default: () => null,
}));

const goals = [
    { uid: 'goal-1', title: 'Goal one', area_id: 1, status: 'active' },
    { uid: 'goal-2', title: 'Goal two', area_id: 1, status: 'active' },
];

const tasks = [
    { uid: 'task-1', name: 'Active task', status: 'not_started' },
    { uid: 'task-2', name: 'Done task', status: 'done' },
    { uid: 'task-3', name: 'Archived task', status: 'archived' },
];

const projects = [
    { uid: 'project-1', name: 'Project one', area: { uid: 'areauid1' } },
    {
        uid: 'project-2',
        name: 'Shipped project',
        status: 'done',
        area: { uid: 'areauid1' },
    },
];

jest.mock('../../../utils/tasksService', () => ({
    fetchTasks: jest.fn(() => Promise.resolve({ tasks })),
}));

jest.mock('../../Task/TaskList', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('../AreaModal', () => ({
    __esModule: true,
    default: () => null,
}));

const mockFetchProjects = jest.fn(() => Promise.resolve(projects));
const mockSetProjects = jest.fn();
const mockLoadGoals = jest.fn();

jest.mock('../../../utils/projectsService', () => ({
    fetchProjects: (...args: unknown[]) => mockFetchProjects(...(args as [])),
}));

jest.mock('../../../store/useStore', () => {
    const buildState = () => ({
        areasStore: {
            areas: [area, otherArea],
            isLoading: false,
            loadAreas: jest.fn(),
            setAreas: mockSetAreas,
        },
        projectsStore: {
            projects,
            hasLoaded: true,
            isLoading: false,
            loadProjects: jest.fn(),
            setProjects: mockSetProjects,
        },
        tasksStore: {
            tasks: [],
            setTasks: jest.fn(),
        },
        goalsStore: {
            goals,
            hasLoaded: true,
            isLoading: false,
            loadGoals: mockLoadGoals,
            setGoals: jest.fn(),
        },
    });
    let state: ReturnType<typeof buildState> | undefined;
    const getState = () => (state ??= buildState());
    const useStore = (selector: any) => selector(getState());
    useStore.getState = getState;
    return { useStore };
});

const renderPage = () =>
    render(
        <ToastProvider>
            <MemoryRouter initialEntries={['/area/areauid1-work']}>
                <Routes>
                    <Route path="/area/:uidSlug" element={<AreaDetails />} />
                </Routes>
            </MemoryRouter>
        </ToastProvider>
    );

describe('AreaDetails header stats', () => {
    it('shows the total task count (active + completed), matching the tasks list below', async () => {
        renderPage();

        await waitFor(() => {
            expect(screen.getByText('3 tasks')).toBeInTheDocument();
        });

        expect(screen.getByText('2 goals')).toBeInTheDocument();
    });

    it('links the projects stat to the projects list filtered by this area', async () => {
        renderPage();

        const projectsLink = await screen.findByText('2 projects');
        expect(projectsLink.closest('a')).toHaveAttribute(
            'href',
            '/projects?area=areauid1'
        );
    });
});

describe('AreaDetails timeline', () => {
    it('shows the chart for this area on its tab', async () => {
        renderPage();
        await screen.findByText('Project one');

        fireEvent.click(screen.getByRole('button', { name: 'Timeline' }));

        expect(
            screen.getByText('roadmap chart for areauid1')
        ).toBeInTheDocument();
        expect(screen.queryByText('Project one')).not.toBeInTheDocument();
    });
});

describe('AreaDetails finished projects', () => {
    it('folds done projects away until the Finished toggle is opened', async () => {
        renderPage();

        expect(await screen.findByText('Project one')).toBeInTheDocument();
        expect(screen.queryByText('Shipped project')).not.toBeInTheDocument();

        fireEvent.click(screen.getByTestId('area-finished-projects-toggle'));

        expect(screen.getByText('Shipped project')).toBeInTheDocument();
    });
});

describe('AreaDetails leaving a shared area', () => {
    afterEach(() => {
        delete area.can_leave;
        mockLeaveShare.mockClear();
        mockNavigate.mockClear();
    });

    it('offers Leave only when the area is shared with the viewer', async () => {
        renderPage();
        await screen.findByText('Project one');
        expect(screen.queryByTestId('area-leave')).not.toBeInTheDocument();
    });

    it('leaves after confirming and goes back to the areas list', async () => {
        area.can_leave = true;
        renderPage();

        fireEvent.click(await screen.findByTestId('area-leave'));
        expect(screen.getByText('Leave area')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

        await waitFor(() =>
            expect(mockLeaveShare).toHaveBeenCalledWith('area', 'areauid1')
        );
        await waitFor(() =>
            expect(mockNavigate).toHaveBeenCalledWith('/areas')
        );
    });
});

describe('AreaDetails refreshing', () => {
    beforeEach(() => {
        mockFetchProjects.mockClear();
        mockSetProjects.mockClear();
        mockLoadGoals.mockClear();
    });

    it('fetches projects and goals again when the area opens', async () => {
        renderPage();
        await screen.findByText('Project one');

        await waitFor(() => expect(mockSetProjects).toHaveBeenCalled());
        expect(mockFetchProjects).toHaveBeenCalledWith('all', '');
        expect(mockLoadGoals).toHaveBeenCalledWith(true);
    });

    it('fetches again when the window comes back into focus', async () => {
        renderPage();
        await screen.findByText('Project one');
        await waitFor(() => expect(mockSetProjects).toHaveBeenCalled());
        mockFetchProjects.mockClear();
        mockLoadGoals.mockClear();

        fireEvent.focus(window);

        await waitFor(() => expect(mockFetchProjects).toHaveBeenCalled());
        expect(mockLoadGoals).toHaveBeenCalledWith(true);
    });
});

describe('AreaDetails refreshing in the background', () => {
    const mockFetchTasks = fetchTasks as unknown as jest.Mock;
    const defaultFetchTasks = () => Promise.resolve({ tasks });

    const deferred = <T,>() => {
        let resolve!: (value: T) => void;
        let reject!: (reason?: unknown) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    };

    const setVisibility = (state: 'visible' | 'hidden') =>
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => state,
        });

    const clearCalls = () => {
        mockFetchProjects.mockClear();
        mockSetProjects.mockClear();
        mockLoadGoals.mockClear();
        mockFetchTasks.mockClear();
    };

    beforeEach(() => {
        clearCalls();
        mockFetchTasks.mockImplementation(defaultFetchTasks);
    });

    afterEach(() => {
        // Drops the own property so jsdom's getter shows through again.
        delete (document as unknown as Record<string, unknown>).visibilityState;
    });

    const openAndSettle = async () => {
        const view = renderPage();
        await screen.findByText('3 tasks');
        await waitFor(() => expect(mockSetProjects).toHaveBeenCalled());
        clearCalls();
        return view;
    };

    it('fetches the area tasks again when the window comes back into focus', async () => {
        await openAndSettle();
        mockFetchTasks.mockImplementation(() =>
            Promise.resolve({
                tasks: [...tasks, { uid: 'task-4', name: 'New', status: 'x' }],
            })
        );

        fireEvent.focus(window);

        expect(await screen.findByText('4 tasks')).toBeInTheDocument();
        expect(mockFetchTasks).toHaveBeenCalledWith(
            '?area_uid=areauid1&type=all&status=all'
        );
    });

    it('fetches again when the page becomes visible', async () => {
        await openAndSettle();

        fireEvent(document, new Event('visibilitychange'));

        await waitFor(() => expect(mockFetchProjects).toHaveBeenCalled());
        expect(mockLoadGoals).toHaveBeenCalledWith(true);
        expect(mockFetchTasks).toHaveBeenCalled();
    });

    it('does not fetch while the page is hidden', async () => {
        await openAndSettle();
        setVisibility('hidden');

        fireEvent.focus(window);
        fireEvent(document, new Event('visibilitychange'));

        expect(mockFetchProjects).not.toHaveBeenCalled();
        expect(mockLoadGoals).not.toHaveBeenCalled();
        expect(mockFetchTasks).not.toHaveBeenCalled();
    });

    it('stops listening once the page is closed', async () => {
        const { unmount } = await openAndSettle();
        unmount();

        fireEvent.focus(window);
        fireEvent(document, new Event('visibilitychange'));

        expect(mockFetchProjects).not.toHaveBeenCalled();
        expect(mockLoadGoals).not.toHaveBeenCalled();
        expect(mockFetchTasks).not.toHaveBeenCalled();
    });

    it('does not listen for focus when the area is not found', async () => {
        render(
            <ToastProvider>
                <MemoryRouter initialEntries={['/area/missing-area']}>
                    <Routes>
                        <Route
                            path="/area/:uidSlug"
                            element={<AreaDetails />}
                        />
                    </Routes>
                </MemoryRouter>
            </ToastProvider>
        );
        await waitFor(() => expect(mockFetchProjects).toHaveBeenCalled());
        clearCalls();

        fireEvent.focus(window);
        fireEvent(document, new Event('visibilitychange'));

        expect(mockFetchProjects).not.toHaveBeenCalled();
        expect(mockLoadGoals).not.toHaveBeenCalled();
    });

    it('fetches nothing on open when the address names no area', async () => {
        render(
            <ToastProvider>
                <MemoryRouter initialEntries={['/area']}>
                    <Routes>
                        <Route
                            path="/area/:uidSlug?"
                            element={<AreaDetails />}
                        />
                    </Routes>
                </MemoryRouter>
            </ToastProvider>
        );
        await screen.findByText('Area not found');

        expect(mockFetchProjects).not.toHaveBeenCalled();
        expect(mockLoadGoals).not.toHaveBeenCalled();
    });

    it('fetches again when the viewer moves to another area', async () => {
        render(
            <ToastProvider>
                <MemoryRouter initialEntries={['/area/areauid1-work']}>
                    <Link to="/area/areauid2-home">go home</Link>
                    <Routes>
                        <Route
                            path="/area/:uidSlug"
                            element={<AreaDetails />}
                        />
                    </Routes>
                </MemoryRouter>
            </ToastProvider>
        );
        await waitFor(() => expect(mockSetProjects).toHaveBeenCalled());
        clearCalls();

        fireEvent.click(screen.getByText('go home'));

        await waitFor(() => expect(mockFetchProjects).toHaveBeenCalled());
        expect(mockLoadGoals).toHaveBeenCalledWith(true);
        await waitFor(() =>
            expect(mockFetchTasks).toHaveBeenCalledWith(
                '?area_uid=areauid2&type=all&status=all'
            )
        );
    });

    it('treats a reply without tasks as an empty list', async () => {
        mockFetchTasks.mockImplementation(() => Promise.resolve({}));
        renderPage();

        await waitFor(() => expect(mockFetchTasks).toHaveBeenCalled());
        await act(async () => {
            await Promise.resolve();
        });

        expect(screen.getByText('0 tasks')).toBeInTheDocument();
    });

    describe('on the Tasks tab', () => {
        const openTasksTab = () =>
            fireEvent.click(
                screen.getByRole('button', { name: /^Tasks \(\d+\)$/ })
            );

        it('shows loading for the first fetch, then clears it', async () => {
            const first = deferred<{ tasks: unknown[] }>();
            mockFetchTasks.mockImplementation(() => first.promise);
            renderPage();
            await screen.findByText('Project one');
            openTasksTab();

            expect(screen.getByText('Loading tasks…')).toBeInTheDocument();

            first.resolve({ tasks });

            await waitFor(() =>
                expect(
                    screen.queryByText('Loading tasks…')
                ).not.toBeInTheDocument()
            );
        });

        it('does not show loading for a refresh', async () => {
            await openAndSettle();
            openTasksTab();
            const refresh = deferred<{ tasks: unknown[] }>();
            mockFetchTasks.mockImplementation(() => refresh.promise);

            fireEvent.focus(window);
            await waitFor(() => expect(mockFetchTasks).toHaveBeenCalled());

            expect(
                screen.queryByText('Loading tasks…')
            ).not.toBeInTheDocument();
            refresh.resolve({ tasks });
        });

        it('keeps the first fetch loading when a refresh finishes before it', async () => {
            const first = deferred<{ tasks: unknown[] }>();
            mockFetchTasks.mockImplementation(() => first.promise);
            renderPage();
            await screen.findByText('Project one');
            openTasksTab();
            mockFetchTasks.mockImplementation(defaultFetchTasks);

            fireEvent.focus(window);
            await screen.findByText('3 tasks');

            expect(screen.getByText('Loading tasks…')).toBeInTheDocument();
            first.resolve({ tasks });
        });

        it('keeps the tasks shown when a refresh fails', async () => {
            await openAndSettle();
            mockFetchTasks.mockImplementation(() =>
                Promise.reject(new Error('offline'))
            );

            fireEvent.focus(window);
            await waitFor(() => expect(mockFetchTasks).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 0));

            expect(screen.getByText('3 tasks')).toBeInTheDocument();
        });

        it('empties the tasks when the first fetch fails', async () => {
            const first = deferred<{ tasks: unknown[] }>();
            mockFetchTasks.mockImplementation(() => first.promise);
            renderPage();
            await screen.findByText('Project one');
            mockFetchTasks.mockImplementation(defaultFetchTasks);
            fireEvent.focus(window);
            await screen.findByText('3 tasks');

            first.reject(new Error('offline'));

            expect(await screen.findByText('0 tasks')).toBeInTheDocument();
        });
    });
});
