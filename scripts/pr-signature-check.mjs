#!/usr/bin/env node
/**
 * Pull-request-time half of the agent audit trail.
 *
 * scripts/ai-audit-report.mjs reports, after the merge, an agent PR whose
 * body has no `— hive: agent=...` signature line, or that closes no issue of
 * this repository; by then the body cannot be fixed. This runs while the PR
 * is open (.github/workflows/agent-signature.yml) and checks both:
 *   signature      uses the audit's own findSignature, so the two cannot
 *                  disagree on what a signature line is
 *   closing issue  the body has a GitHub closing keyword (close, fix,
 *                  resolve and their forms) followed by `#N` or
 *                  `Danathar/tududi#N`. Keywords in code blocks or inline
 *                  code, `Refs #N`, and other repositories do not count.
 *                  The audit itself still reads GitHub's
 *                  closingIssuesReferences; this is the early, text-only
 *                  approximation of it (no API call, no token scope).
 *
 * Input: the PR body in the PR_BODY environment variable (unset reads as
 * empty). Nothing in the body is printed back.
 *
 * Exit codes: 0 both are present; 1 either is missing (both are reported).
 */

import { fileURLToPath } from 'node:url';

import { findSignature } from './ai-audit-report.mjs';

export const MISSING =
    "::error::The pull request body has no signature line. Add a line of its own, outside any code block, that starts with '— hive:' and names agent=, e.g. '— hive: agent=<role> backend=<backend> model=<model>'. The weekly agent audit (agent-audit.yml) reads it.";

export const NO_CLOSING_ISSUE =
    "::error::The pull request body names no issue it closes. Add a line of its own, outside any code block, such as 'Closes #N', where N is an issue in this repository (Danathar/tududi). 'Refs #N' and an issue of another repository do not count. The weekly agent audit (agent-audit.yml) requires the link.";

const CLOSING =
    /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+(?:Danathar\/tududi)?#\d+/i;

/**
 * True when the body, outside fenced code blocks and inline code, has a
 * GitHub closing keyword followed by `#N` or `Danathar/tududi#N`.
 */
export function hasClosingKeyword(body) {
    const kept = [];
    let fence = null;
    for (const line of String(body ?? '').split(/\r?\n/)) {
        const open = /^(`{3,}|~{3,})(.*)$/.exec(line.trim());
        if (open) {
            const [, marker, rest] = open;
            if (fence === null) {
                fence = marker;
            } else if (
                marker[0] === fence[0] &&
                marker.length >= fence.length &&
                rest.trim() === ''
            ) {
                fence = null;
            }
            continue;
        }
        if (fence === null) kept.push(line);
    }
    const text = kept.join('\n').replace(/(`+)[\s\S]*?\1/g, ' ');
    return CLOSING.test(text);
}

/** Runs the check; returns the exit code. */
export function main(env = process.env, out = process.stdout) {
    const problems = [];
    if (findSignature(env.PR_BODY) === null) problems.push(MISSING);
    if (!hasClosingKeyword(env.PR_BODY)) problems.push(NO_CLOSING_ISSUE);
    if (problems.length > 0) {
        for (const p of problems) out.write(`${p}\n`);
        return 1;
    }
    out.write(
        'The pull request body has a signature line and names the issue it closes.\n'
    );
    return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = main();
}
