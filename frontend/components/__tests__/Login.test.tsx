import React from 'react';
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import Login from '../Login';

// A spy, so a test can check which translation key each string uses.
const mockT = jest.fn((key: string, fallback?: string) => fallback ?? key);
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: mockT }),
}));

// The page asks the API for the registration toggle, the OIDC providers
// and the auth methods; every answer here leaves password login on.
const okJson = (body: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
// An error status from the server or the service worker. The JSON body is
// there so a check that skipped the status would read it.
const failedJson = (status: number, body: unknown) =>
    Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });

type Answer = () => ReturnType<typeof okJson>;

// Answer the sign-in method lookups (and, when given, registration-status
// and current_user) with the given replies; anything else gets a 404.
const serve = (answers: {
    password: Answer;
    providers: Answer;
    registration?: Answer;
    currentUser?: Answer;
}) => {
    global.fetch = jest.fn((url: string) => {
        const path = String(url);
        if (path.includes('password-auth-status')) return answers.password();
        if (path.includes('oidc/providers')) return answers.providers();
        if (path.includes('registration-status') && answers.registration)
            return answers.registration();
        if (path.includes('current_user') && answers.currentUser)
            return answers.currentUser();
        return failedJson(404, {});
    }) as unknown as typeof fetch;
};

const renderLogin = () =>
    render(
        <MemoryRouter>
            <Login />
        </MemoryRouter>
    );

// Let every pending fetch and state update finish, so a test can check that
// something is not drawn.
const settle = () =>
    act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const NO_METHODS =
    'No authentication methods available. Please contact your administrator.';
const UNAVAILABLE =
    'Could not load the sign-in options. Check your connection and try again.';

describe('Login', () => {
    beforeEach(() => {
        mockT.mockClear();
        // jsdom has no matchMedia; the page reads it for the dark-mode default
        window.matchMedia = jest.fn().mockReturnValue({
            matches: false,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
        }) as unknown as typeof window.matchMedia;
        global.fetch = jest.fn((url: string) => {
            if (String(url).includes('registration-status'))
                return okJson({ enabled: true });
            if (String(url).includes('oidc/providers'))
                return okJson({ providers: [] });
            return okJson({ passwordAuthEnabled: true, enabled: true });
        }) as unknown as typeof fetch;
    });

    it('renders the password form exactly once', async () => {
        render(
            <MemoryRouter>
                <Login />
            </MemoryRouter>
        );
        await waitFor(() =>
            expect(screen.getAllByTestId('login-submit')).toHaveLength(1)
        );
        expect(screen.getAllByTestId('login-email')).toHaveLength(1);
        expect(screen.getAllByTestId('login-password')).toHaveLength(1);
        expect(screen.getAllByTestId('login-forgot-link')).toHaveLength(1);
    });

    it('asks for the sign-in methods with the session cookie', async () => {
        renderLogin();
        await screen.findByTestId('login-password');

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/password-auth-status'),
            { credentials: 'include' }
        );
        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/oidc/providers'),
            { credentials: 'include' }
        );
    });

    it('labels the password form and offers sign-up', async () => {
        renderLogin();

        expect(await screen.findByLabelText('Email')).toHaveAttribute(
            'type',
            'email'
        );
        expect(screen.getByLabelText('Password')).toHaveAttribute(
            'type',
            'password'
        );
        expect(screen.getByTestId('login-submit')).toHaveTextContent('Login');
        expect(screen.getByTestId('login-forgot-link')).toHaveTextContent(
            'Forgot your password?'
        );
        expect(
            await screen.findByRole('link', { name: 'Sign Up' })
        ).toBeInTheDocument();
        expect(screen.queryByText(NO_METHODS)).not.toBeInTheDocument();
        expect(screen.queryByText('Or continue with email')).toBeNull();
        // Every string on the page is looked up by a key, not only its
        // English fallback.
        expect(mockT.mock.calls.filter(([key]) => !key)).toEqual([]);
        expect(mockT).toHaveBeenCalledWith('auth.email', 'Email');
        expect(mockT).toHaveBeenCalledWith('auth.password', 'Password');
        expect(mockT).toHaveBeenCalledWith('auth.login', 'Login');
        expect(mockT).toHaveBeenCalledWith(
            'auth.forgot_password_link',
            'Forgot your password?'
        );
    });

    it('shows the SSO buttons above the password form when both are on', async () => {
        serve({
            password: () => okJson({ enabled: true }),
            providers: () =>
                okJson({ providers: [{ slug: 'pocketid', name: 'PocketID' }] }),
        });
        renderLogin();

        expect(await screen.findByTestId('oidc-pocketid')).toBeInTheDocument();
        expect(screen.getByText('Or continue with email')).toBeInTheDocument();
        expect(screen.getByTestId('login-password')).toBeInTheDocument();
    });

    it('says no sign-in method is set up when password is off and there are no providers', async () => {
        serve({
            password: () => okJson({ enabled: false }),
            providers: () => okJson({ providers: [] }),
        });
        renderLogin();

        expect(await screen.findByText(NO_METHODS)).toBeInTheDocument();
        expect(screen.queryByTestId('login-unavailable')).toBeNull();
        expect(screen.queryByTestId('login-password')).toBeNull();
    });

    it('keeps the password form when only the provider list cannot be read', async () => {
        serve({
            password: () => okJson({ enabled: true }),
            providers: () => failedJson(503, { offline: true }),
        });
        const consoleError = jest
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        renderLogin();

        expect(await screen.findByTestId('login-password')).toBeInTheDocument();
        expect(screen.queryByTestId('login-unavailable')).toBeNull();
        expect(screen.queryAllByTestId(/^oidc-/)).toHaveLength(0);
        expect(screen.queryByText('Or continue with email')).toBeNull();
        consoleError.mockRestore();
    });

    it.each([
        [
            'the password answer is an error status, even with a JSON body',
            () => failedJson(502, { enabled: true }),
            () => okJson({ providers: [] }),
        ],
        [
            'the password answer has no yes or no',
            () => okJson({}),
            () =>
                okJson({ providers: [{ slug: 'pocketid', name: 'PocketID' }] }),
        ],
        [
            'the password answer is an empty body',
            () => okJson(null),
            () =>
                okJson({ providers: [{ slug: 'pocketid', name: 'PocketID' }] }),
        ],
        [
            'password is off and the provider list cannot be read',
            () => okJson({ enabled: false }),
            () => failedJson(503, { offline: true }),
        ],
    ])(
        'shows the retry message when %s',
        async (_case, password, providers) => {
            serve({ password, providers });
            const consoleError = jest
                .spyOn(console, 'error')
                .mockImplementation(() => undefined);
            renderLogin();

            expect(
                await screen.findByTestId('login-unavailable')
            ).toBeInTheDocument();
            expect(screen.queryByTestId('login-password')).toBeNull();
            expect(screen.queryAllByTestId(/^oidc-/)).toHaveLength(0);
            consoleError.mockRestore();
        }
    );

    it('treats a provider list with an empty body as no providers', async () => {
        serve({
            password: () => okJson({ enabled: true }),
            providers: () => okJson(null),
        });
        renderLogin();

        expect(await screen.findByTestId('login-password')).toBeInTheDocument();
        expect(screen.queryAllByTestId(/^oidc-/)).toHaveLength(0);
    });

    it('hides the SSO buttons at the 2FA code prompt', async () => {
        serve({
            password: () => okJson({ enabled: true }),
            providers: () =>
                okJson({ providers: [{ slug: 'pocketid', name: 'PocketID' }] }),
            currentUser: () => okJson({ user: null, mfa_pending: true }),
        });
        renderLogin();

        expect(await screen.findByTestId('mfa-code')).toBeInTheDocument();
        await settle();
        expect(screen.queryByTestId('oidc-pocketid')).toBeNull();
    });

    it('asks for the 2FA code after the password, and signs in with it', async () => {
        global.fetch = jest.fn((url: string) => {
            const path = String(url);
            if (path.includes('login/mfa'))
                return okJson({ user: { email: 'a@example.com' } });
            if (path.endsWith('/login')) return okJson({ mfa_required: true });
            if (path.includes('oidc/providers'))
                return okJson({ providers: [] });
            return okJson({ enabled: true, user: null });
        }) as unknown as typeof fetch;
        const loggedIn = jest.fn();
        window.addEventListener('userLoggedIn', loggedIn);

        render(
            <MemoryRouter>
                <Login />
            </MemoryRouter>
        );
        fireEvent.change(await screen.findByTestId('login-email'), {
            target: { value: 'a@example.com' },
        });
        fireEvent.change(screen.getByTestId('login-password'), {
            target: { value: 'password123' },
        });
        fireEvent.click(screen.getByTestId('login-submit'));

        const code = await screen.findByTestId('mfa-code');
        expect(screen.queryByTestId('login-password')).not.toBeInTheDocument();
        fireEvent.change(code, { target: { value: '123456' } });
        fireEvent.click(screen.getByTestId('mfa-submit'));

        await waitFor(() => expect(loggedIn).toHaveBeenCalled());
        const mfaCall = (global.fetch as jest.Mock).mock.calls.find(([u]) =>
            String(u).includes('login/mfa')
        );
        expect(JSON.parse(mfaCall[1].body)).toEqual({ code: '123456' });
        window.removeEventListener('userLoggedIn', loggedIn);
    });

    it('picks up at the code prompt after a reload halfway through', async () => {
        global.fetch = jest.fn((url: string) => {
            if (String(url).includes('current_user'))
                return okJson({ user: null, mfa_pending: true });
            if (String(url).includes('oidc/providers'))
                return okJson({ providers: [] });
            return okJson({ enabled: true });
        }) as unknown as typeof fetch;

        render(
            <MemoryRouter>
                <Login />
            </MemoryRouter>
        );

        expect(await screen.findByTestId('mfa-code')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('mfa-toggle-recovery'));
        expect(screen.getByText('Recovery code')).toBeInTheDocument();
    });

    it('shows only the SSO button when password sign-in is off', async () => {
        global.fetch = jest.fn((url: string) => {
            if (String(url).includes('oidc/providers'))
                return okJson({
                    providers: [{ slug: 'pocketid', name: 'PocketID' }],
                });
            return okJson({ enabled: false });
        }) as unknown as typeof fetch;

        render(
            <MemoryRouter>
                <Login />
            </MemoryRouter>
        );

        expect(await screen.findByTestId('oidc-pocketid')).toBeInTheDocument();
        expect(screen.queryByTestId('login-password')).not.toBeInTheDocument();
    });

    it('does not fall back to the password form when the server cannot be read', async () => {
        const answers = { failing: true };
        // What a proxy sign-in page or a dropped connection looks like: a
        // body that is not JSON, or a 503 from the service worker.
        global.fetch = jest.fn((url: string) => {
            const path = String(url);
            if (answers.failing && path.includes('password-auth-status'))
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.reject(new SyntaxError('not JSON')),
                });
            if (answers.failing && path.includes('oidc/providers'))
                return Promise.resolve({
                    ok: false,
                    status: 503,
                    json: () => Promise.resolve({ offline: true }),
                });
            if (path.includes('oidc/providers'))
                return okJson({
                    providers: [{ slug: 'pocketid', name: 'PocketID' }],
                });
            // Registration is on: the sign-up link must still wait for the
            // sign-in methods.
            if (path.includes('registration-status'))
                return okJson({ enabled: true });
            return okJson({ enabled: false });
        }) as unknown as typeof fetch;
        const consoleError = jest
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        const lookupErrors = () =>
            consoleError.mock.calls.filter(
                ([message]) => message === 'Error loading sign-in methods:'
            );

        render(
            <MemoryRouter>
                <Login />
            </MemoryRouter>
        );

        expect(
            await screen.findByTestId('login-unavailable')
        ).toHaveTextContent(UNAVAILABLE);
        expect(screen.queryByTestId('login-password')).not.toBeInTheDocument();
        expect(screen.getByTestId('login-retry')).toHaveTextContent(
            'Try again'
        );
        expect(mockT).toHaveBeenCalledWith(
            'auth.sign_in_unavailable',
            UNAVAILABLE
        );
        expect(mockT).toHaveBeenCalledWith('common.retry', 'Try again');
        await settle();
        expect(screen.queryByRole('link', { name: 'Sign Up' })).toBeNull();
        expect(screen.queryByText(NO_METHODS)).toBeNull();
        // Each failed lookup is logged with its reason.
        expect(lookupErrors()).toHaveLength(2);
        expect(lookupErrors().map(([, reason]) => String(reason))).toEqual(
            expect.arrayContaining([
                'SyntaxError: not JSON',
                'Error: oidc/providers: 503',
            ])
        );

        answers.failing = false;
        fireEvent.click(screen.getByTestId('login-retry'));

        expect(await screen.findByTestId('oidc-pocketid')).toBeInTheDocument();
        expect(screen.queryByTestId('login-password')).not.toBeInTheDocument();
        expect(
            screen.queryByTestId('login-unavailable')
        ).not.toBeInTheDocument();
        // Lookups that worked are not logged.
        expect(lookupErrors()).toHaveLength(2);
        consoleError.mockRestore();
    });
});
