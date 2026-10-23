#!/usr/bin/env node
// PreToolUse hook for Claude Code's Bash tool (wired up in .claude/settings.json).
//
// Threat model: this hook prevents an agent that is following instructions
// from carelessly or accidentally targeting upstream (chrisvel/tududi) or
// running destructive commands. It is NOT a sandbox against deliberate
// obfuscation (eval of built strings, shell variables, scripts written to disk
// and executed, aliases, ...). The real boundaries are token scope (this
// fork's tokens and GitHub App cannot write to chrisvel/tududi) and Hive's
// proxy; findings that need deliberate obfuscation are out of scope here.
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
//   - gh pr|issue|discussion|release|workflow|run|label|repo|secret|variable|
//     ruleset|cache
//     subcommands that are not read-only and do not target Danathar/tududi
//     via --repo/-R or a GH_REPO= prefix; any such command whose target is
//     chrisvel/tududi.
//   - gh api with a mutating method (or -f/-F/--input body) against anything
//     outside repos/Danathar/tududi; GraphQL mutations.
//   - git push with force, --mirror, a remote other than `origin`, a URL
//     remote, or no explicit remote.
//   - git remote set-url that points a push URL at a real upstream.
//
// It also keeps the commands that .claude/settings.json auto-approves
// (`node --test`, `npm test` / `npm run *test*`, `git status|diff|log|show|
// branch`) from being turned into arbitrary code execution or arbitrary file
// writes, which would walk past the `Read(.env*)` deny rules and the `ask`/`deny`
// rules on the files that bound agents (#65, #69). Blocked:
//   - NODE_OPTIONS, npm_config_*, LD_PRELOAD, BASH_ENV and similar code-loading
//     variables, set inline, through `env`, or with export/declare -x.
//   - node code-loading flags (-e/-p/-r, --eval, --print, --require, --import,
//     --loader, --env-file, ...); under `node --test` only an allowlist of
//     test-runner flags and in-repo relative file patterns.
//   - npm --node-options, --script-shell, --prefix, --userconfig, ...; arguments
//     forwarded to a test script pass only a jest allowlist.
//   - git file-writing or file-reading options on any subcommand other than
//     push/remote/config (--output*, --no-index, --orderfile/-O, format-patch
//     -o, ...), GIT_* environment other than identity/locking variables, pagers
//     and editors other than cat/true, and `-c`/config writes of keys that run
//     programs (core.pager, core.fsmonitor, diff.*, alias.*, include.*, ...).
//   - git, node, npm or a shell run through xargs: xargs appends words read at
//     run time (`printf '%s\n' --output=FILE | xargs git log`), so none of the
//     argument checks here could see them.
//   - git, gh, node, npm or a shell anywhere behind flock, watch, taskset,
//     chrt, unshare or find (-exec/-execdir/-ok), whatever its arguments are:
//     those programs' own options are not modelled here, so the command they
//     run is never checked word by word.
//   - behind any other program that is not checked here (setarch, prlimit,
//     script -c, ...), a checked command it would run that is refused on its
//     own, and more than 8 checked commands behind one program.
//   - a command name built with braces (`{git,}`, `g{i,x}t`) that can expand
//     to a checked command. A glob (`/usr/bin/g?t`, or `g?t` beside a file
//     named git) is checked as each checked command it can match, and
//     `$'\x67it'` and `$"git"` are read as the git they decode to.
//   - a command name made only of wildcards (`*`, `./???`), which runs
//     whichever file it matches first.
//   - any command still being checked after BUDGET_MS: Claude Code runs a
//     command whose hook times out or dies.
//
// Read-only gh commands (view, list, status, diff, checks, api GET, ...) are
// always allowed. The command is split into segments on && || ; | & newlines,
// subshells and command substitutions; shell -c / eval strings are analysed
// recursively. Quoted text is data, so a quoted "chrisvel/tududi" inside a
// read-only command or an `echo` is fine.

import { basename } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
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
    discussion: ['view', 'list'],
    codespace: ['list', 'view', 'logs', 'ports'],
};

// gh groups outside GH_GROUPS that may run without a repo target.
// true = every action is read-only or local; array = only those actions.
const GH_OTHER_READONLY = {
    auth: ['status'],
    browse: true,
    search: true,
    status: true,
    config: ['get', 'list'],
    alias: ['list'],
    extension: ['list', 'search', 'browse'],
    'ssh-key': ['list'],
    'gpg-key': ['list'],
    org: ['list'],
    project: ['list', 'view', 'field-list', 'item-list'],
    attestation: ['verify', 'inspect', 'trusted-root'],
    completion: true,
    help: true,
    version: true,
};

// Words that may precede the real command and carry no meaning for us.
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time']);
// Wrappers that run another command; we look through them for gh/git/shells.
const WRAPPERS = new Set([
    'env', 'command', 'builtin', 'exec', 'nohup', 'sudo', 'nice', 'xargs',
    'timeout', 'setsid', 'stdbuf', 'ionice', 'chronic', 'time',
]);
// Wrapper options as getopt reads them: the short letters that take a value
// (from the rest of the word, or else the next word), the ones whose value is
// optional (only the rest of the same word), and the long names that take a
// value (getopt_long accepts any unambiguous prefix of `long`).
const WRAPPER_GETOPT = {
    env: { value: 'uCSa', long: ['ignore-environment', 'null', 'unset', 'chdir', 'argv0', 'split-string', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling', 'debug'], takesValue: ['unset', 'chdir', 'argv0', 'split-string'] },
    exec: { value: 'a', long: [], takesValue: [] },
    time: { value: 'fo', long: ['format', 'output', 'append', 'verbose', 'portability', 'quiet'], takesValue: ['format', 'output'] },
    timeout: { value: 'sk', long: ['signal', 'kill-after', 'foreground', 'preserve-status', 'verbose'], takesValue: ['signal', 'kill-after'] },
    nice: { value: 'n', long: ['adjustment'], takesValue: ['adjustment'] },
    stdbuf: { value: 'ioe', long: ['input', 'output', 'error'], takesValue: ['input', 'output', 'error'] },
    ionice: { value: 'cnpPu', long: ['class', 'classdata', 'pid', 'pgid', 'uid', 'ignore'], takesValue: ['class', 'classdata', 'pid', 'pgid', 'uid'] },
    sudo: { value: 'aCcDgpRrTtUu', optional: 'h', long: ['askpass', 'auth-type', 'background', 'bell', 'close-from', 'chdir', 'preserve-env', 'edit', 'group', 'set-home', 'help', 'host', 'login', 'remove-timestamp', 'reset-timestamp', 'list', 'login-class', 'non-interactive', 'preserve-groups', 'prompt', 'chroot', 'role', 'stdin', 'shell', 'type', 'command-timeout', 'other-user', 'user', 'version', 'validate'], takesValue: ['auth-type', 'close-from', 'chdir', 'group', 'host', 'login-class', 'prompt', 'chroot', 'role', 'type', 'command-timeout', 'other-user', 'user'] },
    xargs: { value: 'adEILnPs', optional: 'eil', long: ['arg-file', 'delimiter', 'eof', 'replace', 'max-lines', 'max-args', 'max-procs', 'max-chars', 'process-slot-var', 'null', 'open-tty', 'interactive', 'no-run-if-empty', 'verbose', 'exit', 'show-limits'], takesValue: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'] },
};

/**
 * Read a wrapper's own leading options. Returns { from, script, rest }: `from`
 * is the index of the first word after them (NAME=value words included), so
 * an option's value (`env -u git`, `exec -a gh`) is never taken for the
 * command the wrapper runs. For env, `script` is the -S / --split-string
 * command string (null if none) and `rest` the index of the word after it.
 */
function wrapperOptions(cmd, w) {
    const spec = WRAPPER_GETOPT[cmd];
    const none = { from: 1, script: null, rest: w.length };
    if (!spec) return none;
    for (let k = 1; k < w.length; k++) {
        const a = w[k];
        if (cmd === 'env' && isAssignment(a)) continue;
        // A lone `-` is env's old spelling of -i; anywhere else it is an operand.
        if (cmd === 'env' && a === '-') continue;
        if (a === '--') return { ...none, from: k + 1 };
        if (!a.startsWith('-') || a === '-') return { ...none, from: k };
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = a.slice(2, eq === -1 ? undefined : eq);
            const hits = spec.long.filter((l) => l.startsWith(name));
            const opt = spec.long.includes(name) ? name : hits.length === 1 ? hits[0] : null;
            if (cmd === 'env' && opt === 'split-string') {
                return eq === -1 ? { from: -1, script: w[k + 1] ?? '', rest: k + 2 } : { from: -1, script: a.slice(eq + 1), rest: k + 1 };
            }
            if (eq === -1 && spec.takesValue.includes(opt)) k++;
            continue;
        }
        for (let j = 1; j < a.length; j++) {
            if (spec.optional?.includes(a[j])) break; // `xargs -iE`: E is -i's value
            if (!spec.value.includes(a[j])) continue;
            if (cmd === 'env' && a[j] === 'S') {
                return j + 1 < a.length
                    ? { from: -1, script: a.slice(j + 1), rest: k + 1 }
                    : { from: -1, script: w[k + 1] ?? '', rest: k + 2 };
            }
            if (j + 1 === a.length) k++; // the value is the next word
            break;
        }
    }
    return { ...none, from: w.length };
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
// Commands whose auto-approved forms (.claude/settings.json) are vetted below.
const NODE_CMDS = ['node', 'nodejs', 'npm'];
// The commands this hook checks, which a wrapper is looked through to find
// (env and exec are read again as wrappers).
const CHECKED = new Set(['gh', 'git', ...SHELLS, 'eval', ...NODE_CMDS, 'env', 'exec']);
// Programs that run a command of their own choosing, but whose options are not
// modelled the way WRAPPER_GETOPT models the wrappers': `chrt -o +0` and
// `flock -n /tmp/l` take values that look like a command, `unshare --wd=DIR`
// and `find -execdir` move the command out of this checkout, `find -exec ...
// {}` hands it operands that are not in this string, and `watch` and
// `flock -c` hand it to `sh -c` as one string. Claude Code's allow-rule matcher
// does not step over them, so in bypass and auto mode nothing prompts either.
// A checked command anywhere behind one of these is refused outright, whatever
// its arguments are; see opaqueWrapperCommand().
const OPAQUE_WRAPPERS = new Set(['flock', 'watch', 'taskset', 'chrt', 'unshare', 'find']);
// What separates the words of a command string a wrapper hands to a shell
// (`watch 'git diff ...'`, `flock -c 'git diff ...'`): whitespace, the shell's
// own punctuation and quotes. Splitting on all of them reads more words than
// the shell would, which can only over-refuse.
const COMMAND_STRING_SEPARATORS = /[\s;&|()<>`'"]+/;
// No list of programs that run a command is complete: `setarch x86_64 git
// diff`, `prlimit`, `setpriv` and `nsenter` run the words after them, and
// `script -qc '...'` hands a shell one string. Behind any program this hook
// neither checks nor steps over, the checked command it would run is checked
// as a command of its own; see checkUnlistedProgram(). These print or match
// their arguments and never run them, so they are not read at all, which keeps
// `grep -rn 'git diff --no-index' docs` working. Only the bare spelling counts,
// and leaving a program out of this set can only over-refuse.
const ARGUMENT_ONLY_PROGRAMS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep']);
// Each checked command behind such a program is checked from where it starts
// to the end of the segment, so the work grows with the square of the words.
// Past this many the command is refused unread; no real invocation runs that many.
const MAX_UNLISTED_INNER = 8;
// How long one decision may take. Claude Code runs the command when the hook
// times out or dies, and reading every tail of a short-option cluster grows
// with the square of the word: a 120 KB `flock -nnn...n /tmp/l git diff ...`
// ran Node out of memory, and the git diff behind it went unchecked. A command
// still being read past this is refused instead; see spend().
export const BUDGET_MS = 5000;
let deadline = null;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Split a shell command line into segments of words.
 * Quotes and backslashes are resolved; operators and parentheses end a segment;
 * heredoc bodies are skipped. This is a deliberately small approximation of
 * shell parsing, good enough to find command names and their flags.
 *
 * With `extglob`, a `(` right after `?`, `*`, `+`, `@` or `!` in a word opens
 * an extended glob group that stays in the word up to its matching `)`, as
 * bash reads it once `shopt -s extglob` is on: `/usr/bin/g@(i)t` is one word
 * that runs git, not `/usr/bin/g@` followed by a subshell.
 */
export function tokenize(input, { extglob = false } = {}) {
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

        if (c === '$' && input[i + 1] === "'") {
            // ANSI-C quoting: the shell decodes the escapes in `$'...'`, so
            // `$'\x67it'` is the word git (#368).
            const { text, end } = ansiC(input, i + 2);
            append(text);
            i = end;
        } else if (c === '$' && input[i + 1] === '"') {
            // Locale quoting: `$"..."` is a double-quoted string looked up in
            // the message catalog, which leaves `$"git"` as git.
            i++;
        } else if (c === "'") {
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
        } else if (c === '(' && extglob && word !== null && /[?*+@!]$/.test(word)) {
            let depth = 0;
            let j = i;
            do {
                if (input[j] === '\\') j++;
                else if (input[j] === "'" || input[j] === '"') {
                    const end = input.indexOf(input[j], j + 1);
                    j = end === -1 ? input.length : end;
                } else if (input[j] === '(') depth++;
                else if (input[j] === ')') depth--;
                j++;
            } while (depth > 0 && j < input.length);
            append(input.slice(i, j));
            i = j;
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

const ANSI_C_ESCAPES = {
    a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
    '\\': '\\', "'": "'", '"': '"', '?': '?',
};

/**
 * Decode the body of a `$'...'` string that starts at `start` (just past the
 * opening quote), as bash does: `\n`, `\NNN` (octal), `\xHH`, `\uHHHH`,
 * `\UHHHHHHHH` and `\cX` are decoded, `\'` does not end the string, and a NUL
 * ends the value. Returns the decoded text and the index past the closing quote.
 */
function ansiC(input, start) {
    let text = '';
    let cut = false;
    let i = start;
    while (i < input.length && input[i] !== "'") {
        let ch = input[i];
        let len = 1;
        if (ch === '\\' && i + 1 < input.length) {
            const rest = input.slice(i + 1, i + 10);
            let m;
            len = 2;
            if ((m = /^[0-7]{1,3}/.exec(rest))) {
                ch = String.fromCharCode(parseInt(m[0], 8) & 0xff);
                len = 1 + m[0].length;
            } else if ((m = /^x([0-9A-Fa-f]{1,2})/.exec(rest)) || (m = /^u([0-9A-Fa-f]{1,4})/.exec(rest)) ||
                (m = /^U([0-9A-Fa-f]{1,8})/.exec(rest))) {
                const code = parseInt(m[1], 16);
                ch = code <= 0x10ffff ? String.fromCodePoint(code) : '';
                len = 1 + m[0].length;
            } else if ((m = /^c([\s\S])/.exec(rest))) {
                ch = String.fromCharCode(m[1].toUpperCase().charCodeAt(0) & 0x1f);
                len = 3;
            } else if (rest[0] in ANSI_C_ESCAPES) {
                ch = ANSI_C_ESCAPES[rest[0]];
            } else {
                ch = `\\${rest[0]}`;
            }
        }
        if (ch === '\0') cut = true;
        if (!cut) text += ch;
        i += len;
    }
    return { text, end: i + 1 };
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
        } else if (c === '$' && input[i + 1] === "'" && !inSingle && !inDouble) {
            // `$'...'` is single-quoted text in which `\'` does not end it.
            for (i += 2; i < input.length && input[i] !== "'"; i++) if (input[i] === '\\') i++;
        } else if (c === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (c === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (!inSingle && c === '$' && input[i + 1] === '(') {
            let depth = 1;
            let j = i + 2;
            // Match the closing paren, ignoring parens in quotes or escaped.
            let q = null;
            for (; j < input.length && depth > 0; j++) {
                const d = input[j];
                if (d === '\\' && q !== "'") j++;
                else if (q) {
                    if (d === q) q = null;
                } else if (d === "'" || d === '"') q = d;
                else if (d === '(') depth++;
                else if (d === ')') depth--;
            }
            found.push(input.slice(i + 2, j - 1));
            i = j - 1; // nested substitutions are found by the recursive analysis
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

const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w);

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

/**
 * Extract the effective --repo/-R value from gh args, or null. gh honours the
 * LAST repeated flag, so a fork flag followed by another repo must not pass:
 * if any value is not the fork, that one is returned; otherwise the last.
 */
function repoFlag(args) {
    const values = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--repo' || a === '-R') values.push(args[++i] ?? '');
        else if (a.startsWith('--repo=')) values.push(a.slice(7));
        else if (a.startsWith('-R') && a.length > 2 && !a.startsWith('--')) values.push(a.slice(2));
    }
    if (!values.length) return null;
    return values.find((v) => !isFork(v)) ?? values[values.length - 1];
}

const block = (reason) => ({ blocked: true, reason: `${reason}\n${GUIDANCE}` });

const LOCAL_GUIDANCE =
    'The auto-approved test and git commands must not run injected code or write ' +
    'files: that would bypass the .env read-deny and the ask/deny rules on the files ' +
    'that bound agents (see docs/security/SECURITY-AI.md). Run the plain command, or ' +
    'ask the owner to run this one.';
const blockLocal = (reason) => ({ blocked: true, reason: `${reason}\n${LOCAL_GUIDANCE}` });

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Variables that make any process (node, npm, bash, the loader) run extra code. */
function isCodeEnv(name) {
    return (
        /^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|BASH_ENV|LESSOPEN|LESSCLOSE)$/.test(name) ||
        /^DYLD_/.test(name) ||
        /^npm_config_/i.test(name)
    );
}

function checkCodeEnv(names) {
    const hit = names.find(isCodeEnv);
    if (hit) return blockLocal(`Blocked: setting ${hit} can load and run arbitrary code in the commands that follow.`);
    return null;
}

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
        // The query must be a visible literal: a body from a file/stdin (--input,
        // query=@file) or a shell variable could hide a mutation.
        const query = args.map((a) => /^query=([\s\S]*)$/.exec(a)).find(Boolean);
        const opaque =
            args.some((a) => a === '--input' || a.startsWith('--input=')) ||
            !query ||
            /^[@$]/.test(query[1]);
        if (opaque) {
            return block('Blocked: `gh api graphql` without an inline literal `-f query=...`; the request cannot be inspected for mutations.');
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
    // The value of --repo/-R is not a command word, wherever the flag sits
    // (`gh -R chrisvel/tududi pr create` must still resolve to group "pr").
    const plain = args.filter((a, n) => !a.startsWith('-') && !['--repo', '-R'].includes(args[n - 1]));
    const group = plain[0];
    if (!group) return null;

    if (group === 'api') return checkGhApi(args.slice(args.indexOf('api') + 1));
    if (!Object.hasOwn(GH_GROUPS, group)) {
        // Fail closed: groups outside GH_GROUPS pass only via the explicit
        // read-only allowlist (GH_OTHER_READONLY). This also covers `gh alias set`,
        // which could define an alias that hides a write.
        const allowed = GH_OTHER_READONLY[group];
        if (allowed === true || (Array.isArray(allowed) && allowed.includes(plain[1] ?? ''))) return null;
        return block(
            `Blocked: \`gh ${group} ${plain[1] ?? ''}\` is not on the read-only allowlist ` +
                '(unknown or mutating gh command; the target repository cannot be verified).'
        );
    }

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
        // Repo-scoped writes take the repo as the word right after the action
        // (`gh repo edit Danathar/tududi ...`). A later plain word may be a flag
        // value (`gh repo edit -d Danathar/tududi` edits gh's default repo).
        const words = args.flatMap((a, n) => (!a.startsWith('-') && !['--repo', '-R'].includes(args[n - 1]) ? [n] : []));
        const repoArg = args[words[1] + 1];
        if (isFork(flagRepo ?? '') || (repoArg !== undefined && isFork(repoArg)) || isFork(envRepo ?? '')) return null;
        return block(`Blocked: \`gh repo ${action}\` without an explicit Danathar/tududi target.`);
    }

    if (target === null) {
        return block(`Blocked: \`gh ${group} ${action}\` has no --repo/-R/GH_REPO; gh would default to the upstream parent.`);
    }
    if (!isFork(target)) {
        return block(`Blocked: \`gh ${group} ${action}\` targets "${target}", not Danathar/tududi.`);
    }
    if (group === 'pr' && action === 'create') return checkPrCreate(args);
    return null;
}

/** AGENTS.md: PRs are created with an explicit `--base main` and `--head <branch>`. */
function checkPrCreate(args) {
    // Flags whose value must be skipped so e.g. `--body "-Bump deps"` is not read as `-B`.
    const takesValue = new Set([
        '--title', '-t', '--body', '-b', '--body-file', '-F', '--label', '-l', '--assignee', '-a',
        '--reviewer', '-r', '--milestone', '-m', '--project', '-p', '--template', '-T',
    ]);
    const flagValue = (long, short) => {
        let found = null;
        for (let i = 0; i < args.length; i++) {
            const a = args[i];
            if (a === long || a === short) found = args[i + 1] ?? '';
            else if (a.startsWith(`${long}=`)) found = a.slice(long.length + 1);
            else if (a.startsWith(short) && a.length > 2 && !a.startsWith('--')) found = a.slice(2); // -Bdevelop
            if (a === long || a === short || takesValue.has(a)) i++; // skip this flag's value
        }
        return found; // gh honours the last occurrence of a repeated flag
    };
    const base = flagValue('--base', '-B');
    const head = flagValue('--head', '-H');
    if (base !== 'main') {
        return block('Blocked: `gh pr create` needs an explicit `--base main`.');
    }
    if (!head) {
        return block('Blocked: `gh pr create` needs an explicit `--head <branch>`.');
    }
    return null;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

// git config keys that can redirect where a push goes or how it authenticates.
// (push.* keys such as push.default or push.autoSetupRemote cannot change the target.)
const RISKY_GIT_CONFIG = /^(remote\.|url\.|credential\.|core\.sshcommand$)/i;

// git config keys that make git run a program or read/write another file.
const EXEC_GIT_CONFIG =
    /^(core\.(pager|editor|fsmonitor|hookspath|askpass|gitproxy|attributesfile|excludesfile|worktree)$|pager\.|diff\.|difftool\.|merge\.|mergetool\.|filter\.|alias\.|include\.|includeif\.|gpg\.|ssh\.|sequence\.editor$|interactive\.difffilter$|uploadpack\.|protocol\.|sendemail\.)/i;

// GIT_* variables that only set identity, locking or pathspec behaviour.
const SAFE_GIT_ENV = new Set([
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
    'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS', 'GIT_MERGE_AUTOEDIT',
    'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
    'GIT_FLUSH', 'GIT_ADVICE', 'GIT_PROGRESS_DELAY',
]);
// Variables naming a program git runs; harmless only with these values.
const PROGRAM_ENV = new Set(['GIT_PAGER', 'PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'EDITOR', 'VISUAL']);
const SAFE_PROGRAMS = new Set(['', 'cat', 'true', ':']);

function checkGitEnv(env) {
    for (const [name, value] of Object.entries(env)) {
        const unsafe = PROGRAM_ENV.has(name)
            ? !SAFE_PROGRAMS.has(String(value ?? '\0'))
            : name === 'PATH' || (/^GIT_/.test(name) && !SAFE_GIT_ENV.has(name));
        if (unsafe) {
            return blockLocal(`Blocked: \`git\` with ${name}= in its environment can run another program or read/write other files.`);
        }
    }
    return null;
}

// Value-taking short options of the diff/log family; a cluster's value starts at them.
const GIT_SHORT_VALUED = 'SGIlnUMCBXL';
// Subcommands whose -o names an output file or directory.
const GIT_O_WRITES = new Set(['format-patch', 'archive', 'bugreport', 'diagnose']);

/**
 * Options that make an otherwise read-only git command write a file at a chosen
 * path (`--output=`, format-patch `-o`) or read any file on the machine
 * (`diff --no-index`, `--orderfile`/`-O`). Pathspecs after `--` are not options.
 */
function checkGitFileOptions(sub, rest) {
    for (const a of rest) {
        if (a === '--') break;
        if (/^--out/.test(a)) return blockLocal(`Blocked: \`git ${sub} ${a.split('=')[0]}\` writes a file at a chosen path.`);
        if (/^--no-ind/.test(a)) return blockLocal(`Blocked: \`git ${sub} --no-index\` reads files outside the repository's history (e.g. .env).`);
        if (/^--orde/.test(a)) return blockLocal(`Blocked: \`git ${sub} --orderfile\` reads an arbitrary file.`);
        if (/^--upload-pack/.test(a)) {
            return blockLocal(`Blocked: \`git ${sub} ${a.split('=')[0]}\` runs a chosen program.`);
        }
        if (/^-[^-]/.test(a)) {
            if (GIT_O_WRITES.has(sub) && a.includes('o')) {
                return blockLocal(`Blocked: \`git ${sub} -o\` writes files at a chosen path.`);
            }
            for (const ch of a.slice(1)) {
                if (ch === 'O') return blockLocal(`Blocked: \`git ${sub} -O\` reads a chosen file (--orderfile) or runs a program (grep --open-files-in-pager).`);
                if (GIT_SHORT_VALUED.includes(ch)) break;
            }
        }
    }
    return null;
}

function checkGit(args, inlineEnv = {}, exported = {}) {
    // Walk global options to find the subcommand, vetting `-c key=value`.
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
        const a = args[i];
        let configKey = null;
        if (a === '-c' || a === '--config-env') configKey = (args[i + 1] ?? '').split('=')[0];
        else if (a.startsWith('--config-env=')) configKey = a.slice(13).split('=')[0];
        if (configKey !== null && RISKY_GIT_CONFIG.test(configKey)) {
            return block(`Blocked: \`git ${a} ${configKey}=...\` could redirect pushes or credentials.`);
        }
        if (configKey !== null && EXEC_GIT_CONFIG.test(configKey)) {
            return blockLocal(`Blocked: \`git ${a} ${configKey}=...\` can make git run a program or read other files.`);
        }
        if (a.startsWith('--exec-path=')) {
            return blockLocal('Blocked: `git --exec-path=...` makes git run programs from a chosen directory.');
        }
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(a) ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    const env = { ...exported, ...inlineEnv };

    if (sub === 'push') {
        const envKey = Object.keys(env).find((k) => /^(GIT_CONFIG_|GIT_SSH)/i.test(k));
        if (envKey) return block(`Blocked: \`git push\` with ${envKey}= could redirect the push.`);
        return checkGitEnv(env) ?? checkGitPush(rest);
    }
    const envBlock = checkGitEnv(env);
    if (envBlock) return envBlock;
    if (sub === 'remote') return checkGitRemote(rest);
    if (sub === 'config') return checkGitConfig(rest);
    if (sub === undefined) return null;
    return checkGitFileOptions(sub, rest);
}

/** Writes to push-redirecting config keys (`git config remote.origin.url ...`). */
function checkGitConfig(rest) {
    // Only flags that pick a read mode. --show-origin/--show-scope are display
    // modifiers: `git config --show-scope remote.origin.url URL` still writes.
    const readOnly = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'];
    if (rest.some((a) => readOnly.includes(a))) return null;

    // Collect positionals, skipping the values of options that take one
    // (`git config -f .git/config remote.origin.url <url>`).
    const valueFlags = ['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--url'];
    const positionals = [];
    for (let k = 0; k < rest.length; k++) {
        const a = rest[k];
        if (valueFlags.includes(a)) k++;
        else if (!a.startsWith('-')) positionals.push(a);
    }

    // Modern syntax: `git config set|unset|replace-all|... <key> [value]`.
    const verbs = ['set', 'unset', 'replace-all', 'add', 'rename-section', 'remove-section', 'edit'];
    const readVerbs = ['get', 'list'];
    let modifies = false;
    const verbRenames = positionals[0] === 'rename-section';
    if (positionals.length && readVerbs.includes(positionals[0])) return null;
    if (positionals.length && verbs.includes(positionals[0])) {
        if (positionals[0] === 'edit') {
            return block('Blocked: `git config edit` could redirect pushes or credentials.');
        }
        positionals.shift();
        modifies = true;
    }
    const key = positionals[0];
    // Legacy syntax: a write is `key value`, or --unset/--add/--replace-all/section edits.
    modifies =
        modifies ||
        positionals.length > 1 ||
        rest.some((a) => /^--(unset|unset-all|add|replace-all|remove-section|rename-section)$/.test(a));
    if (key !== undefined && RISKY_GIT_CONFIG.test(key) && modifies) {
        return block(`Blocked: \`git config ${key}\` write could redirect pushes or credentials.`);
    }
    if (key !== undefined && EXEC_GIT_CONFIG.test(key) && modifies) {
        return blockLocal(`Blocked: \`git config ${key}\` write can make git run a program or read other files.`);
    }
    // Section renames move settings between names: check both the old and the new
    // section (`git config rename-section foo remote.origin` adopts foo.pushurl).
    const renames = verbRenames || rest.includes('--rename-section');
    if (renames && positionals.some((p) => RISKY_GIT_CONFIG.test(`${p}.x`) || EXEC_GIT_CONFIG.test(`${p}.x`) || p.toLowerCase() === 'core')) {
        return block('Blocked: `git config rename-section` involving a remote/url/credential section (or one that runs programs) could redirect pushes.');
    }
    if (rest.includes('--edit') || rest.includes('-e')) {
        return block('Blocked: `git config --edit` could redirect pushes or credentials.');
    }
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
    const sub = rest[0];
    const flags = [];
    const plain = [];
    for (let k = 1; k < rest.length; k++) {
        const a = rest[k];
        if (a.startsWith('-')) {
            flags.push(a);
            if (['-t', '-m', '--track', '--master'].includes(a)) k++; // option takes a value
        } else plain.push(a);
    }
    const [name, url] = plain;
    const originHint =
        'AGENTS.md defines origin as https://github.com/Danathar/tududi; it must not be removed, renamed or re-pointed.';

    // Anything that could remove, replace or re-point `origin` would defeat the
    // "push only to origin" rule (`git push origin` would then reach another repo).
    if (['remove', 'rm', 'rename'].includes(sub) && plain.includes('origin')) {
        return block(`Blocked: \`git remote ${sub}\` involving origin. ${originHint}`);
    }
    if (sub === 'add' && name === 'origin' && !isFork(url ?? '')) {
        return block(`Blocked: \`git remote add origin\` with a non-fork URL. ${originHint}`);
    }
    if (sub !== 'set-url') return null;
    if (url === undefined) return null;
    const push = flags.includes('--push');
    if (push && url !== 'DISABLE' && !(name === 'origin' && isFork(url))) {
        return block(
            `Blocked: \`git remote set-url --push ${name}\` to a real URL. ` +
                'Use `DISABLE` for upstream, or the Danathar/tududi URL for origin.'
        );
    }
    if (name === 'origin' && !isFork(url)) {
        return block(`Blocked: \`origin\` may only point at https://github.com/Danathar/tududi.`);
    }
    return null;
}

// ---------------------------------------------------------------------------
// node / npm (#65, #69)
// ---------------------------------------------------------------------------

/** A file pattern or path that stays inside the checkout: relative, no `..`. */
function isInRepoPath(p) {
    return !/^[/~]/.test(p) && !/^[a-z][a-z0-9+.-]*:/i.test(p) && !p.split(/[\\/]/).includes('..');
}

// node flags that load or run code, read an env file, or write a file.
const NODE_DENIED = /^--(eval|print|require|import|loader|experimental-loader|env-file|env-file-if-exists|experimental-config-file|experimental-default-config-file|inspect|inspect-brk|inspect-wait|inspect-port|debug-port|run|snapshot-blob|build-snapshot|build-snapshot-config|experimental-sea-config|openssl-config|experimental-policy|redirect-warnings|report-directory|report-filename|diagnostic-dir|cpu-prof-dir|heap-prof-dir|tls-keylog|localstorage-file|test-reporter|test-reporter-destination)(=|$)/;
// Short node flags that run code: -e, -p, -r (and clusters such as -pe).
const NODE_DENIED_SHORT = /^-[a-zA-Z]*[epr]/;

// Under `node --test`, only these flags (value = takes a value).
const NODE_TEST_FLAGS = {
    '--test': false, '--test-only': false, '--test-force-exit': false, '--test-update-snapshots': false,
    '--test-name-pattern': true, '--test-skip-pattern': true, '--test-concurrency': true,
    '--test-timeout': true, '--test-shard': true, '--test-isolation': true,
    '--test-reporter': true, '--test-reporter-destination': true,
    '--experimental-test-coverage': false, '--test-coverage-branches': true, '--test-coverage-functions': true,
    '--test-coverage-lines': true, '--test-coverage-include': true, '--test-coverage-exclude': true,
    '--experimental-test-module-mocks': false, '--experimental-test-snapshots': false,
    '--experimental-strip-types': false, '--no-experimental-strip-types': false,
    '--experimental-transform-types': false, '--experimental-vm-modules': false,
    '--no-warnings': false, '--enable-source-maps': false, '--trace-warnings': false,
    '--trace-uncaught': false, '--trace-deprecation': false, '--unhandled-rejections': true,
    '--stack-trace-limit': true, '--watch': false,
};
const NODE_TEST_REPORTERS = new Set(['spec', 'tap', 'dot', 'junit', 'lcov']);

function checkNode(args) {
    const isTest = args.some((a) => a === '--test' || a.startsWith('--test='));
    if (isTest) {
        // The auto-approved `node --test` shape: allowlist every word. Node may
        // still read options after the first file pattern, so all words are vetted.
        for (let k = 0; k < args.length; k++) {
            const a = args[k];
            if (a === '--') continue;
            if (!a.startsWith('-')) {
                if (!isInRepoPath(a)) return blockLocal(`Blocked: \`node --test ${a}\` names a file outside the checkout.`);
                continue;
            }
            const eq = a.indexOf('=');
            const name = eq === -1 ? a : a.slice(0, eq);
            if (!Object.hasOwn(NODE_TEST_FLAGS, name)) {
                return blockLocal(`Blocked: \`node --test ${name}\` is not on the test-runner flag allowlist (it can load code, read .env or write files).`);
            }
            if (!NODE_TEST_FLAGS[name]) continue;
            const value = eq === -1 ? args[++k] ?? '' : a.slice(eq + 1);
            if (name === '--test-reporter' && !NODE_TEST_REPORTERS.has(value)) {
                return blockLocal(`Blocked: \`node --test --test-reporter ${value}\` loads a reporter module; use a built-in reporter.`);
            }
            if (name === '--test-reporter-destination' && !['stdout', 'stderr'].includes(value)) {
                return blockLocal('Blocked: `node --test --test-reporter-destination` writes a file; use stdout or stderr.');
            }
        }
        return null;
    }
    // Any other node run: refuse the code-loading flags among node's own options.
    // The script is the first plain word that is not the value of a preceding
    // `--flag value` option; words after it are the script's own arguments.
    let maybeValue = false;
    for (const a of args) {
        if (a === '--') break;
        if (!a.startsWith('-')) {
            if (!maybeValue) break;
            maybeValue = false;
            continue;
        }
        if (NODE_DENIED.test(a) || (!a.startsWith('--') && NODE_DENIED_SHORT.test(a))) {
            return blockLocal(`Blocked: \`node ${a.split('=')[0]}\` loads or runs code (or reads/writes files) outside the script.`);
        }
        maybeValue = !a.includes('=');
    }
    return null;
}

// npm options (normalised: lower case, `_` as `-`) that run code, change which
// package.json or npmrc is used, or swap the shell that runs scripts.
const NPM_DENIED = new Set([
    'node-options', 'script-shell', 'shell', 'userconfig', 'globalconfig', 'prefix', 'c', 'call',
    'editor', 'browser', 'viewer', 'git', 'node-gyp', 'onload-script', 'init-module', 'logs-dir', 'cache',
]);
// npm expands any unambiguous prefix of a config key to the full key
// (`--node-o` -> `--node-options`, `--script-sh` -> `--script-shell`), so a
// denied option reached unabbreviated is still reachable abbreviated. Treat any
// option that is a non-empty prefix of a denied key as that denied key.
const isNpmDeniedAbbrev = (n) => n.length > 0 && [...NPM_DENIED].some((d) => d.startsWith(n));
const NPM_TEST_ALIASES = new Set(['test', 't', 'tst']);
const NPM_RUN_ALIASES = new Set(['run', 'run-script', 'rum', 'urn']);

// jest flags a test script may receive (value = takes a value). Anything else
// (--config, --setupFiles, --globalSetup, --reporters, --outputFile, --rootDir,
// --coverageDirectory, --testEnvironment, ...) can load code or write files.
const JEST_FLAGS = {
    ci: false, coverage: false, noCoverage: false, runInBand: false, i: false, verbose: false,
    silent: false, bail: false, b: false, watch: false, watchAll: false, detectOpenHandles: false,
    forceExit: false, passWithNoTests: false, listTests: false, onlyChanged: false, o: false,
    onlyFailures: false, f: false, updateSnapshot: false, u: false, colors: false, noColors: false,
    logHeapUsage: false, noStackTrace: false, expand: false, e: false, clearMocks: false,
    resetMocks: false, restoreMocks: false, errorOnDeprecated: false, json: false, useStderr: false,
    cache: false, noCache: false, lastCommit: false, randomize: false, watchman: false,
    noWatchman: false, findRelatedTests: false, showConfig: false, debug: false, help: false, version: false,
    t: true, testNamePattern: true, testPathPattern: true, testPathPatterns: true,
    testPathIgnorePatterns: true, maxWorkers: true, w: true, testTimeout: true, seed: true,
    shard: true, changedSince: true, maxConcurrency: true,
};
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function checkTestScriptArgs(script, scriptArgs) {
    for (let k = 0; k < scriptArgs.length; k++) {
        const a = scriptArgs[k];
        if (a === '--') continue;
        if (!a.startsWith('-')) {
            if (!isInRepoPath(a)) return blockLocal(`Blocked: \`npm ${script}\` argument "${a}" names a path outside the checkout.`);
            continue;
        }
        const eq = a.indexOf('=');
        const raw = (eq === -1 ? a : a.slice(0, eq)).replace(/^--?/, '');
        const name = camel(raw);
        if (!Object.hasOwn(JEST_FLAGS, name)) {
            return blockLocal(`Blocked: \`npm ${script}\` with \`${a.split('=')[0]}\` is not on the test-argument allowlist (it can load code or write files).`);
        }
        if (JEST_FLAGS[name] && eq === -1) k++; // skip the value
        if (/^testPath/.test(name)) {
            const value = eq === -1 ? scriptArgs[k] ?? '' : a.slice(eq + 1);
            if (!isInRepoPath(value)) return blockLocal(`Blocked: \`npm ${script} --${raw}\` names a path outside the checkout.`);
        }
    }
    return null;
}

function checkNpm(args) {
    const dd = args.indexOf('--');
    const npmArgs = dd === -1 ? args : args.slice(0, dd);
    const afterDd = dd === -1 ? [] : args.slice(dd + 1);
    const positionals = [];
    for (const a of npmArgs) {
        if (!a.startsWith('-')) {
            positionals.push(a);
            continue;
        }
        const name = a.replace(/^--?/, '').split('=')[0].toLowerCase().replace(/_/g, '-');
        const bare = name.replace(/^no-/, '');
        if (NPM_DENIED.has(name) || NPM_DENIED.has(bare)
            || isNpmDeniedAbbrev(name) || isNpmDeniedAbbrev(bare) || /^-[cC]/.test(a)) {
            return blockLocal(`Blocked: \`npm ${a.split('=')[0]}\` can run injected code or another package's scripts.`);
        }
    }
    const [sub, ...more] = positionals;
    let script = null;
    let scriptArgs = [];
    if (NPM_TEST_ALIASES.has(sub)) {
        script = 'test';
        scriptArgs = more;
    } else if (NPM_RUN_ALIASES.has(sub) && more.length) {
        script = `run ${more[0]}`;
        scriptArgs = more.slice(1);
    }
    if (script === null || !/test/i.test(script)) return null;
    return checkTestScriptArgs(script, [...scriptArgs, ...afterDd]);
}

// ---------------------------------------------------------------------------
// Opaque wrappers (flock, watch, taskset, chrt, unshare, find)
// ---------------------------------------------------------------------------

/** Thrown once a decision has run past BUDGET_MS; decide() refuses with it. */
class OverBudget extends Error {}

function spend() {
    if (deadline !== null && Date.now() > deadline) {
        throw new OverBudget(
            `Blocked: this hook could not finish checking the command within ${BUDGET_MS / 1000} seconds, and ` +
                'Claude Code runs a command whose hook times out, so it is refused rather than left half-read. ' +
                'Split it into shorter commands.'
        );
    }
}

/**
 * The command strings a word may hand to a shell: the word itself when it
 * holds more than one word of its own (`watch 'git diff ...'`), or a value
 * attached to an option in the same word: after the `=` of a long option
 * (`flock --command='git diff ...'`), or after any letter of a short-option
 * cluster (`flock -c'git diff ...'`). Which letter takes a value is not
 * modelled, so every one is tried. Yielded one at a time: a long cluster has
 * as many tails as letters, each nearly as long as the word.
 */
function* commandStrings(word) {
    if (COMMAND_STRING_SEPARATORS.test(word)) yield word;
    if (word.startsWith('--')) {
        const eq = word.indexOf('=');
        if (eq !== -1) yield word.slice(eq + 1);
    } else {
        const cluster = /^-[A-Za-z0-9]+/.exec(word);
        if (cluster) for (let cut = 2; cut <= cluster[0].length; cut++) yield word.slice(cut);
    }
}

/**
 * The text as the shell would look names up in it: quotes, backslashes and `$`
 * removed. A shell drops quotes and backslashes before it looks a name up, so
 * `g""it`, `gi\t` and `$'git'` inside a command string all run git. Removing
 * more can only refuse more.
 */
function unquoted(text) {
    return text.replace(/[$"'\\]/g, '');
}

// A command name the shell builds before it looks it up (#368). Bash expands
// braces in every word, so `{git,}` and `g{i,x}t` run git, and matches a glob
// in a word against the filesystem, so `/usr/bin/g?t` runs git. A bare `g?t`
// counts too: it matches a file named git in the working directory, and the
// shell then looks the name it produced up on the PATH, so `touch git; g?t`
// runs git. A last part made only of `*` and `?` (`src/*`) names no command in
// particular, and is refused as a command name in checkSegment(). A word with
// more brace forms than MAX_BRACE_FORMS is read only that far, and with its
// braces and commas taken out.
const BUILT_NAME = /[{}*?[]/;
// An extended glob group (`@(i)`, `+(g|x)`, `!(x)`) opened by a `(` the
// tokenizer kept in the word.
const EXTGLOB_GROUP = /[?*+@!]\([^()]*\)/;
const EXTGLOB_OPEN = /[?*+@!]\(/;

/**
 * The word with each extended glob group read as `*`, which matches at least
 * every name the group can, so `g@(i)t` is read as `g*t` and `@(git)` as `*`.
 */
function extglobAsStar(word) {
    let out = word;
    while (EXTGLOB_GROUP.test(out)) {
        spend();
        out = out.replace(new RegExp(EXTGLOB_GROUP, 'g'), '*');
    }
    return out;
}

/** Whether a command name is made only of wildcards (`*`, `./???`, `@(git)`). */
const onlyWildcards = (word) => /^[*?]+$/.test(basename(extglobAsStar(word)));
const BRACE_GROUP = /\{([^{}]*,[^{}]*|(?:-?\d+|[A-Za-z])\.\.(?:-?\d+|[A-Za-z])(?:\.\.-?\d+)?)\}/;
const MAX_BRACE_FORMS = 32;

/** The words a brace group stands for: its alternatives, or a sequence's members. */
function braceAlternatives(body) {
    if (body.includes(',')) return body.split(',');
    const [from, to, step] = body.split('..');
    const numeric = /^-?\d+$/.test(from);
    const a = numeric ? Number(from) : from.charCodeAt(0);
    const b = numeric ? Number(to) : to.charCodeAt(0);
    const by = Math.max(1, Math.abs(Number(step ?? 1)) || 1) * (a <= b ? 1 : -1);
    const out = [];
    for (let k = a; (by > 0 ? k <= b : k >= b) && out.length < MAX_BRACE_FORMS; k += by) {
        out.push(numeric ? String(k) : String.fromCharCode(k));
    }
    return out;
}

/**
 * Whether a glob matches a name the way the shell matches a file name. The
 * match is linear: a backtracking regular expression built from a run of `*`
 * takes longer than Claude Code waits for the hook, and Claude Code runs a
 * command whose hook times out; spend() cannot stop a match already running.
 */
function globMatches(pattern, name) {
    // One step per pattern part: '*', or a test for the one character it matches.
    const steps = [];
    for (let k = 0; k < pattern.length; k++) {
        const ch = pattern[k];
        const cls = ch === '[' ? /\[([!^]?)(\]?[^\]]*)\]/y : null;
        if (cls) cls.lastIndex = k;
        const m = cls?.exec(pattern);
        if (ch === '*') {
            if (steps[steps.length - 1] !== '*') steps.push('*');
        } else if (ch === '?') steps.push(() => true);
        else if (m) {
            // A character class such as [[:alpha:]] is read as any character.
            const one = m[2].includes('[:')
                ? /^[^]$/s
                : new RegExp(`^[${m[1] ? '^' : ''}${m[2].replace(/[\\\]^[]/g, '\\$&')}]$`, 's');
            steps.push((c) => one.test(c));
            k += m[0].length - 1;
        } else steps.push((c) => c === ch);
    }
    // Match, going back only to the last '*' seen.
    let p = 0;
    let n = 0;
    let star = -1;
    let resume = 0;
    while (n < name.length) {
        if (p < steps.length && steps[p] === '*') {
            star = p++;
            resume = n;
        } else if (p < steps.length && steps[p](name[n])) {
            p++;
            n++;
        } else if (star !== -1) {
            p = star + 1;
            n = ++resume;
        } else return false;
    }
    while (p < steps.length && steps[p] === '*') p++;
    return p === steps.length;
}

/**
 * The checked commands the shell could run from this command word once it
 * has expanded its braces and a glob in a path, or [] when it builds none.
 * A name spelled out plainly is read by the callers.
 */
function spelledNames(word) {
    word = extglobAsStar(word);
    if (!BUILT_NAME.test(word)) return [];
    const forms = new Set([word, word.replace(/[{},]/g, '')]);
    const pending = [word];
    while (pending.length && forms.size < MAX_BRACE_FORMS) {
        spend();
        const form = pending.pop();
        const group = BRACE_GROUP.exec(form);
        if (group === null) continue;
        for (const alternative of braceAlternatives(group[1]).slice(0, MAX_BRACE_FORMS)) {
            const expanded = form.slice(0, group.index) + alternative + form.slice(group.index + group[0].length);
            forms.add(expanded);
            pending.push(expanded);
        }
    }
    const names = new Set();
    for (const form of forms) {
        if (/\s/.test(form)) continue; // a word with a space in it names no program
        const name = basename(form);
        if (CHECKED.has(name)) names.add(name);
        else if (/[*?[]/.test(name) && !/^[*?]+$/.test(name)) {
            for (const checked of CHECKED) if (globMatches(name, checked)) names.add(checked);
        }
    }
    return [...names];
}

/** The checked command this word runs as a command name, or null. */
function commandName(word) {
    if (CHECKED.has(basename(word))) return basename(word);
    return spelledNames(word)[0] ?? null;
}

/**
 * The checked command a command string names, or null: in the text cut at its
 * punctuation and quotes, or in its words as the shell reads them, where
 * `$'\x67it'` is git and braces or a glob in a path can build a name (#368).
 */
function checkedNameIn(text) {
    spend();
    const hit = text.split(COMMAND_STRING_SEPARATORS).find((piece) => piece && CHECKED.has(basename(piece)));
    if (hit !== undefined) return basename(hit);
    // Only text the cut above can misread is read as words: tokenizing every
    // tail of a long short-option cluster costs as much again.
    if (!/\$'|[{}*?[]/.test(text) && !EXTGLOB_OPEN.test(text)) return null;
    for (const extglob of [false, true]) {
        for (const word of tokenize(text, { extglob }).flat()) {
            const name = commandName(word);
            if (name !== null) return name;
        }
    }
    return null;
}

/** The checked command a command string in this word names, or null. */
function stringCheckedName(word) {
    for (const text of commandStrings(word)) {
        const name = checkedNameIn(text);
        if (name !== null) return name;
    }
    return null;
}

/**
 * For a segment whose command is an OPAQUE_WRAPPERS program, the checked
 * command it runs (`flock /tmp/l git diff`, `chrt -o -- -0 git diff`,
 * `find . -exec git diff ... \;`, `watch 'git diff ...'`), or null. Every
 * later word is read, since the wrapper's own options are not modelled.
 */
function opaqueWrapperCommand(w) {
    for (const x of w.slice(1)) {
        spend();
        if (commandName(x) !== null) return commandName(x);
        const found = stringCheckedName(x);
        if (found !== null) return found;
    }
    return null;
}

/**
 * For a segment whose command is a program this hook neither checks nor steps
 * over (`setarch x86_64 git diff ...`, `prlimit ...`, `script -qc '...'`), the
 * refusal for the checked command it would run, or null. Each later word where
 * a checked command starts is checked from there to the end, with the
 * assignments in front of the program, and each command string a later word
 * carries is checked as a command line of its own. A command that passes alone
 * still passes behind any program. Only over-refusing is guessed at: an option
 * value that reads as a checked command (`uname -- git diff --no-index a b`)
 * is refused too.
 */
function checkUnlistedProgram(w, inlineEnv, state) {
    const cmd = w[0];
    if (ARGUMENT_ONLY_PROGRAMS.has(cmd)) return null;
    const env = Object.entries(inlineEnv).map(([name, value]) => `${name}=${value}`);
    let checked = 0;
    for (let n = 1; n < w.length; n++) {
        spend();
        let refusal = null;
        // A name the shell joins back together (`g""it`) is checked as the
        // shell would run it; a word that already names one, or that braces or
        // a glob in a path build into one (`{git,}`, `/usr/bin/g?t`), is read
        // as written, and checkSegment() reads it as a command name (#368).
        const word = commandName(w[n]) !== null ? w[n] : unquoted(w[n]);
        if (commandName(word) !== null) {
            if (++checked > MAX_UNLISTED_INNER) {
                return blockLocal(
                    `Blocked: more than ${MAX_UNLISTED_INNER} commands this hook checks behind \`${basename(cmd)}\`, ` +
                        'too many to read. Run them as commands of their own.'
                );
            }
            let start = n;
            while (start > 1 && isAssignment(w[start - 1])) start--;
            refusal = checkSegment([...env, ...w.slice(start, n), word, ...w.slice(n + 1)], state);
        }
        if (!refusal) {
            for (const text of commandStrings(w[n])) {
                // The text as written, then as the shell would run it once its
                // quoted names are joined back together (`$'git'` is read as
                // `$git` as written). Each is checked only if it names a
                // checked command.
                for (const candidate of new Set([text, unquoted(text)])) {
                    if (checkedNameIn(candidate) === null) continue;
                    refusal = checkCommand(candidate, state);
                    if (refusal) break;
                }
                if (refusal) break;
            }
        }
        if (refusal) {
            return {
                ...refusal,
                reason:
                    `\`${basename(cmd)}\` runs a command that is refused on its own, and bypass and auto modes ` +
                    `prompt for neither, so it is checked as though it stood alone. ${refusal.reason}`,
            };
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Segment / command analysis
// ---------------------------------------------------------------------------

function checkSegment(words, state) {
    spend();
    let w = words.slice();
    const inlineEnv = {};
    // Set once the segment runs through xargs: xargs appends words it reads at
    // run time, so no argument check below sees the real command line.
    let xargsFed = false;
    for (;;) {
        while (w.length && (isAssignment(w[0]) || KEYWORDS.has(w[0]))) {
            if (isAssignment(w[0])) {
                const eq = w[0].indexOf('=');
                inlineEnv[w[0].slice(0, eq).replace(/\+$/, '')] = w[0].slice(eq + 1);
            }
            // The `time` keyword takes `-p` and then `--` before the command it times.
            if (w.shift() === 'time') {
                if (w[0] === '-p') w.shift();
                if (w[0] === '--') w.shift();
            }
        }
        const envBlock = checkCodeEnv(Object.keys(inlineEnv));
        if (envBlock) return envBlock;
        if (!w.length) return null;
        // A name made only of `*` and `?` (`*`, `./???`) runs whichever file
        // sorts first, which in a directory holding only a file named git is git.
        if (onlyWildcards(w[0])) {
            return blockLocal(
                `Blocked: \`${w[0]}\` is a command name made only of wildcards, so the shell runs whichever ` +
                    'file it matches first, which can be a command this hook checks. Spell the name out.'
            );
        }
        // A command name the shell builds before it looks it up (#368). Braces
        // are refused: `{git,diff} --no-index ...` is `git diff --no-index ...`,
        // and the words they add are not modelled here. A glob
        // (`/usr/bin/g?t`, `g?t`) is checked as each checked command it can match,
        // with the assignments and any xargs in front of it.
        const spelled = CHECKED.has(basename(w[0])) ? [] : spelledNames(w[0]);
        if (spelled.length && /[{}]/.test(w[0])) {
            return blockLocal(
                `Blocked: \`${w[0]}\` is a command name the shell expands with its braces before running it, ` +
                    `and it can expand to \`${spelled[0]}\`, which this hook checks only when the name is spelled ` +
                    'out. Spell the name out.'
            );
        }
        if (spelled.length) {
            const env = Object.entries(inlineEnv).map(([name, value]) => `${name}=${value}`);
            for (const name of spelled) {
                const refusal = checkSegment([...env, ...(xargsFed ? ['xargs'] : []), name, ...w.slice(1)], state);
                if (refusal) return refusal;
            }
            return null;
        }
        const cmd = basename(w[0]);
        if (!WRAPPERS.has(cmd)) break;
        // `env -S 'gh pr create'` / `-iS ...` / `--split-string=...` runs a command string.
        // Only env's own leading options and NAME=value words are read; the
        // wrapped command's arguments (e.g. `--title -Sx`) are not env options.
        const { from, script, rest } = wrapperOptions(cmd, w);
        if (script !== null) {
            // Check the string on its own, then as the head of the command
            // that still has the remaining words appended.
            const alone = checkCommand(script, state);
            if (alone) return alone;
            const head = tokenize(script).flat();
            return checkSegment([...head, ...w.slice(rest)], state);
        }
        // Look through the wrapper for the real command, past the wrapper's own
        // options and their values. A nested env or exec is read again above,
        // and an opaque wrapper (`nice taskset -c 0 git log`) is read below.
        // The word in the wrapper's command position (past env's assignments
        // and timeout's duration) is also its command when it is made only of
        // wildcards (`nice * diff ...`), and is refused as one below.
        let at = from;
        while (cmd === 'env' && at < w.length && isAssignment(w[at])) at++;
        if (cmd === 'timeout') at++;
        const idx = w.findIndex(
            (x, n) =>
                n >= from &&
                (commandName(x) !== null || OPAQUE_WRAPPERS.has(basename(x)) || (n === at && onlyWildcards(x)))
        );
        for (const x of w.slice(1, idx === -1 ? w.length : idx)) {
            if (isAssignment(x)) {
                const eq = x.indexOf('=');
                inlineEnv[x.slice(0, eq).replace(/\+$/, '')] = x.slice(eq + 1);
            }
        }
        if (idx === -1) return checkCodeEnv(Object.keys(inlineEnv));
        // Any xargs between here and the real command counts, so an outer
        // wrapper (`nice xargs git log`, `timeout 5 xargs git log`) does not hide it.
        if (w.slice(0, idx).some((x) => basename(x) === 'xargs')) xargsFed = true;
        w = w.slice(idx);
    }

    const cmd = basename(w[0]);
    const args = w.slice(1);
    // `printf '%s\n' --output=FILE | xargs git log` and
    // `printf '%s\n' /dev/null .env | xargs git diff` reach git with options
    // and operands this hook never sees, under the git allow rules.
    if (xargsFed && (cmd === 'git' || NODE_CMDS.includes(cmd) || SHELLS.has(cmd))) {
        return blockLocal(
            `Blocked: \`xargs ${cmd}\`; xargs adds arguments read at run time, so this hook cannot check the ` +
                `${cmd} command line the allow rules pre-approve. Write the ${cmd} command out in full instead.`
        );
    }

    if (OPAQUE_WRAPPERS.has(cmd)) {
        const hidden = opaqueWrapperCommand(w);
        if (hidden === null) return null;
        return blockLocal(
            `Blocked: \`${cmd}\` runs \`${hidden}\` where this hook cannot check it: flock, watch, taskset, ` +
                'chrt, unshare and find have options that can move the command out of this checkout ' +
                '(`unshare --wd`, `find -execdir`), hand it operands that are not in this string ' +
                '(`find -exec ... {}`) or pass it to `sh -c` as one string (`watch`, `flock -c`), and ' +
                'bypass and auto modes prompt for none of them. Run the command on its own instead.'
        );
    }

    if (cmd === 'export' || ((cmd === 'declare' || cmd === 'typeset') && args.some((a) => /^-[a-zA-Z]*x/.test(a)))) {
        for (const a of args) {
            if (a.startsWith('-')) continue;
            if (a.startsWith('GH_REPO=')) state.exportedGhRepo = a.slice(8);
            const eq = a.indexOf('=');
            const name = (eq === -1 ? a : a.slice(0, eq)).replace(/\+$/, '');
            const envBlock = checkCodeEnv([name]);
            if (envBlock) return envBlock;
            // A bare `export NAME` exports a value we cannot see.
            (state.exportedEnv ??= {})[name] = eq === -1 ? undefined : a.slice(eq + 1);
        }
        return null;
    }
    if (NODE_CMDS.includes(cmd)) {
        // A PATH set in the same command picks which `sh`, `node` or `jest` runs.
        if ('PATH' in inlineEnv || 'PATH' in (state.exportedEnv ?? {})) {
            return blockLocal(`Blocked: \`${cmd}\` with PATH= set in the same command can run a different program.`);
        }
        if (cmd === 'npm') return checkNpm(args);
        return checkNode(args);
    }
    if (cmd === 'gh') {
        const envRepo = inlineEnv.GH_REPO ?? state.exportedGhRepo ?? null;
        return checkGh(args, envRepo);
    }
    if (cmd === 'git') return checkGit(args, inlineEnv, state.exportedEnv ?? {});
    if (SHELLS.has(cmd)) {
        const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        // The script is the first non-option word after -c (`sh -c -- 'cmd'`, `sh -c -x 'cmd'`).
        const script = c === -1 ? undefined : args.slice(c + 1).find((a) => !a.startsWith('-'));
        if (script !== undefined) return checkCommand(script, state);
        return null;
    }
    if (cmd === 'eval') return checkCommand(args.join(' '), state);
    return checkUnlistedProgram(w, inlineEnv, state);
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
    // Claude Code runs a command line by line, so a `shopt -s extglob` (or a
    // shell started with it on) changes how a later line is read, and
    // `/usr/bin/g@(i)t push --force` runs git. Such a line is read both ways.
    if (EXTGLOB_OPEN.test(command)) {
        for (const words of tokenize(command, { extglob: true })) {
            const r = checkSegment(words, state);
            if (r) return r;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decide on one hook invocation. Returns the exit code and stderr text.
 * Claude Code only blocks on exit 2; any other non-zero code (such as the 1 Node
 * uses for an uncaught exception) lets the command run, so every failure path
 * here must map to 2. `check` and `budgetMs` are injectable so those paths can
 * be tested.
 */
export function decide(raw, check = checkCommand, budgetMs = BUDGET_MS) {
    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return { code: 2, stderr: 'guard-bash: could not parse hook input as JSON; blocking (fail closed).\n' };
    }
    try {
        if (payload?.tool_name && payload.tool_name !== 'Bash') return { code: 0, stderr: '' };
        const command = payload?.tool_input?.command;
        if (typeof command !== 'string' || !command.trim()) return { code: 0, stderr: '' };

        deadline = Date.now() + budgetMs;
        const result = check(command);
        if (result) return { code: 2, stderr: `guard-bash: ${result.reason}\n` };
        return { code: 0, stderr: '' };
    } catch (err) {
        if (err instanceof OverBudget) return { code: 2, stderr: `guard-bash: ${err.message}\n${LOCAL_GUIDANCE}\n` };
        return {
            code: 2,
            stderr: `guard-bash: internal error (${err?.message ?? err}); blocking (fail closed).\n`,
        };
    } finally {
        deadline = null;
    }
}

function main() {
    let raw = '';
    try {
        raw = readFileSync(0, 'utf8');
    } catch {
        // fall through: empty input fails JSON parsing and blocks
    }
    const { code, stderr } = decide(raw);
    if (stderr) process.stderr.write(stderr);
    process.exit(code);
}

/**
 * True when this file is the script being run. Node resolves symlinks for
 * import.meta.url but leaves process.argv[1] as typed, so a hook invoked through
 * a symlinked path (e.g. /home -> /var/home on Fedora Atomic) must be compared
 * after realpath. If resolution itself fails, run anyway: a guard that silently
 * does nothing is worse than one that runs when imported.
 */
function isMainModule() {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return true;
    }
}

if (isMainModule()) main();
