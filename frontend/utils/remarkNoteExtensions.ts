// Small remark plugins for the note renderer. They work on the parsed
// markdown tree, so they only ever see what the parser decided is real
// content: code stays code, and the checkboxes we count are the ones that
// are actually drawn.
//
// The tree types are declared here instead of imported so this file has no
// runtime or type dependency on the markdown packages.

export interface MdNode {
    type: string;
    value?: string;
    url?: string;
    checked?: boolean | null;
    position?: { start: { line: number } };
    children?: MdNode[];
}

export const WIKILINK_PREFIX = '/__wikilink__/';

const WIKILINK = /\[\[([^\][\n]+?)\]\]/g;

// Nodes whose text must stay as written. Links cannot hold another link.
const WIKILINK_SKIP = new Set([
    'code',
    'inlineCode',
    'html',
    'link',
    'linkReference',
    'definition',
]);

const splitWikilinks = (value: string): MdNode[] | null => {
    const out: MdNode[] = [];
    let last = 0;
    let found = false;
    for (const match of value.matchAll(WIKILINK)) {
        const title = match[1].trim();
        if (!title) continue;
        found = true;
        const start = match.index ?? 0;
        if (start > last) {
            out.push({ type: 'text', value: value.slice(last, start) });
        }
        out.push({
            type: 'link',
            url: `${WIKILINK_PREFIX}${encodeURIComponent(title)}`,
            children: [{ type: 'text', value: title }],
        });
        last = start + match[0].length;
    }
    if (!found) return null;
    if (last < value.length) {
        out.push({ type: 'text', value: value.slice(last) });
    }
    return out;
};

const rewriteWikilinks = (node: MdNode): void => {
    if (!node.children || WIKILINK_SKIP.has(node.type)) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
            const parts = splitWikilinks(child.value);
            if (parts) {
                next.push(...parts);
                continue;
            }
        }
        rewriteWikilinks(child);
        next.push(child);
    }
    node.children = next;
};

// Turns [[Title]] in text nodes into links to /__wikilink__/<Title>.
export const remarkWikilinks = () => (tree: MdNode) => {
    rewriteWikilinks(tree);
};

const collectTaskLines = (node: MdNode, lines: number[]): void => {
    if (
        node.type === 'listItem' &&
        typeof node.checked === 'boolean' &&
        node.position
    ) {
        lines.push(node.position.start.line);
    }
    if (node.children) {
        for (const child of node.children) collectTaskLines(child, lines);
    }
};

// Records the 1-based source line of every task list item the parser
// renders as a checkbox, in document order. The same array is refilled on
// each parse, so the Nth drawn checkbox maps to sink[N].
export const createRemarkTaskLines =
    (sink: number[]) => () => (tree: MdNode) => {
        sink.length = 0;
        collectTaskLines(tree, sink);
    };
