import fs from 'fs';
import path from 'path';

// Keys the UI reads without an inline fallback text. A locale that lacks one
// shows the raw key to its users.
const REQUIRED_KEYS = [
    'errors.failedToDeleteProject',
    'areas.toggleDropdownMenu',
    'notes.toggleDropdownMenu',
];

const localesDir = path.join(__dirname, '..', '..', 'public', 'locales');

const lookup = (data: any, key: string) =>
    key.split('.').reduce((node, part) => node?.[part], data);

describe('locale files', () => {
    const languages = fs
        .readdirSync(localesDir)
        .filter((entry) =>
            fs.existsSync(path.join(localesDir, entry, 'translation.json'))
        );

    it.each(languages)('%s has the keys the UI reads', (language) => {
        const data = JSON.parse(
            fs.readFileSync(
                path.join(localesDir, language, 'translation.json'),
                'utf8'
            )
        );
        for (const key of REQUIRED_KEYS) {
            expect(typeof lookup(data, key)).toBe('string');
        }
    });
});
