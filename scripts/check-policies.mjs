#!/usr/bin/env node
/**
 * Policy-as-code checker. Evaluates the JSON policies in policies/ and the
 * risk-tier table against the files in a repository tree.
 *
 *   node scripts/check-policies.mjs                 check this repository
 *   node scripts/check-policies.mjs --root <dir>    check another tree (tests)
 *   node scripts/check-policies.mjs --classify <path>...
 *                                                   print the risk tier of paths
 *
 * Checks:
 *   1. policies/fork-target.json        agent files keep work on this fork
 *   2. policies/workflow-permissions.json  workflow token scope and pinning
 *   3. docs/risk-tiers.md vs risk-config.json  tier table drift
 *
 * Node built-ins only. Exit code 1 when any violation is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);

// ---------------------------------------------------------------- helpers

/** Convert a glob (`**`, `*`, `?`) to an anchored RegExp over posix paths. */
export function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    re += '(?:.*/)?';
                    i += 2;
                } else {
                    re += '.*';
                    i += 1;
                }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${re}$`);
}

export function matchesAny(globs, file) {
    return globs.some((g) => globToRegExp(g).test(file));
}

/** All files under root as posix relative paths. */
export function walk(root, rel = '') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(root, rel), {
        withFileTypes: true,
    })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) out.push(...walk(root, r));
        } else if (entry.isFile()) {
            out.push(r);
        }
    }
    return out.sort();
}

function readJson(root, rel, violations) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
        violations.push(`${rel}: missing`);
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        violations.push(`${rel}: invalid JSON (${err.message})`);
        return null;
    }
}

// --------------------------------------------------- 1. fork-target policy

/**
 * Split text into logical lines, joining shell continuations (trailing
 * backslash) so a multi-line `gh` command is judged as one command.
 * Returns [{ line, text }] where line is the 1-based first physical line.
 */
export function logicalLines(text) {
    const out = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        let joined = lines[i];
        const start = i + 1;
        while (/\\\s*$/.test(joined) && i + 1 < lines.length) {
            joined = joined.replace(/\\\s*$/, ' ') + lines[++i].trim();
        }
        out.push({ line: start, text: joined });
    }
    return out;
}

/**
 * Find `gh <noun> <verb>` write commands in a logical line. There is no
 * exemption for prose: a line that spells a write command without the repo
 * flag is a violation even when it describes the mistake. Reword it.
 */
export function findWriteCommands(text, writeRe) {
    return [...text.matchAll(new RegExp(writeRe, 'g'))].map((m) => m[0]);
}

export function checkForkTarget(root, policy, files) {
    const v = [];
    const literal = policy.requiredLiteral;
    const repoRe = new RegExp(policy.repoFlagPattern);
    const forbidden = policy.forbiddenPatterns.map((p) => new RegExp(p));

    const directionFiles = files.filter((f) =>
        matchesAny(policy.directionGlobs, f),
    );
    for (const f of directionFiles) {
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        if (!text.includes(literal)) {
            v.push(
                `${f}: agent-directions file must contain the literal "${literal}" ` +
                    `(PRs and issues go to this fork, never chrisvel/tududi)`,
            );
        }
    }

    const scanned = new Set([
        ...files.filter((f) => matchesAny(policy.scanGlobs, f)),
        ...directionFiles,
    ]);
    for (const f of [...scanned].sort()) {
        if (matchesAny(policy.excludeGlobs ?? [], f)) continue;
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        for (const { line, text: t } of logicalLines(text)) {
            for (const re of forbidden) {
                if (re.test(t)) {
                    v.push(
                        `${f}:${line}: targets the upstream repository for a write ` +
                            `(${re.source}); work stays in Danathar/tududi`,
                    );
                }
            }
            const cmds = findWriteCommands(t, policy.writeCommandPattern);
            if (cmds.length > 0 && !repoRe.test(t)) {
                v.push(
                    `${f}:${line}: "${cmds[0]}" without ${literal} ` +
                        `(a bare gh command targets chrisvel/tududi in a fork clone)`,
                );
            }
        }
    }
    return v;
}

// ---------------------------------------------- 2. workflow-permissions policy

const indentOf = (l) => l.match(/^\s*/)[0].length;
const isBlank = (l) => l.trim() === '';

/** Index of the nearest earlier non-blank line with smaller indent, or -1. */
function parentOf(code, i, indent = indentOf(code[i])) {
    for (let j = i - 1; j >= 0; j--) {
        if (!isBlank(code[j]) && indentOf(code[j]) < indent) return j;
    }
    return -1;
}

/**
 * Top-level `permissions:` must exist and must not grant write access
 * (`write-all` or any `<scope>: write`); wider scopes belong on a job.
 */
export function checkTopLevelPermissions(f, code, policy) {
    const at = code.findIndex((l) => /^permissions\s*:/.test(l));
    if (at === -1) {
        return [
            `${f}: no top-level "permissions:" (the token would get the repository default)`,
        ];
    }
    const v = [];
    const inline = code[at].replace(/^permissions\s*:/, '').trim();
    if (inline === 'write-all') {
        v.push(`${f}:${at + 1}: top-level permissions: write-all`);
    }
    if (policy.forbidTopLevelWrite !== false) {
        for (let j = at + 1; j < code.length; j++) {
            if (isBlank(code[j])) continue;
            if (indentOf(code[j]) === 0) break;
            if (/:\s*write\b/.test(code[j])) {
                v.push(
                    `${f}:${j + 1}: top-level permissions grant write ("${code[j].trim()}"); grant it on the job that needs it`,
                );
            }
        }
        if (/\bwrite\b/.test(inline) && inline !== 'write-all') {
            v.push(`${f}:${at + 1}: top-level permissions grant write`);
        }
    }
    return v;
}

/**
 * GH_REPO values valid for the block that starts at line `a`: a direct
 * `env:` child of that block (workflow, job or step) that sets GH_REPO.
 */
function blockGhRepo(code, a) {
    // a === -1 is the workflow root: its children sit at indent 0.
    const indent = a === -1 ? -1 : indentOf(code[a]);
    const dash = a !== -1 && /^\s*-\s/.test(code[a]);
    let childIndent = a === -1 ? 0 : dash ? indent + 2 : -1;
    let end = code.length;
    for (let j = a + 1; j < code.length; j++) {
        if (isBlank(code[j])) continue;
        if (indentOf(code[j]) <= indent) {
            end = j;
            break;
        }
        if (childIndent === -1) childIndent = indentOf(code[j]);
    }
    const found = [];
    for (let j = a + 1; j < end; j++) {
        const m = code[j].match(/^\s*GH_REPO\s*:\s*(.+?)\s*$/);
        if (!m) continue;
        const envLine = parentOf(code, j);
        if (
            envLine !== -1 &&
            /^\s*env\s*:\s*$/.test(code[envLine]) &&
            indentOf(code[envLine]) === childIndent
        ) {
            found.push({ line: j, value: m[1] });
        }
    }
    return found;
}

/**
 * Every `gh` write command must name this fork: `--repo`/`-R` with an allowed
 * literal, or with `$GH_REPO` when the command's own step, its job or the
 * workflow sets GH_REPO to an allowed value in `env:`; or no flag at all when
 * such a GH_REPO is in scope. Scope is by YAML block, so a GH_REPO in another
 * job or step does not count. Any GH_REPO or --repo naming another repository
 * is a violation.
 */
// Value of --repo/-R: a GH_REPO reference, the github.repository expression,
// or an owner/repo token that stops at the first character that cannot be in
// one (quotes, ':', ')', ',', whitespace), so `--repo Danathar/tududi:*),` in
// an --allowedTools string reads as Danathar/tududi.
const REPO_FLAG =
    /(?:--repo|-R)(?:\s+|=)["']?(\$\{?GH_REPO\}?|\$\{\{\s*github\.repository\s*\}\}|[\w.-]+\/[\w.-]+|[^\s"',:)]+)/;

export function checkGhScope(f, code, policy) {
    const v = [];
    const allowed = policy.allowedRepoValues;
    const unq = (x) => x.replace(/^["']|["']$/g, '').replace(/\s+/g, ' ');
    const okLiteral = (x) => allowed.includes(unq(x));
    const reportedBad = new Set();
    code.forEach((l, i) => {
        const m = l.match(/^\s*GH_REPO\s*:\s*(.+?)\s*$/);
        if (m && !okLiteral(m[1])) {
            v.push(`${f}:${i + 1}: GH_REPO is "${m[1]}", expected ${allowed[0]} or Danathar/tududi`);
            reportedBad.add(i);
        }
    });
    const logical = logicalLines(code.join('\n'));
    for (const { line, text: t } of logical) {
        const writes = findWriteCommands(t, policy.ghWriteCommandPattern);
        if (writes.length === 0) continue;
        // Blocks enclosing the command: its own line, then its ancestors.
        const chain = [];
        let at = line - 1;
        chain.push(at);
        while ((at = parentOf(code, at)) !== -1) chain.push(at);
        // A step that starts with "- run:" is its own block; a "run: |" body
        // sits under the step's "- name:" ancestor, found by parentOf above.
        const okEnv = (g) => okLiteral(g.value) && !reportedBad.has(g.line);
        const scoped =
            chain.some((a) => blockGhRepo(code, a).some(okEnv)) ||
            blockGhRepo(code, -1).some(okEnv);
        // Judge each write command on its own segment of the line, so a
        // line that lists several (an --allowedTools string) is not
        // misread as one command with one flag.
        const starts = [
            ...t.matchAll(new RegExp(policy.ghWriteCommandPattern, 'g')),
        ].map((m) => m.index);
        starts.forEach((from, n) => {
            const seg = t.slice(from, starts[n + 1] ?? t.length);
            const cmd = seg.match(new RegExp(policy.ghWriteCommandPattern))[0];
            const flag = seg.match(REPO_FLAG);
            if (flag) {
                const val = flag[1];
                const viaEnv = /^\$\{?GH_REPO\}?$/.test(val);
                if (viaEnv ? !scoped : !okLiteral(val)) {
                    v.push(
                        viaEnv
                            ? `${f}:${line}: "${cmd}" uses $GH_REPO but no valid GH_REPO is set in this step, job or workflow env`
                            : `${f}:${line}: "${cmd}" targets "${val}", expected ${allowed[0]} or Danathar/tududi`,
                    );
                }
            } else if (!scoped) {
                v.push(
                    `${f}:${line}: "${cmd}" has no --repo and no valid GH_REPO is set in this step, job or workflow env`,
                );
            }
        });
    }
    return v;
}

/** Reject attacker-controlled event expressions inside `run:` scripts. */
export function checkRunExpressions(f, code, policy) {
    const v = [];
    const bad = new RegExp(policy.forbiddenRunExpressions);
    for (let i = 0; i < code.length; i++) {
        const m = code[i].match(/^(\s*(?:-\s+)?)run\s*:\s*(.*)$/);
        if (!m) continue;
        const indent = m[1].length;
        const body = [m[2]];
        for (let j = i + 1; j < code.length; j++) {
            if (!isBlank(code[j]) && indentOf(code[j]) <= indent) break;
            body.push(code[j]);
        }
        body.forEach((b, k) => {
            for (const e of b.matchAll(/\$\{\{([^}]*)\}\}/g)) {
                if (bad.test(e[1])) {
                    v.push(
                        `${f}:${i + 1 + k}: \${{${e[1]}}} in a run script; pass it through env: and use "$VAR"`,
                    );
                }
            }
        });
    }
    return v;
}

export function checkWorkflows(root, policy, files) {
    const v = [];
    const pin = new RegExp(policy.pinPattern);
    const trusted = new Set(policy.trustedActionOwners);
    const writeRe = policy.ghWriteCommandPattern;
    const workflows = files.filter((f) => matchesAny(policy.workflowGlobs, f));

    for (const f of workflows) {
        const text = fs.readFileSync(path.join(root, f), 'utf8');
        const lines = text.split(/\r?\n/);
        const code = lines.map((l) => l.replace(/(^|\s)#.*$/, ''));

        if (policy.requireTopLevelPermissions) {
            v.push(...checkTopLevelPermissions(f, code, policy));
        }

        code.forEach((l, i) => {
            for (const trigger of policy.forbiddenTriggers) {
                if (new RegExp(`\\b${trigger}\\b`).test(l)) {
                    v.push(`${f}:${i + 1}: forbidden trigger ${trigger}`);
                }
            }
            const m = l.match(/\buses\s*:\s*['"]?([^\s'"]+)/);
            if (!m) return;
            const ref = m[1];
            if (ref.startsWith('./') || ref.startsWith('docker://')) return;
            const [name, version = ''] = ref.split('@');
            const owner = name.split('/')[0];
            if (trusted.has(owner)) return;
            if (!pin.test(version)) {
                v.push(
                    `${f}:${i + 1}: third-party action ${name} must be pinned to a full commit SHA (found "${version || 'no ref'}")`,
                );
            }
        });

        if (policy.ghWriteNeedsRepo) v.push(...checkGhScope(f, code, policy));
        if (policy.forbiddenRunExpressions) {
            v.push(...checkRunExpressions(f, code, policy));
        }
    }
    return v;
}

// ------------------------------------------------------ 3. risk-tier drift

export function classify(config, file) {
    let best = null;
    for (const t of config.tiers) {
        if (matchesAny(t.paths, file) && (best === null || t.tier < best.tier)) {
            best = t;
        }
    }
    return best ?? config.tiers.find((t) => t.tier === config.default_tier);
}

const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

export function parseTierTable(markdown) {
    const rows = [];
    for (const raw of markdown.split(/\r?\n/)) {
        if (!/^\|\s*\d+\s*\|/.test(raw)) continue;
        const cells = raw.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (cells.length !== 5) {
            rows.push({ malformed: raw });
            continue;
        }
        rows.push({
            tier: Number(cells[0]),
            name: cells[1],
            paths: ticks(cells[2]),
            commands: ticks(cells[3]),
            review: ticks(cells[4])[0] ?? cells[4],
        });
    }
    return rows;
}

const diff = (a, b) => a.filter((x) => !b.includes(x));

export function checkRiskTiers(config, markdown) {
    const v = [];
    const doc = 'docs/risk-tiers.md';
    const json = 'risk-config.json';
    if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
        return [`${json}: "tiers" must be a non-empty array`];
    }
    const nums = config.tiers.map((t) => t.tier);
    if (new Set(nums).size !== nums.length) {
        v.push(`${json}: duplicate tier numbers`);
    }
    if (!nums.includes(config.default_tier)) {
        v.push(`${json}: default_tier ${config.default_tier} is not a defined tier`);
    }
    const rows = parseTierTable(markdown);
    for (const r of rows.filter((r) => r.malformed)) {
        v.push(`${doc}: malformed tier row "${r.malformed}" (need 5 columns)`);
    }
    const docRows = rows.filter((r) => !r.malformed);
    for (const t of config.tiers) {
        const row = docRows.find((r) => r.tier === t.tier);
        if (!row) {
            v.push(`${doc}: tier ${t.tier} (${t.name}) is in ${json} but not in the table`);
            continue;
        }
        if (row.name !== t.name) {
            v.push(`${doc}: tier ${t.tier} is named "${row.name}", ${json} says "${t.name}"`);
        }
        const sets = [
            ['paths', row.paths, t.paths],
            ['required commands', row.commands, t.required_commands],
        ];
        for (const [label, d, j] of sets) {
            for (const x of diff(j, d)) {
                v.push(`${doc}: tier ${t.tier} ${label}: "${x}" is in ${json} but not in the table`);
            }
            for (const x of diff(d, j)) {
                v.push(`${doc}: tier ${t.tier} ${label}: "${x}" is in the table but not in ${json}`);
            }
        }
        if (row.review !== t.review) {
            v.push(`${doc}: tier ${t.tier} review is "${row.review}", ${json} says "${t.review}"`);
        }
    }
    for (const r of docRows) {
        if (!nums.includes(r.tier)) {
            v.push(`${doc}: tier ${r.tier} is in the table but not in ${json}`);
        }
    }
    return v;
}

// ------------------------------------------------------------------- main

export function checkAll(root) {
    const violations = [];
    const files = walk(root);

    const fork = readJson(root, 'policies/fork-target.json', violations);
    if (fork) violations.push(...checkForkTarget(root, fork, files));

    const wf = readJson(root, 'policies/workflow-permissions.json', violations);
    if (wf) violations.push(...checkWorkflows(root, wf, files));

    const config = readJson(root, 'risk-config.json', violations);
    const docPath = path.join(root, 'docs/risk-tiers.md');
    if (!fs.existsSync(docPath)) {
        violations.push('docs/risk-tiers.md: missing');
    } else if (config) {
        violations.push(
            ...checkRiskTiers(config, fs.readFileSync(docPath, 'utf8')),
        );
    }
    return violations;
}

function main(argv) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    let root = path.resolve(here, '..');
    const rootIdx = argv.indexOf('--root');
    if (rootIdx !== -1) root = path.resolve(argv[rootIdx + 1]);

    const classifyIdx = argv.indexOf('--classify');
    if (classifyIdx !== -1) {
        const config = JSON.parse(
            fs.readFileSync(path.join(root, 'risk-config.json'), 'utf8'),
        );
        for (const p of argv.slice(classifyIdx + 1)) {
            const t = classify(config, p.replace(/^\.\//, ''));
            console.log(`${p}: tier ${t.tier} (${t.name}), review: ${t.review}`);
        }
        return 0;
    }

    const violations = checkAll(root);
    if (violations.length > 0) {
        console.error(`check-policies: ${violations.length} violation(s)`);
        for (const x of violations) console.error(`  ${x}`);
        return 1;
    }
    console.log('check-policies: all policies satisfied');
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exit(main(process.argv.slice(2)));
}
