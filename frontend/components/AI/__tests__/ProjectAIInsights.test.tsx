import React, { createRef } from 'react';
import { render, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import ProjectAIInsights, { ProjectAIInsightsHandle } from '../ProjectAIInsights';
import {
    fetchCachedProjectInsights,
    fetchProjectInsights,
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
    fetchProjectInsights: jest.fn(),
    fetchCachedProjectInsights: jest.fn(),
    updateProjectInsightsDismissed: jest.fn().mockResolvedValue(undefined),
}));

const mockedFetchInsights = fetchProjectInsights as jest.Mock;
const mockedFetchCached = fetchCachedProjectInsights as jest.Mock;

describe('ProjectAIInsights', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedFetchCached.mockResolvedValue(null);
        mockedFetchInsights.mockResolvedValue({
            insights: [],
            generated_at: new Date().toISOString(),
        });
    });

    it('sends the area of a project shaped like the API response', async () => {
        const ref = createRef<ProjectAIInsightsHandle>();
        // The API serialises the association as "Area" (capitalised).
        const project: any = {
            uid: 'p1',
            name: 'Kitchen',
            Area: { uid: 'a1', name: 'Home' },
        };

        render(<ProjectAIInsights ref={ref} project={project} />);
        await waitFor(() => expect(mockedFetchCached).toHaveBeenCalled());
        // Let the cache lookup settle before the panel is activated.
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            ref.current?.activate();
        });

        await waitFor(() => expect(mockedFetchInsights).toHaveBeenCalledTimes(1));
        expect(mockedFetchInsights.mock.calls[0][0]).toMatchObject({
            projectUid: 'p1',
            projectArea: 'Home',
        });
    });
});
