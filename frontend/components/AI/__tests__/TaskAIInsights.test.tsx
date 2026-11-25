import React, { createRef } from 'react';
import { render, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import TaskAIInsights, { TaskAIInsightsHandle } from '../TaskAIInsights';
import {
    fetchCachedTaskInsights,
    fetchTaskInsights,
} from '../../../utils/aiAssistantService';

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key: string, fallback?: any) =>
            typeof fallback === 'string' ? fallback : _key,
    }),
}));

jest.mock('../../../hooks/useTrialStatus', () => ({
    useTrialLock: () => false,
}));

jest.mock('../../../utils/aiAssistantService', () => ({
    fetchTaskInsights: jest.fn(),
    fetchCachedTaskInsights: jest.fn(),
    updateTaskInsightsDismissed: jest.fn().mockResolvedValue(undefined),
}));

const mockedFetchInsights = fetchTaskInsights as jest.Mock;
const mockedFetchCached = fetchCachedTaskInsights as jest.Mock;

describe('TaskAIInsights', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedFetchCached.mockResolvedValue(null);
        mockedFetchInsights.mockResolvedValue({
            insights: [],
            generated_at: new Date().toISOString(),
        });
    });

    it("sends the project's goal and area when the project is shaped like the API response", async () => {
        const ref = createRef<TaskAIInsightsHandle>();
        // The API serialises the associations as "Goal" and "Area" (capitalised).
        const project: any = {
            uid: 'p1',
            name: 'Kitchen',
            Goal: { uid: 'g1', title: 'Renovate the house' },
            Area: { uid: 'a1', name: 'Home' },
        };
        const task: any = { uid: 't1', name: 'Pick tiles', status: 0 };

        render(<TaskAIInsights ref={ref} task={task} project={project} />);
        await waitFor(() => expect(mockedFetchCached).toHaveBeenCalled());
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            ref.current?.activate();
        });

        await waitFor(() => expect(mockedFetchInsights).toHaveBeenCalledTimes(1));
        expect(mockedFetchInsights.mock.calls[0][0]).toMatchObject({
            taskUid: 't1',
            projectGoal: 'Renovate the house',
            projectArea: 'Home',
        });
    });
});
