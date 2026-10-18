const {
    processInboxItem,
    containsUrl,
} = require('../../../modules/inbox/inboxProcessingService');

describe('inboxProcessingService', () => {
    describe('processInboxItem', () => {
        it('should detect URL without project and set reason to url_detected', () => {
            const content = 'https://example.com/page #tag1 #tag2';
            const result = processInboxItem(content);

            expect(result).toMatchObject({
                parsed_tags: ['tag1', 'tag2'],
                parsed_projects: [],
                cleaned_content: 'https://example.com/page',
                suggested_type: null,
                suggested_reason: 'url_detected',
            });
        });

        it('should detect URL with project and suggest note', () => {
            const content = 'https://example.com/page +Project #tag1';
            const result = processInboxItem(content);

            expect(result).toMatchObject({
                parsed_tags: ['tag1'],
                parsed_projects: ['Project'],
                cleaned_content: 'https://example.com/page',
                suggested_type: 'note',
                suggested_reason: 'url_detected',
            });
        });

        it('should handle URL without tags or projects', () => {
            const content = 'https://example.com/test-page';
            const result = processInboxItem(content);

            expect(result).toMatchObject({
                parsed_tags: [],
                parsed_projects: [],
                cleaned_content: 'https://example.com/test-page',
                suggested_type: null,
                suggested_reason: 'url_detected',
            });
        });

        it('should not set url_detected reason for non-URL content', () => {
            const content = 'Just some regular text #tag1';
            const result = processInboxItem(content);

            expect(result).toMatchObject({
                parsed_tags: ['tag1'],
                parsed_projects: [],
                cleaned_content: 'Just some regular text',
                suggested_type: null,
                suggested_reason: null,
            });
        });

        it('should not truncate long cleaned_content', () => {
            const longText =
                'This task has a long name, very long name, with lots of stuff';
            const content = `${longText} #tag1 +Project`;
            const result = processInboxItem(content);

            expect(result.parsed_tags).toEqual(['tag1']);
            expect(result.parsed_projects).toEqual(['Project']);
            expect(result.cleaned_content).toBe(longText);
            expect(result.cleaned_content.length).toBe(longText.length);
        });
    });

    describe('multi-line and non-ASCII tokens', () => {
        it('cuts a #tag on a new line from the title', () => {
            const result = processInboxItem('buy milk\n#groceries');

            expect(result.parsed_tags).toEqual(['groceries']);
            expect(result.cleaned_content).toBe('buy milk');
        });

        it('detects a +Project on a new line', () => {
            const result = processInboxItem('buy milk\n+Home');

            expect(result.parsed_projects).toEqual(['Home']);
            expect(result.cleaned_content).toBe('buy milk');
        });

        it('accepts letters from any script in a #tag', () => {
            const result = processInboxItem('call #café +Écoles');

            expect(result.parsed_tags).toEqual(['café']);
            expect(result.parsed_projects).toEqual(['Écoles']);
            expect(result.cleaned_content).toBe('call');
        });

        it('keeps a #word that cannot be a tag in the title', () => {
            const result = processInboxItem('call #urgent,home please');

            expect(result.parsed_tags).toEqual([]);
            expect(result.cleaned_content).toBe('call #urgent,home please');
        });
    });

    describe('containsUrl', () => {
        it('should detect URLs in text with hashtags', () => {
            expect(containsUrl('https://example.com/page #tag1')).toBe(true);
        });

        it('should detect URLs at the start of text', () => {
            expect(containsUrl('https://example.com')).toBe(true);
        });

        it('should detect http URLs', () => {
            expect(containsUrl('http://example.com/path')).toBe(true);
        });

        it('should return false for non-URL text', () => {
            expect(containsUrl('just some text')).toBe(false);
        });
    });
});
