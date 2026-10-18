// The app can be served from a sub-path (TUDUDI_BASE_PATH or
// window.__TUDUDI_BASE_PATH__). The base path is read when config/paths is
// first loaded, so each test resets the module registry first.
describe('taskEventService under a sub-path deployment', () => {
    afterEach(() => {
        delete (window as any).__TUDUDI_BASE_PATH__;
        jest.resetModules();
    });

    it('requests the API below the base path', async () => {
        (window as any).__TUDUDI_BASE_PATH__ = '/tududi';
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [],
        });
        (global as any).fetch = fetchMock;

        jest.resetModules();
        const { getTaskTimeline } = await import('../taskEventService');
        await getTaskTimeline('abc');

        expect(fetchMock).toHaveBeenCalledWith(
            '/tududi/api/task/abc/timeline',
            expect.anything()
        );
    });

    it('requests /api without a base path', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [],
        });
        (global as any).fetch = fetchMock;

        jest.resetModules();
        const { getTaskTimeline } = await import('../taskEventService');
        await getTaskTimeline('abc');

        expect(fetchMock).toHaveBeenCalledWith(
            '/api/task/abc/timeline',
            expect.anything()
        );
    });
});
