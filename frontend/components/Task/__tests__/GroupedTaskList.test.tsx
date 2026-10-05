import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import GroupedTaskList from '../GroupedTaskList';
import { Task } from '../../../entities/Task';

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key: string, fallback?: string) => fallback ?? _key,
    }),
}));

jest.mock('../TaskItem', () => ({
    __esModule: true,
    default: ({ task }: { task: Task }) => <div>{task.name}</div>,
}));

const makeTask = (overrides: Partial<Task>): Task =>
    ({
        id: 1,
        uid: 'uid-1',
        name: 'Task',
        status: 'not_started',
        priority: 'low',
        ...overrides,
    }) as Task;

describe('GroupedTaskList', () => {
    it('excludes cancelled tasks from the standalone list when showCompletedTasks is false', () => {
        const tasks = [
            makeTask({ id: 1, name: 'Active task', status: 'not_started' }),
            makeTask({ id: 2, name: 'Cancelled task', status: 'cancelled' }),
        ];

        render(
            <GroupedTaskList
                tasks={tasks}
                onTaskUpdate={jest.fn()}
                onTaskDelete={jest.fn()}
                projects={[]}
                showCompletedTasks={false}
            />
        );

        expect(screen.getByText('Active task')).toBeInTheDocument();
        expect(screen.queryByText('Cancelled task')).not.toBeInTheDocument();
    });

    it('excludes cancelled tasks when grouped by project', () => {
        const tasks = [
            makeTask({
                id: 1,
                name: 'Active task',
                status: 'not_started',
                project_id: 5,
            }),
            makeTask({
                id: 2,
                name: 'Cancelled task',
                status: 'cancelled',
                project_id: 5,
            }),
        ];

        render(
            <GroupedTaskList
                tasks={tasks}
                groupBy="project"
                onTaskUpdate={jest.fn()}
                onTaskDelete={jest.fn()}
                projects={[]}
                showCompletedTasks={false}
            />
        );

        expect(screen.getByText('Active task')).toBeInTheDocument();
        expect(screen.queryByText('Cancelled task')).not.toBeInTheDocument();
    });

    it('groups by effective area: own area, else project area, else No area first', () => {
        const tasks = [
            makeTask({
                id: 1,
                name: 'Home task',
                Area: { id: 1, name: 'Home' } as Task['Area'],
            }),
            makeTask({
                id: 2,
                name: 'Website task',
                Project: {
                    id: 9,
                    name: 'Website',
                    Area: { id: 2, name: 'Work' },
                } as Task['Project'],
            }),
            makeTask({ id: 3, name: 'Loose task' }),
            makeTask({
                id: 4,
                name: 'Own area wins',
                Area: { id: 1, name: 'Home' } as Task['Area'],
                Project: {
                    id: 9,
                    name: 'Website',
                    Area: { id: 2, name: 'Work' },
                } as Task['Project'],
            }),
        ];

        render(
            <GroupedTaskList
                tasks={tasks}
                groupBy="area"
                onTaskUpdate={jest.fn()}
                onTaskDelete={jest.fn()}
                projects={[]}
            />
        );

        const headers = screen
            .getAllByText(/^\d+ tasks$/)
            .map((el) => el.previousElementSibling?.textContent);
        expect(headers).toEqual(['No area', 'Home', 'Work']);
        expect(screen.getByText('2 tasks')).toBeInTheDocument();
    });
});
