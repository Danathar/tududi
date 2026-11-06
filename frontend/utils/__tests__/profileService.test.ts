import { shouldAutoStartPolling } from '../profileService';

describe('shouldAutoStartPolling', () => {
    it('starts a wanted bot that this process can poll but does not yet', () => {
        expect(
            shouldAutoStartPolling({
                running: false,
                wanted: true,
                pollingHere: true,
            })
        ).toBe(true);
    });

    it('never undoes a stop the user asked for', () => {
        expect(
            shouldAutoStartPolling({
                running: false,
                wanted: false,
                pollingHere: true,
            })
        ).toBe(false);
    });

    it('leaves a bot alone when it is already running', () => {
        expect(
            shouldAutoStartPolling({
                running: true,
                wanted: true,
                pollingHere: true,
            })
        ).toBe(false);
    });

    it('leaves a wanted bot to the rescan on a process that does not poll', () => {
        expect(
            shouldAutoStartPolling({
                running: false,
                wanted: true,
                pollingHere: false,
            })
        ).toBe(false);
    });

    it('does nothing without a status', () => {
        expect(shouldAutoStartPolling(null)).toBe(false);
        expect(shouldAutoStartPolling(undefined)).toBe(false);
    });
});
