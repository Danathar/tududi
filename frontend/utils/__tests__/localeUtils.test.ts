import { setUserTimezone } from '../dateUtils';
import { resolveUserLocale } from '../localeUtils';

describe('resolveUserLocale', () => {
    afterEach(() => {
        setUserTimezone('UTC');
    });

    it('maps the app code jp to the ja language', () => {
        setUserTimezone('Asia/Tokyo');
        expect(resolveUserLocale('jp')).toBe('ja-JP');
    });

    it('maps the app code ua to the uk language', () => {
        // No country is known for this timezone, so the bare language is used.
        setUserTimezone('UTC');
        expect(resolveUserLocale('ua')).toBe('uk');
    });

    it('keeps combining other languages with the timezone region', () => {
        setUserTimezone('Europe/Athens');
        expect(resolveUserLocale('en')).toBe('en-GR');
    });
});
