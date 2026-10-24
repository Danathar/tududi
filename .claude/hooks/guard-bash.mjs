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
//     variables, set inline (also as NAME+=value), through `env`, or with
//     export/declare -x.
//   - node code-loading flags (-e/-p/-r, --eval, --print, --require, --import,
//     --loader, --env-file, ...); under `node --test` only an allowlist of
//     test-runner flags and in-repo relative file patterns.
//   - npm --node-options, --script-shell, --prefix, --userconfig, ...; arguments
//     forwarded to a test script pass only a jest allowlist.
//   - git file-writing or file-reading options on any subcommand other than
//     push/remote/config (--output*, --no-index, --orderfile/-O, format-patch
//     -o, --ext-diff, --open-files-in-pager, ...), --upload-pack (and its
//     abbreviations such as --upl), --exec and clone/ls-remote -u on git
//     fetch|pull|clone|ls-remote|archive, which run the program they name,
//     GIT_* environment other than identity/locking variables, pagers and
//     editors other than cat/true, and `-c`/config writes of keys that run
//     programs (core.pager, core.fsmonitor, diff.*, alias.*, include.*, ...).
//   - git, node, npm or a shell run through xargs: xargs appends words read at
//     run time (`printf '%s\n' --output=FILE | xargs git log`), so none of the
//     argument checks here could see them.
//   - git, gh, node, npm or a shell anywhere behind flock, watch, taskset,
//     chrt, unshare or find (-exec/-execdir/-ok), whatever its arguments are:
//     those programs' own options are not modelled here, so the command they
//     run is never checked word by word.
//   - behind any other program that is not checked here (setarch, prlimit,
//     script -c, nsenter, setpriv, busybox, ...), a checked command it would
//     run that is refused on its own, and more than 8 checked commands behind
//     one program.
//   - a script a shell would run that is refused on its own: a `-c` string,
//     fish's -c/--command/-C/--init-command strings, and, for a shell with no
//     script operand, the heredoc, here-string or echo/printf text fed to it
//     on stdin (`bash <<'EOF'`, `echo '...' | sh`).
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
// recursively. Redirections (`>log`, `2>&1`, `<file`) are not arguments, and
// quoted heredoc bodies are data unless a shell reads them. Quoted text is
// data, so a quoted "chrisvel/tududi" inside a read-only command or an `echo`
// is fine.
//
// Layout: the reading described in these notes (words, quotes, `$'...'`,
// substitutions and heredocs, brace and wildcard names, wrappers and the
// commands they run, shell and fish command strings, the git option, config
// and environment rules, the time budget) lives in shell-reader.mjs. That file
// names no repository and is kept byte-identical in every repository that
// carries this guard (its sha256 is pinned by
// .claude/hooks/tests/shell-reader.test.mjs); a reading fix is made in
// Danathar/akmods first and then copied here. This file holds this
// repository's rules (the list above), its messages and the hook's entry
// point, and imports the reader. Two readings are kept here as this
// repository's policy, stricter than the shared reader: sudo's option table,
// and the refusal of any git option that starts with `--out`, `--no-ind` or
// `--orde` (see checkGitFileOptions()).

import { basename } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Reading the command line as the shell would is shared with the other
// repositories that carry this guard; see shell-reader.mjs.
import {
    ARGUMENT_ONLY_PROGRAMS, BUDGET_MS, commandNameReader, commandStrings, COMMAND_STRING_SEPARATORS,
    EXEC_GIT_CONFIG, expandWrapperOptions, extractSubstitutions, fishScripts, GIT_EXEC_OPTION,
    EXTGLOB_OPEN, GIT_SHORT_UPLOAD_PACK, GIT_UPLOAD_PACK_OPTION, GIT_UPLOAD_PACK_SUBCOMMANDS, isAssignment,
    KEYWORDS, MAX_UNLISTED_INNER, NOOP_PROGRAMS, OverBudget, PROGRAM_ENV, REFUSED_GIT_OPTION, RISKY_GIT_CONFIG, SHELLS,
    spend, startBudget, tokenize, unquoted, WRAPPERS, wrapperTarget,
} from './shell-reader.mjs';

// Kept importable from here, where they were defined before the split.
export { BUDGET_MS, extractSubstitutions, tokenize } from './shell-reader.mjs';

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

// Commands whose auto-approved forms (.claude/settings.json) are vetted below.
const NODE_CMDS = ['node', 'nodejs', 'npm'];
// Programs that run a command of their own choosing. The shared reader can
// step over most of them, but `chrt -o +0` and `flock -n /tmp/l` take values
// that look like a command, `unshare --wd=DIR` and `find -execdir` move the
// command out of this checkout, `find -exec ... {}` hands it operands that are
// not in this string, and `watch` and `flock -c` hand it to `sh -c` as one
// string. Claude Code's allow-rule matcher does not step over them, so in
// bypass and auto mode nothing prompts either. A checked command anywhere
// behind one of these is refused outright, whatever its arguments are; see
// opaqueWrapperCommand().
const OPAQUE_WRAPPERS = new Set(['flock', 'watch', 'taskset', 'chrt', 'unshare', 'find']);
// The shared reader can also step over these. This guard reads them as
// programs it does not list (checkUnlistedProgram()): every later word that
// names a checked command, and every command string, is checked as though it
// stood alone, which refuses at least as much as stepping over them.
const READ_AS_UNLISTED = new Set(['nsenter', 'setpriv', 'chroot', 'busybox']);
// Wrappers that are looked through to the command they run (env, nice,
// timeout, xargs, sudo, time, ...).
const STEPPED_OVER = new Set([...WRAPPERS].filter((w) => !OPAQUE_WRAPPERS.has(w) && !READ_AS_UNLISTED.has(w)));
// The commands this hook checks, which a wrapper is looked through to find
// (env and exec are read again as wrappers).
const CHECKED_NAMES = new Set(['gh', 'git', ...SHELLS, 'eval', ...NODE_CMDS, 'env', 'exec']);

// sudo's options as getopt reads them: the short letters that take a value
// (from the rest of the word, or else the next word), the one whose value is
// optional (only the rest of the same word), and the long names, of which
// `takesValue` take one (getopt_long accepts any unambiguous prefix). The
// shared reader has no table for sudo, so this guard keeps its own: without
// it `sudo -u git gh pr merge 1` would be read as git rather than gh.
const SUDO_GETOPT = {
    value: 'aCcDgpRrTtUu',
    optional: 'h',
    long: [
        'askpass', 'auth-type', 'background', 'bell', 'close-from', 'chdir', 'preserve-env', 'edit', 'group', 'set-home',
        'help', 'host', 'login', 'remove-timestamp', 'reset-timestamp', 'list', 'login-class', 'non-interactive',
        'preserve-groups', 'prompt', 'chroot', 'role', 'stdin', 'shell', 'type', 'command-timeout', 'other-user', 'user',
        'version', 'validate',
    ],
    takesValue: [
        'auth-type', 'close-from', 'chdir', 'group', 'host', 'login-class', 'prompt', 'chroot', 'role', 'type',
        'command-timeout', 'other-user', 'user',
    ],
};

/** Index of the command sudo runs, past its options, their values and NAME=value words, or -1. */
function sudoTarget(w) {
    for (let k = 1; k < w.length; k++) {
        const a = w[k];
        if (isAssignment(a)) continue;
        if (a === '--') return k + 1 < w.length ? k + 1 : -1;
        if (!a.startsWith('-') || a === '-') return k;
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            const name = a.slice(2, eq === -1 ? undefined : eq);
            const hits = SUDO_GETOPT.long.filter((l) => l.startsWith(name));
            const opt = SUDO_GETOPT.long.includes(name) ? name : hits.length === 1 ? hits[0] : null;
            if (eq === -1 && SUDO_GETOPT.takesValue.includes(opt)) k++;
            continue;
        }
        for (let j = 1; j < a.length; j++) {
            if (SUDO_GETOPT.optional.includes(a[j])) break; // `sudo -hgit`: git is -h's value
            if (!SUDO_GETOPT.value.includes(a[j])) continue;
            if (j + 1 === a.length) k++; // the value is the next word
            break;
        }
    }
    return -1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// git config keys that can redirect a push (RISKY_GIT_CONFIG) or make git run a
// program or read config from elsewhere (EXEC_GIT_CONFIG) come from the shared
// reader. This guard also refuses the keys below, which it refused before it
// adopted the shared reader and the shared list does not name
// (core.excludesfile, core.worktree, difftool.*, mergetool.*, ssh.*, sendemail.*).
const LOCAL_EXEC_GIT_CONFIG =
    /^(core\.(pager|editor|fsmonitor|hookspath|askpass|gitproxy|attributesfile|excludesfile|worktree)$|pager\.|diff\.|difftool\.|merge\.|mergetool\.|filter\.|alias\.|include\.|includeif\.|gpg\.|ssh\.|sequence\.editor$|interactive\.difffilter$|uploadpack\.|protocol\.|sendemail\.)/i;
const runsProgram = (key) => EXEC_GIT_CONFIG.test(key) || LOCAL_EXEC_GIT_CONFIG.test(key);

// GIT_* variables that only set identity, locking or pathspec behaviour.
const SAFE_GIT_ENV = new Set([
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE',
    'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS', 'GIT_MERGE_AUTOEDIT',
    'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS',
    'GIT_FLUSH', 'GIT_ADVICE', 'GIT_PROGRESS_DELAY',
]);

function checkGitEnv(env) {
    for (const [name, value] of Object.entries(env)) {
        // PROGRAM_ENV (GIT_PAGER, PAGER, editors) is harmless only with a NOOP_PROGRAMS value.
        const unsafe = PROGRAM_ENV.has(name)
            ? !NOOP_PROGRAMS.has(String(value ?? '\0'))
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

/** Whether a git option makes fetch|pull|clone|ls-remote|archive run the program it names. */
function runsUploadPack(sub, a) {
    return (
        GIT_UPLOAD_PACK_SUBCOMMANDS.has(sub) &&
        (GIT_UPLOAD_PACK_OPTION.test(a) ||
            ((sub === 'ls-remote' || sub === 'archive') && GIT_EXEC_OPTION.test(a)) ||
            ((sub === 'clone' || sub === 'ls-remote') && GIT_SHORT_UPLOAD_PACK.test(a)))
    );
}

/**
 * Options that make an otherwise read-only git command write a file at a chosen
 * path (`--output=`, format-patch `-o`), read any file on the machine
 * (`diff --no-index`, `--orderfile`/`-O`) or run a program (`--ext-diff`,
 * `--open-files-in-pager`, `fetch --upload-pack`). Pathspecs after `--` are not
 * options. Any option that starts with `--out`, `--no-ind` or `--orde` is
 * refused, which is stricter than the shared REFUSED_GIT_OPTION (the prefixes
 * git accepts of `--output` and `--no-index`): it also refuses
 * `--output-directory` and spellings that brace expansion completes
 * (`--outpu{t,t}=FILE`).
 */
function checkGitFileOptions(sub, rest) {
    for (const a of rest) {
        if (a === '--') break;
        if (/^--out/.test(a)) return blockLocal(`Blocked: \`git ${sub} ${a.split('=')[0]}\` writes a file at a chosen path.`);
        if (/^--no-ind/.test(a)) return blockLocal(`Blocked: \`git ${sub} --no-index\` reads files outside the repository's history (e.g. .env).`);
        if (/^--orde/.test(a)) return blockLocal(`Blocked: \`git ${sub} --orderfile\` reads an arbitrary file.`);
        if (/^--upload-pack/.test(a) || runsUploadPack(sub, a)) {
            return blockLocal(`Blocked: \`git ${sub} ${a.split('=')[0]}\` runs a chosen program (--upload-pack, --exec, clone/ls-remote -u).`);
        }
        if (REFUSED_GIT_OPTION.test(a)) {
            return blockLocal(`Blocked: \`git ${sub} ${a.split('=')[0]}\` writes a file, reads outside the repository or runs a program.`);
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
        if (configKey !== null && runsProgram(configKey)) {
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
    if (key !== undefined && runsProgram(key) && modifies) {
        return blockLocal(`Blocked: \`git config ${key}\` write can make git run a program or read other files.`);
    }
    // Section renames move settings between names: check both the old and the new
    // section (`git config rename-section foo remote.origin` adopts foo.pushurl).
    const renames = verbRenames || rest.includes('--rename-section');
    if (renames && positionals.some((p) => RISKY_GIT_CONFIG.test(`${p}.x`) || runsProgram(`${p}.x`) || p.toLowerCase() === 'core')) {
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
// Command names the shell builds
// ---------------------------------------------------------------------------

// How the shell may build one of CHECKED_NAMES out of a word (brace groups
// and sequences, wildcards, POSIX classes, extended glob groups); see
// commandNameReader() in shell-reader.mjs. Returns { braces: true } or
// { globs: [names] }, or null when the word builds none.
const { builtCommandName: builtName } = commandNameReader(CHECKED_NAMES);

/** Whether this word names a checked command, also once the shell has expanded it. */
function namesChecked(word) {
    return CHECKED_NAMES.has(basename(word)) || builtName(word) !== null;
}

/** The checked command this word runs as a command name (a braced word as written), or null. */
function commandName(word) {
    if (CHECKED_NAMES.has(basename(word))) return basename(word);
    const built = builtName(word);
    if (built === null) return null;
    return built.globs?.[0] ?? word;
}

/** Whether a command name is made only of wildcards (`*`, `./???`, `@(git)` read with extglob). */
const onlyWildcards = (word) => /^[*?]+$/.test(basename(word));

/**
 * The checked command a command string names, or null: in the text cut at its
 * punctuation and quotes, or in its words as the shell reads them, where
 * `$'\x67it'` is git and braces, a glob or an extended glob group can build a
 * name (#368, #389).
 */
function checkedNameIn(text) {
    spend();
    const hit = text.split(COMMAND_STRING_SEPARATORS).find((piece) => piece && CHECKED_NAMES.has(basename(piece)));
    if (hit !== undefined) return basename(hit);
    // Only text the cut above can misread is read as words: tokenizing every
    // tail of a long short-option cluster costs as much again.
    if (!/\$['"]|[{}*?[]/.test(text) && !EXTGLOB_OPEN.test(text)) return null;
    // tokenize() also reads each extended glob group as `*`.
    for (const word of tokenize(text).flat()) {
        const name = commandName(word);
        if (name !== null) return name;
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

// ---------------------------------------------------------------------------
// Programs that run a command (flock, watch, ..., and any program not listed)
// ---------------------------------------------------------------------------

/**
 * For a segment whose command is an OPAQUE_WRAPPERS program, the checked
 * command it runs (`flock /tmp/l git diff`, `chrt -o -- -0 git diff`,
 * `find . -exec git diff ... \;`, `watch 'git diff ...'`), or null. Every
 * later word is read, since the wrapper's own options are not modelled.
 */
function opaqueWrapperCommand(w) {
    for (const x of w.slice(1)) {
        spend();
        const name = commandName(x);
        if (name !== null) return name;
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
        // a glob build into one (`{git,}`, `/usr/bin/g?t`), is read as written,
        // and checkSegment() reads it as a command name (#368).
        const word = namesChecked(w[n]) ? w[n] : unquoted(w[n]);
        if (namesChecked(word)) {
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
    // What the tokenizer found feeding this segment's stdin: a heredoc body, a
    // here-string, a `< file` and the segment piped into it.
    const { pipedFrom, stdinFrom, hereString, heredocBody } = words;
    const withInput = (next) => Object.assign(next, { pipedFrom, stdinFrom, hereString, heredocBody });
    let w = words.slice();
    const inlineEnv = {};
    const assign = (x) => {
        const eq = x.indexOf('=');
        inlineEnv[x.slice(0, eq).replace(/\+$/, '')] = x.slice(eq + 1);
    };
    // Set once the segment runs through xargs: xargs appends words it reads at
    // run time, so no argument check below sees the real command line.
    let xargsFed = false;
    for (;;) {
        while (w.length && (isAssignment(w[0]) || KEYWORDS.has(w[0]))) {
            if (isAssignment(w[0])) assign(w[0]);
            w.shift();
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
        const built = CHECKED_NAMES.has(basename(w[0])) ? null : builtName(w[0], true);
        if (built?.braces) {
            return blockLocal(
                `Blocked: \`${w[0]}\` is a command name the shell expands with its braces before running it, ` +
                    'and it can expand to a command this hook checks only when the name is spelled out. ' +
                    'Spell the name out.'
            );
        }
        if (built) {
            const env = Object.entries(inlineEnv).map(([name, value]) => `${name}=${value}`);
            for (const name of built.globs) {
                const refusal = checkSegment(withInput([...env, ...(xargsFed ? ['xargs'] : []), name, ...w.slice(1)]), state);
                if (refusal) return refusal;
            }
            return null;
        }
        const cmd = basename(w[0]);
        if (!STEPPED_OVER.has(cmd)) break;
        // Each wrapper's packed and abbreviated options are spelled out one per
        // word first (`env -iu X` -> `env -i -u X`), so an option's value
        // (`env -u git`, `exec -a gh`) is never taken for the command it runs.
        if (cmd !== 'sudo') w = expandWrapperOptions(cmd, w);
        // `env -S 'gh pr create'` / `--split-string=...` runs a command string.
        // Only env's own leading options and NAME=value words are scanned; the
        // wrapped command's arguments (e.g. `--title -Sx`) are not env options.
        if (cmd === 'env') {
            for (let k = 1; k < w.length; k++) {
                const a = w[k];
                if (isAssignment(a)) continue;
                if (!a.startsWith('-')) break; // first word of the wrapped command
                if (['-u', '--unset', '-C', '--chdir', '-a', '--argv0'].includes(a)) {
                    k++;
                    continue;
                }
                let script = null;
                let rest = k + 1;
                if (a === '-S' || a === '--split-string') {
                    script = w[k + 1] ?? '';
                    rest = k + 2;
                } else if (a.startsWith('--split-string=')) script = a.slice(15);
                else if (/^-S./.test(a)) script = a.slice(2);
                if (script === null) continue;
                // Check the string on its own, then as the head of the command
                // that still has the remaining words appended.
                const alone = checkCommand(script, state);
                if (alone) return alone;
                const head = tokenize(script).flat();
                return checkSegment(withInput([...head, ...w.slice(rest)]), state);
            }
        }
        // Look through the wrapper to the command it runs, past its own options
        // (and their values), NAME=value words and operands such as timeout's
        // duration. A nested env or exec is read again above, an opaque
        // wrapper (`nice taskset -c 0 git log`) below, and a command name made
        // only of wildcards in the wrapper's command position (`nice * diff`)
        // is refused above.
        const idx = cmd === 'sudo' ? sudoTarget(w) : wrapperTarget(w);
        for (const x of w.slice(1, idx === -1 ? w.length : idx)) if (isAssignment(x)) assign(x);
        if (idx === -1) return checkCodeEnv(Object.keys(inlineEnv));
        // Any xargs on the way to the real command counts, so an outer wrapper
        // (`nice xargs git log`, `timeout 5 xargs git log`) does not hide it.
        if (cmd === 'xargs') xargsFed = true;
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
        let scripts;
        if (cmd === 'fish') {
            // fish takes code from -c/--command and -C/--init-command (each may repeat,
            // with the value attached or in the next word); every one of them runs.
            scripts = fishScripts(args);
        } else {
            const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
            // The script is the first non-option word after -c (`sh -c -- 'cmd'`, `sh -c -x 'cmd'`).
            const script = c === -1 ? undefined : args.slice(c + 1).find((a) => !a.startsWith('-'));
            scripts = script === undefined ? [] : [script];
        }
        if (scripts.length) {
            for (const script of scripts) {
                const r = checkCommand(script, state);
                if (r) return r;
            }
            return null;
        }
        // No script operand: the shell reads its program from stdin. A heredoc
        // or here-string fed to it is a script it runs, and so is the text piped
        // in from a heredoc, a here-string or a literal echo/printf
        // (`cat <<'EOF' | bash`, `echo 'git push ...' | sh`).
        if (!args.some((a) => !a.startsWith('-'))) {
            const feeders = [];
            for (let p = pipedFrom; p; p = p.pipedFrom) feeders.push(p);
            const literal = (f) => {
                const name = basename(f[0] ?? '');
                if (name !== 'echo' && name !== 'printf') return undefined;
                const rest = f.slice(1).filter((a) => !a.startsWith('-'));
                if (name === 'printf') rest.shift(); // the format string
                return rest.join(' ');
            };
            for (const text of [heredocBody, hereString, ...feeders.flatMap((f) => [f.heredocBody, f.hereString, literal(f)])]) {
                if (text === undefined) continue;
                const r = checkCommand(text, state);
                if (r) return r;
            }
        }
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
    // tokenize() reads a line holding an extended glob group both ways: Claude
    // Code runs a command line by line, so after `shopt -s extglob` (or in a
    // shell started with it on) `/usr/bin/g@(i)t push --force` runs git.
    for (const words of tokenize(command)) {
        const r = checkSegment(words, state);
        if (r) return r;
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

        startBudget(budgetMs);
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
        startBudget(Infinity); // no deadline between decisions
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
