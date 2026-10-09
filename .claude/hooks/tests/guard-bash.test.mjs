// Tests for .claude/hooks/guard-bash.mjs. Each case spawns the hook exactly
// as Claude Code does: JSON on stdin, decision from the exit code (0 allow,
// 2 block) and stderr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../guard-bash.mjs', import.meta.url));

function run(command, toolName = 'Bash') {
    const input = JSON.stringify({ tool_name: toolName, tool_input: { command } });
    return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
}

const allowed = [
    'gh pr view 3',
    'gh pr list --state open',
    'gh issue view 21 --json title',
    'gh pr checks 5',
    'gh run view 123 --log-failed',
    'gh api repos/chrisvel/tududi/issues',
    'gh api -X GET repos/chrisvel/tududi/pulls -f state=open',
    'gh api -X POST repos/Danathar/tududi/issues -f title=x',
    'gh api repos/Danathar/tududi/issues/1/comments -f body=hi',
    'gh pr create --repo Danathar/tududi --base main --head b',
    'gh pr create -R Danathar/tududi --title t',
    'gh pr create --repo=danathar/tududi --title t',
    'GH_REPO=Danathar/tududi gh issue create --title t --body b',
    'export GH_REPO=Danathar/tududi; gh issue comment 4 --body ok',
    'cd x && gh pr create --repo Danathar/tududi --base main --head b',
    'gh repo set-default Danathar/tududi',
    'gh repo set-default --view',
    'gh pr comment 4 --repo Danathar/tududi --body "forked from chrisvel/tududi, kept in sync"',
    'echo "do not run gh pr create against chrisvel/tududi"',
    'gh pr view 3 --json title --jq ".title" # chrisvel/tududi',
    'git push origin HEAD',
    'git push -u origin acmm/claude-guard',
    'git -C ../wt push origin main',
    'git fetch upstream',
    'git remote set-url --push upstream DISABLE',
    'git status && git diff --stat',
    'npm run lint',
    'cat <<EOF\ngh pr create\nEOF',
    'git commit -m "$(cat <<\'EOF\'\nuse gh pr create --repo Danathar/tududi\nEOF\n)"',
];

const blocked = [
    ['gh pr create', 'no --repo'],
    ['gh pr create --title t --body b', 'no --repo'],
    ['gh pr create -R chrisvel/tududi', 'chrisvel/tududi'],
    ['gh pr create --repo chrisvel/tududi --base main', 'chrisvel/tududi'],
    ['gh pr create --repo https://github.com/chrisvel/tududi', 'chrisvel/tududi'],
    ['GH_REPO=chrisvel/tududi gh issue create --title t', 'chrisvel/tududi'],
    ['gh issue create --title t', 'no --repo'],
    ['gh issue comment 3 --body hi', 'no --repo'],
    ['gh issue close 3', 'no --repo'],
    ['gh pr merge 9 --squash', 'no --repo'],
    ['gh release create v1', 'no --repo'],
    ['gh workflow run ci.yml', 'no --repo'],
    ['gh label create bug', 'no --repo'],
    ['gh repo fork chrisvel/tududi', 'chrisvel/tududi'],
    ['gh repo sync chrisvel/tududi', 'chrisvel/tududi'],
    ['gh repo set-default chrisvel/tududi', 'set-default'],
    ['gh api -X POST repos/chrisvel/tududi/issues -f title=x', 'repos/Danathar/tududi'],
    ['gh api repos/chrisvel/tududi/issues -f title=x', 'repos/Danathar/tududi'],
    ['gh api --method=DELETE repos/chrisvel/tududi/issues/1', 'repos/Danathar/tududi'],
    ['gh api -X PATCH /user -f name=x', 'repos/Danathar/tududi'],
    ['gh api graphql -f query=\'mutation { addStar(input:{starrableId:"x"}) { clientMutationId } }\'', 'mutation'],
    ['git push upstream main', 'origin'],
    ['git push', 'explicit remote'],
    ['git push https://github.com/chrisvel/tududi.git main', 'origin'],
    ['git push --force origin main', 'force'],
    ['git push -f origin main', 'force'],
    ['git push origin +main', 'force'],
    ['git push origin main --force-with-lease', 'force'],
    ['git push --mirror origin', 'mirror'],
    ['git remote set-url --push upstream https://github.com/chrisvel/tududi.git', 'set-url'],
    ['git remote set-url origin https://github.com/chrisvel/tududi.git', 'origin'],
    // Compound commands, subshells, wrappers.
    ['git status && gh pr create --title t', 'no --repo'],
    ['git status; gh issue create --title t', 'no --repo'],
    ['true | gh pr comment 1 --body x', 'no --repo'],
    ['(cd x && gh pr create)', 'no --repo'],
    ['echo $(gh issue create --title t)', 'no --repo'],
    ['echo `gh issue create --title t`', 'no --repo'],
    ['echo "$(gh issue create --title t)"', 'no --repo'],
    ['bash -c "gh pr create --title t"', 'no --repo'],
    ['sh -lc \'git push upstream main\'', 'origin'],
    ['eval "gh pr create"', 'no --repo'],
    ['env FOO=1 gh pr create', 'no --repo'],
    ['FOO=1 gh pr create', 'no --repo'],
    ['xargs -n1 gh pr close', 'no --repo'],
    ['gh pr create \\\n  --title t', 'no --repo'],
    ['git push origin main && git push upstream main', 'origin'],
];

for (const command of allowed) {
    test(`allows: ${command.replace(/\n/g, '\\n')}`, () => {
        const r = run(command);
        assert.equal(r.status, 0, `expected allow, got ${r.status}: ${r.stderr}`);
    });
}

for (const [command, fragment] of blocked) {
    test(`blocks: ${command.replace(/\n/g, '\\n')}`, () => {
        const r = run(command);
        assert.equal(r.status, 2, `expected block, got ${r.status}`);
        assert.match(r.stderr, /guard-bash: /);
        assert.ok(
            r.stderr.toLowerCase().includes(fragment.toLowerCase()),
            `stderr should mention "${fragment}": ${r.stderr}`
        );
        assert.match(r.stderr, /Danathar\/tududi/);
    });
}

test('ignores non-Bash tools', () => {
    assert.equal(run('gh pr create', 'Edit').status, 0);
});

test('empty command is allowed', () => {
    assert.equal(run('').status, 0);
});

test('malformed hook input fails closed', () => {
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /fail/i);
});
