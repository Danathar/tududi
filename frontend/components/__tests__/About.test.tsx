import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import About from '../About';

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, fallback?: string) => fallback ?? key,
    }),
}));

jest.mock('../../utils/featureFlags', () => ({
    getFeatureFlags: jest.fn().mockResolvedValue({
        hosted: false,
        billing: false,
    }),
}));

const mockVersionResponse = (body: unknown) => {
    (global as any).fetch = jest.fn().mockResolvedValue({
        json: () => Promise.resolve(body),
    });
};

const renderAbout = () =>
    render(
        <MemoryRouter>
            <About />
        </MemoryRouter>
    );

describe('About', () => {
    const originalFetch = (global as any).fetch;

    afterEach(() => {
        (global as any).fetch = originalFetch;
    });

    it('shows the version, the build tag as a commit link, and the date', async () => {
        mockVersionResponse({
            version: 'v1.9.1',
            build: {
                tag: 'v1.9.1-518b8ff',
                url: 'https://github.com/Danathar/tududi/commit/518b8ff0a1b2c3d4e5f60718293a4b5c6d7e8f90',
                date: '2026-10-11T08:00:00+00:00',
            },
        });

        renderAbout();

        expect(await screen.findByText(/v1\.9\.1$/)).toBeInTheDocument();
        const link = await screen.findByRole('link', {
            name: 'v1.9.1-518b8ff',
        });
        expect(link).toHaveAttribute(
            'href',
            'https://github.com/Danathar/tududi/commit/518b8ff0a1b2c3d4e5f60718293a4b5c6d7e8f90'
        );
        expect(screen.getByText(/2026-10-11/)).toBeInTheDocument();
    });

    it('shows only the version line when there is no build', async () => {
        mockVersionResponse({ version: 'v1.9.1', build: null });

        renderAbout();

        expect(await screen.findByText(/v1\.9\.1$/)).toBeInTheDocument();
        await waitFor(() => expect((global as any).fetch).toHaveBeenCalled());
        expect(screen.queryByText(/^Build/)).not.toBeInTheDocument();
        expect(screen.queryByText(/null|undefined/)).not.toBeInTheDocument();
    });
});
