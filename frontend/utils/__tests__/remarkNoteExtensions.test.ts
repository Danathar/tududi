import {
    MdNode,
    WIKILINK_PREFIX,
    createRemarkTaskLines,
    remarkWikilinks,
} from '../remarkNoteExtensions';

const text = (value: string): MdNode => ({ type: 'text', value });

describe('remarkWikilinks', () => {
    const run = (tree: MdNode) => {
        remarkWikilinks()(tree);
        return tree;
    };

    it('turns [[Title]] in text into a wikilink node', () => {
        const tree = run({
            type: 'root',
            children: [
                {
                    type: 'paragraph',
                    children: [text('see [[Foo]] now')],
                },
            ],
        });
        expect(tree.children?.[0].children).toEqual([
            text('see '),
            {
                type: 'link',
                url: `${WIKILINK_PREFIX}Foo`,
                children: [text('Foo')],
            },
            text(' now'),
        ]);
    });

    it('keeps parentheses in the title out of the markdown syntax', () => {
        const tree = run({
            type: 'root',
            children: [
                { type: 'paragraph', children: [text('[[a)b]]')] },
            ],
        });
        const link = tree.children?.[0].children?.[0];
        expect(link?.type).toBe('link');
        expect(decodeURIComponent(link?.url ?? '')).toBe(
            `${WIKILINK_PREFIX}a)b`
        );
        expect(link?.children).toEqual([text('a)b')]);
    });

    it('leaves code, inline code and existing links alone', () => {
        const tree = run({
            type: 'root',
            children: [
                { type: 'code', value: '[[Foo]]' },
                {
                    type: 'paragraph',
                    children: [
                        { type: 'inlineCode', value: '[[Foo]]' },
                        {
                            type: 'link',
                            url: 'https://example.com',
                            children: [text('[[Foo]]')],
                        },
                    ],
                },
            ],
        });
        expect(tree.children?.[0].value).toBe('[[Foo]]');
        const para = tree.children?.[1].children;
        expect(para?.[0]).toEqual({ type: 'inlineCode', value: '[[Foo]]' });
        expect(para?.[1].children).toEqual([text('[[Foo]]')]);
    });
});

describe('createRemarkTaskLines', () => {
    it('records the source line of each drawn checkbox in document order', () => {
        const sink: number[] = [99];
        const item = (
            checked: boolean | null,
            line: number,
            children: MdNode[] = []
        ): MdNode => ({
            type: 'listItem',
            checked,
            position: { start: { line } },
            children,
        });
        const tree: MdNode = {
            type: 'root',
            children: [
                {
                    type: 'list',
                    children: [
                        // An empty "- [ ]" is not drawn as a checkbox.
                        item(null, 1),
                        item(false, 2, [
                            { type: 'list', children: [item(true, 3)] },
                        ]),
                        item(false, 4),
                    ],
                },
            ],
        };
        createRemarkTaskLines(sink)()(tree);
        expect(sink).toEqual([2, 3, 4]);
    });
});
