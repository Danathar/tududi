#!/usr/bin/env node
// PreToolUse hook for Claude Code's Bash tool (wired up in .claude/settings.json).
//
// Why: this repository is a fork (Danathar/tududi) of chrisvel/tududi. A bare
// `gh pr create` in a fork targets the upstream parent, so an agent can open
// PRs or issues on someone else's project by accident. AGENTS.md ("This
// repository is a fork. All work happens here.") forbids that; this hook makes
// the rule mechanical instead of relying on the model remembering it.
//
// Protocol (https://docs.anthropic.com/en/docs/claude-code/hooks): the hook
// receives JSON on stdin ({ tool_name, tool_input: { command } }). Exit 0 lets
// the call proceed; exit 2 blocks it and feeds stderr back to the model.
//
// What is blocked (fail closed when unsure):
//   - gh pr|issue|release|workflow|run|label|repo|secret|variable|ruleset|cache
//     subcommands that are not read-only and do not target Danathar/tududi
//     via --repo/-R or a GH_REPO= prefix; any such command whose target is
//     chrisvel/tududi.
//   - gh api with a mutating method (or -f/-F/--input body) against anything
//     outside repos/Danathar/tududi; GraphQL mutations.
//   - git push with force, --mirror, a remote other than `origin`, a URL
//     remote, or no explicit remote.
//   - git remote set-url that points a push URL at a real upstream.
//
// Read-only gh commands (view, list, status, diff, checks, api GET, ...) are
// always allowed. The command is split into segments on && || ; | & newlines,
// subshells and command substitutions; shell -c / eval strings are analysed
// recursively. Quoted text is data, so a quoted "chrisvel/tududi" inside a
// read-only command or an `echo` is fine.

import { basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FORK = 'danathar/tududi';
export const UPSTREAM = 'chrisvel/tududi';

const GUIDANCE =
    'This repository is a fork: PRs/issues/releases go to Danathar/tududi, ' +
    'never chrisvel/tududi (see AGENTS.md, "This repository is a fork. All ' +
    'work happens here."). Add `--repo Danathar/tududi`, and push only to ' +
    '`origin`.';

// gh command groups whose non-read actions mutate a repository.
// Value = actions that are read-only (or purely local) and need no --repo.
const GH_GROUPS = {
    pr: ['view', 'list', 'status', 'diff', 'checks', 'checkout'],
    issue: ['view', 'list', 'status'],
    release: ['view', 'list', 'download', 'verify', 'verify-asset'],
    workflow: ['view', 'list'],
    run: ['view', 'list', 'watch', 'download'],
    label: ['list'],
    repo: ['view', 'list', 'clone', 'gitignore', 'license'],
    secret: ['list'],
    variable: ['list', 'get'],
    ruleset: ['list', 'view', 'check'],
    cache: ['list'],
};

// Words that may precede the real command and carry no meaning for us.
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time']);
// Wrappers that run another command; we look through them for gh/git/shells.
const WRAPPERS = new Set([
    'env', 'command', 'builtin', 'exec', 'nohup', 'sudo', 'nice', 'xargs',
    'timeout', 'setsid', 'stdbuf', 'ionice', 'chronic',
]);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split a shell command line into segments of words.
 * Quotes and backslashes are resolved; operators and parentheses end a segment;
 * heredoc bodies are skipped. This is a deliberately small approximation of
 * shell parsing, good enough to find command names and their flags.
 */
export function tokenize(input) {
    const segments = [];
    let words = [];
    let word = null; // null = no word in progress ('' = empty quoted word)
    const pendingHeredocs = [];

    const endWord = () => {
        if (word !== null) words.push(word);
        word = null;
    };
    const endSegment = () => {
        endWord();
        if (words.length) segments.push(words);
        words = [];
    };
    const append = (ch) => {
        word = (word ?? '') + ch;
    };

    let i = 0;
    while (i < input.length) {
        const c = input[i];

        if (c === "'") {
            const end = input.indexOf("'", i + 1);
            const stop = end === -1 ? input.length : end;
            append(input.slice(i + 1, stop));
            i = stop + 1;
        } else if (c === '"') {
            i++;
            append('');
            while (i < input.length && input[i] !== '"') {
                if (input[i] === '\\' && i + 1 < input.length) {
                    const next = input[i + 1];
                    if ('"\\$`'.includes(next)) i++;
                    else if (next === '\n') {
                        i += 2;
                        continue;
                    }
                }
                append(input[i]);
                i++;
            }
            i++;
        } else if (c === '\\') {
            if (input[i + 1] === '\n') {
                i += 2; // line continuation
            } else {
                append(input[i + 1] ?? '');
                i += 2;
            }
        } else if (c === '#' && word === null) {
            while (i < input.length && input[i] !== '\n') i++; // comment
        } else if (c === '\n') {
            endSegment();
            i++;
            // Skip the bodies of heredocs started on the line that just ended.
            while (pendingHeredocs.length) {
                const delim = pendingHeredocs.shift();
                while (i < input.length) {
                    let eol = input.indexOf('\n', i);
                    if (eol === -1) eol = input.length;
                    const line = input.slice(i, eol).replace(/^\t+/, '');
                    i = eol + 1;
                    if (line === delim) break;
                }
            }
        } else if (c === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
            i += 2;
            if (input[i] === '-') i++;
            while (input[i] === ' ' || input[i] === '\t') i++;
            let delim = '';
            let quote = null;
            while (i < input.length) {
                const d = input[i];
                if (quote) {
                    if (d === quote) quote = null;
                    else delim += d;
                } else if (d === "'" || d === '"') quote = d;
                else if (/[\s;&|()<>]/.test(d)) break;
                else delim += d;
                i++;
            }
            endWord();
            if (delim) pendingHeredocs.push(delim);
        } else if (c === ' ' || c === '\t') {
            endWord();
            i++;
        } else if (c === '&' || c === '|' || c === ';' || c === '(' || c === ')') {
            endSegment();
            i++;
        } else if (c === '`') {
            endSegment(); // substitution contents are analysed separately
            i++;
        } else if (c === '$' && input[i + 1] === '(') {
            endSegment();
            i += 2;
        } else {
            append(c);
            i++;
        }
    }
    endSegment();
    return segments;
}

/**
 * Find the bodies of $(...) and `...` substitutions, including ones inside
 * double quotes (but not single quotes), so they can be analysed as commands.
 */
export function extractSubstitutions(input) {
    const found = [];
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (c === '\\' && !inSingle) {
            i++;
        } else if (c === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (c === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (!inSingle && c === '$' && input[i + 1] === '(') {
            let depth = 1;
            let j = i + 2;
            for (; j < input.length && depth > 0; j++) {
                if (input[j] === '(') depth++;
                else if (input[j] === ')') depth--;
            }
            found.push(input.slice(i + 2, j - 1));
        } else if (!inSingle && c === '`') {
            const end = input.indexOf('`', i + 1);
            const stop = end === -1 ? input.length : end;
            found.push(input.slice(i + 1, stop));
            i = stop;
        }
    }
    return found;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);

/** Normalise OWNER/REPO, HOST/OWNER/REPO, or a github URL to "owner/repo". */
export function normalizeRepo(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/^(?:https?:\/\/|git@|ssh:\/\/git@)?github\.com[/:]/, '')
        .replace(/\.git$/, '')
        .replace(/\/+$/, '');
}

/** True if a word is (a URL for) chrisvel/tududi, optionally with a suffix path. */
export function namesUpstream(word) {
    const w = String(word).toLowerCase();
    return new RegExp(
        `^(?:(?:https?://|git@|ssh://git@)?github\\.com[/:])?${UPSTREAM}(?:\\.git)?(?:/.*)?$`
    ).test(w);
}

function isFork(value) {
    return normalizeRepo(value) === FORK;
}

/** Extract the --repo/-R value from gh args, or null. */
function repoFlag(args) {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--repo' || a === '-R') return args[i + 1] ?? '';
        if (a.startsWith('--repo=')) return a.slice(7);
        if (a.startsWith('-R') && a.length > 2 && !a.startsWith('--')) return a.slice(2);
    }
    return null;
}

const block = (reason) => ({ blocked: true, reason: `${reason}\n${GUIDANCE}` });

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

function checkGhApi(args) {
    let method = null;
    let hasBody = false;
    const positionals = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-X' || a === '--method') method = (args[++i] ?? '').toUpperCase();
        else if (a.startsWith('--method=')) method = a.slice(9).toUpperCase();
        else if (/^-X./.test(a)) method = a.slice(2).toUpperCase();
        else if (['-f', '-F', '--field', '--raw-field', '--input'].includes(a)) {
            hasBody = true;
            i++;
        } else if (/^--(field|raw-field|input)=/.test(a) || /^-[fF]./.test(a)) hasBody = true;
        else if (['-H', '--header', '--hostname', '-q', '--jq', '-t', '--template', '--cache'].includes(a)) i++;
        else if (!a.startsWith('-')) positionals.push(a);
    }
    const endpoint = (positionals[0] ?? '').replace(/^\/+/, '');
    const mutating = method ? !['GET', 'HEAD'].includes(method) : hasBody;
    const isGraphql = endpoint.toLowerCase() === 'graphql';

    if (isGraphql) {
        // GraphQL is always POST; allow queries, refuse mutations (target unknowable).
        if (args.some((a) => /\bmutation\b/i.test(a))) {
            return block('Blocked: `gh api graphql` mutation. The target repository cannot be verified.');
        }
        return null;
    }
    if (!mutating) return null;

    // `{owner}/{repo}` placeholders resolve to gh's default repo, which may be upstream.
    const m = /^repos\/([^/]+\/[^/?#]+)(?:[/?#]|$)/i.exec(endpoint);
    if (m && m[1].toLowerCase() === FORK) return null;

    return block(
        `Blocked: mutating \`gh api\` call (${method ?? 'implicit POST'}) to "${endpoint || '?'}"; ` +
            'only paths under repos/Danathar/tududi are allowed.'
    );
}

function checkGh(args, envRepo) {
    // Locate group and action (first two non-flag words).
    const plain = args.filter((a) => !a.startsWith('-'));
    const group = plain[0];
    if (!group) return null;

    if (group === 'api') return checkGhApi(args.slice(args.indexOf('api') + 1));
    if (!Object.hasOwn(GH_GROUPS, group)) return null; // auth, config, browse, search, ...

    const action = plain[1] ?? '';
    const flagRepo = repoFlag(args);
    const target = flagRepo ?? envRepo;

    // Reads against upstream are harmless; anything else aimed at it is refused.
    if (target !== null && namesUpstream(target) && !GH_GROUPS[group].includes(action)) {
        return block(`Blocked: \`gh ${group} ${action}\` targets ${UPSTREAM}.`);
    }

    if (group === 'repo' && action === 'set-default') {
        const rest = plain.slice(2);
        if (args.includes('--view') || args.includes('-v')) return null;
        if (rest.length === 1 && isFork(rest[0])) return null;
        return block('Blocked: `gh repo set-default` must be `gh repo set-default Danathar/tududi` (or --view).');
    }

    if (GH_GROUPS[group].includes(action)) return null; // read-only

    // A write that names upstream anywhere (e.g. `gh repo sync chrisvel/tududi`,
    // `gh pr merge <upstream PR URL>`) is refused even if --repo points at the fork.
    if (args.some(namesUpstream)) {
        return block(`Blocked: \`gh ${group} ${action}\` names ${UPSTREAM}.`);
    }

    if (group === 'repo') {
        // Repo-scoped writes take the repo as a positional argument.
        const positional = plain.slice(2);
        if (isFork(flagRepo ?? '') || (positional.length && isFork(positional[0])) || isFork(envRepo ?? '')) return null;
        return block(`Blocked: \`gh repo ${action}\` without an explicit Danathar/tududi target.`);
    }

    if (target === null) {
        return block(`Blocked: \`gh ${group} ${action}\` has no --repo/-R/GH_REPO; gh would default to the upstream parent.`);
    }
    if (!isFork(target)) {
        return block(`Blocked: \`gh ${group} ${action}\` targets "${target}", not Danathar/tududi.`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function checkGit(args) {
    // Skip global options to find the subcommand.
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);

    if (sub === 'push') return checkGitPush(rest);
    if (sub === 'remote') return checkGitRemote(rest);
    return null;
}

function checkGitPush(rest) {
    const positionals = [];
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (['-o', '--push-option', '--receive-pack', '--exec'].includes(a)) i++;
        else if (a === '--repo' || a.startsWith('--repo=')) {
            return block('Blocked: `git push --repo` redirects the push; name the remote `origin` instead.');
        } else if (a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes') {
            return block('Blocked: force push.');
        } else if (a === '--mirror') {
            return block('Blocked: `git push --mirror` overwrites the remote.');
        } else if (/^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) {
            return block('Blocked: force push (-f).');
        } else if (!a.startsWith('-')) positionals.push(a);
    }
    const [remote, ...refspecs] = positionals;
    if (remote === undefined) {
        return block('Blocked: `git push` without an explicit remote; use `git push origin <branch>`.');
    }
    if (remote !== 'origin') {
        return block(`Blocked: \`git push ${remote}\`; only the \`origin\` remote may be pushed to.`);
    }
    if (refspecs.some((r) => r.startsWith('+'))) {
        return block('Blocked: force push via "+" refspec.');
    }
    return null;
}

function checkGitRemote(rest) {
    const isSetUrl = rest[0] === 'set-url';
    if (!isSetUrl) return null;
    const flags = rest.slice(1).filter((a) => a.startsWith('-'));
    const plain = rest.slice(1).filter((a) => !a.startsWith('-'));
    const [name, url] = plain;
    const push = flags.includes('--push');
    if (url === undefined) return null;
    if (push && url !== 'DISABLE' && !(name === 'origin' && isFork(url))) {
        return block(
            `Blocked: \`git remote set-url --push ${name}\` to a real URL. ` +
                'Use `DISABLE` for upstream, or the Danathar/tududi URL for origin.'
        );
    }
    if (name === 'origin' && namesUpstream(url)) {
        return block('Blocked: pointing `origin` at chrisvel/tududi.');
    }
    return null;
}

// ---------------------------------------------------------------------------
// Segment / command analysis
// ---------------------------------------------------------------------------

function checkSegment(words, state) {
    let w = words.slice();
    const inlineEnv = {};
    for (;;) {
        while (w.length && (isAssignment(w[0]) || KEYWORDS.has(w[0]))) {
            if (isAssignment(w[0])) {
                const eq = w[0].indexOf('=');
                inlineEnv[w[0].slice(0, eq)] = w[0].slice(eq + 1);
            }
            w.shift();
        }
        if (!w.length) return null;
        const cmd = basename(w[0]);
        if (!WRAPPERS.has(cmd)) break;
        // Look through the wrapper for the real command.
        const idx = w.findIndex((x, n) => n > 0 && ['gh', 'git', ...SHELLS, 'eval'].includes(basename(x)));
        for (const x of w.slice(1, idx === -1 ? w.length : idx)) {
            if (isAssignment(x)) {
                const eq = x.indexOf('=');
                inlineEnv[x.slice(0, eq)] = x.slice(eq + 1);
            }
        }
        if (idx === -1) return null;
        w = w.slice(idx);
    }

    const cmd = basename(w[0]);
    const args = w.slice(1);

    if (cmd === 'export') {
        for (const a of args) {
            if (a.startsWith('GH_REPO=')) state.exportedGhRepo = a.slice(8);
        }
        return null;
    }
    if (cmd === 'gh') {
        const envRepo = inlineEnv.GH_REPO ?? state.exportedGhRepo ?? null;
        return checkGh(args, envRepo);
    }
    if (cmd === 'git') return checkGit(args);
    if (SHELLS.has(cmd)) {
        const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        if (c !== -1 && args[c + 1] !== undefined) return checkCommand(args[c + 1], state);
        return null;
    }
    if (cmd === 'eval') return checkCommand(args.join(' '), state);
    return null;
}

/** Analyse a command line. Returns null if allowed, else { blocked, reason }. */
export function checkCommand(command, state = {}) {
    for (const sub of extractSubstitutions(command)) {
        const r = checkCommand(sub, state);
        if (r) return r;
    }
    for (const words of tokenize(command)) {
        const r = checkSegment(words, state);
        if (r) return r;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
    let payload;
    try {
        payload = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
        process.stderr.write('guard-bash: could not parse hook input as JSON; blocking (fail closed).\n');
        process.exit(2);
    }
    if (payload?.tool_name && payload.tool_name !== 'Bash') process.exit(0);
    const command = payload?.tool_input?.command;
    if (typeof command !== 'string' || !command.trim()) process.exit(0);

    const result = checkCommand(command);
    if (result) {
        process.stderr.write(`guard-bash: ${result.reason}\n`);
        process.exit(2);
    }
    process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
