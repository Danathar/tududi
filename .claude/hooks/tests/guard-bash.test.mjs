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
    'gh pr create -R Danathar/tududi --base main --head b --title t',
    'gh pr --repo Danathar/tududi create --base=main --head=b --title t',
    'gh pr create --repo=danathar/tududi -B main -H b --title t',
    'GH_REPO=Danathar/tududi gh issue create --title t --body b',
    'GH_REPO=Danathar/tududi gh pr create --base main --head b',
    'git remote add upstream https://github.com/chrisvel/tududi.git',
    'git remote remove upstream',
    'export GH_REPO=Danathar/tududi; gh issue comment 4 --body ok',
    'cd x && gh pr create --repo Danathar/tududi --base main --head b',
    'gh repo set-default Danathar/tududi',
    'gh repo set-default --view',
    'gh pr comment 4 --repo Danathar/tududi --body "forked from chrisvel/tududi, kept in sync"',
    'echo "do not run gh pr create against chrisvel/tududi"',
    'gh pr view 3 --json title --jq ".title" # chrisvel/tududi',
    "gh pr view 3 --jq 'chrisvel/tududi'",
    'gh issue list --search "chrisvel/tududi"',
    'git remote set-url origin https://github.com/Danathar/tududi',
    'gh api graphql -f query=\'query($o:String!){ repository(owner:$o,name:"tududi"){ id } }\' -f o=Danathar',
    'gh discussion list --repo chrisvel/tududi',
    'gh auth status',
    'git config rename-section foo bar',
    'git config set --value zzz user.name x',
    'git config --global push.autoSetupRemote true',
    'git config push.default current',
    'git config get remote.origin.url',
    'git config list',
    'git config -f .git/config user.name x',
    'git -c push.default=current push origin main',
    'gh pr create --repo Danathar/tududi --base main --head b --body "-Bump deps" --title "-Hx"',
    'git config --get remote.origin.url',
    'git config remote.origin.url',
    'git config user.name x',
    'env FOO=1 git status',
    'env -u FOO git status',
    'gh alias list',
    'gh search issues foo',
    'git -c user.name=x commit -m msg',
    "env -S 'gh pr view 3'",
    'git remote add -t main upstream https://github.com/chrisvel/tududi.git',
    'gh pr create --repo Danathar/tududi --base develop --base main --head b',
    'gh codespace list',
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
    ['gh -R chrisvel/tududi pr create', 'chrisvel/tududi'],
    ['gh --repo chrisvel/tududi issue create --title t', 'chrisvel/tududi'],
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
    ['git remote set-url origin https://github.com/someone-else/tududi.git', 'origin'],
    ['gh discussion create --repo chrisvel/tududi --title t', 'chrisvel/tududi'],
    ['gh discussion comment 3 --body x', 'no --repo'],
    ["sh -c -- 'gh pr create'", 'no --repo'],
    ["bash -c -- 'git push upstream main'", 'origin'],
    ['gh api graphql --input payload.json', 'graphql'],
    ['gh api graphql -F query=@payload.graphql', 'graphql'],
    ['gh api graphql -f query="$Q"', 'graphql'],
    ['gh codespace create -R chrisvel/tududi', 'chrisvel/tududi'],
    ['gh somenewgroup create --repo someone/else', 'allowlist'],
    ['gh somenewgroup sync chrisvel/tududi', 'allowlist'],
    ['gh issue create -R Danathar/tududi -R someone/other --title x', 'someone/other'],
    ['gh issue create --repo Danathar/tududi --repo=chrisvel/tududi', 'chrisvel/tududi'],
    ['git remote remove origin && git remote add origin https://github.com/chrisvel/tududi.git', 'origin'],
    ['git remote rm origin', 'origin'],
    ['git remote rename upstream origin', 'origin'],
    ['git remote rename origin old', 'origin'],
    ['git remote add origin https://github.com/someone/other.git', 'origin'],
    ['gh pr create --repo Danathar/tududi --title t', '--base main'],
    ['gh pr create --repo Danathar/tududi --base develop --head b', '--base main'],
    ['gh pr create --repo Danathar/tududi --base main', '--head'],
    ['gh issue create -R chrisvel/tududi -R Danathar/tududi --title t', 'chrisvel/tududi'],
    // Duplicate flags: gh and git honour the last one.
    ['gh pr create --repo Danathar/tududi --base main --base develop --head b', '--base main'],
    ['gh pr create --repo Danathar/tududi --base main --head b --head ""', '--head'],
    // Option values must not be mistaken for remote names.
    ['git remote add -t main origin https://github.com/someone/other.git', 'origin'],
    ['git remote add -m main origin https://github.com/chrisvel/tududi.git', 'origin'],
    // git config / env overrides that redirect pushes.
    ['git -c remote.origin.url=https://github.com/chrisvel/tududi push origin main', 'redirect'],
    ['git -c url.https://github.com/chrisvel/.insteadOf=https://github.com/Danathar/ push origin main', 'redirect'],
    ['git -c remote.origin.pushurl=x push origin main', 'redirect'],
    ['git -c core.sshCommand=evil push origin main', 'redirect'],
    ['git --config-env=remote.origin.url=URL push origin main', 'redirect'],
    ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=x git push origin main', 'redirect'],
    // env -S command strings.
    ["env -S 'gh pr create --title t'", 'no --repo'],
    ["env --split-string='git push upstream main'", 'origin'],
    ["env -Sgh\\ issue\\ create", 'no --repo'],
    // Unknown gh groups and aliases fail closed.
    ['gh alias set pc "pr create --repo chrisvel/tududi"', 'allowlist'],
    ['gh extension install foo/bar', 'allowlist'],
    ['env -S "FOO=1" gh issue create --title t', 'no --repo'],
    ['env -S "GH_PROMPT_DISABLED=1" gh pr create --repo chrisvel/tududi --base main --head x', 'chrisvel/tududi'],
    ['env FOO=1 gh issue create --repo chrisvel/tududi --title -Sx', 'chrisvel/tududi'],
    ['env sudo -S git push upstream main', 'origin'],
    ['gh pr create --repo Danathar/tududi --base main --head b -Bdevelop', '--base main'],
    ['gh pr create --repo Danathar/tududi --base main --head b -H', '--head'],
    ['git config remote.origin.url https://github.com/chrisvel/tududi.git && git push origin main', 'could redirect'],
    ['git config --global url.https://github.com/chrisvel/.insteadOf https://github.com/Danathar/', 'could redirect'],
    ['git config --unset remote.origin.pushurl', 'could redirect'],
    ['git config --edit', 'could redirect'],
    ['export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url; git push origin main', 'redirect'],
    ['git config set remote.origin.url https://github.com/chrisvel/tududi.git', 'could redirect'],
    ['git config unset remote.origin.pushurl', 'could redirect'],
    ['git config replace-all url.x.insteadOf y', 'could redirect'],
    ['git config remove-section remote.origin', 'could redirect'],
    ['git config edit', 'could redirect'],
    ['git config -f .git/config remote.origin.url https://github.com/chrisvel/tududi.git', 'could redirect'],
    ['git config --file=x --type bool remote.origin.url v', 'could redirect'],
    ['gh pr create --repo Danathar/tududi --base main --head b --title t -Bdevelop', '--base main'],
    ['declare -x GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url; git push origin main', 'redirect'],
    ['git config set --value zzz remote.origin.url https://github.com/chrisvel/tududi.git', 'could redirect'],
    ['git config --url=x --value zzz remote.origin.url v', 'could redirect'],
    ['git config set --url https://example.com remote.origin.pushurl v', 'could redirect'],
    ['git config rename-section foo remote.origin', 'rename-section'],
    ['git config --rename-section foo remote.origin', 'rename-section'],
    ['git config rename-section remote.origin foo', 'could redirect'],
    // Compound commands, subshells, wrappers.
    ['git status && gh pr create --title t', 'no --repo'],
    ['git status; gh issue create --title t', 'no --repo'],
    ['true | gh pr comment 1 --body x', 'no --repo'],
    ['(cd x && gh pr create)', 'no --repo'],
    ['echo $(gh issue create --title t)', 'no --repo'],
    ['echo `gh issue create --title t`', 'no --repo'],
    ['echo "$(gh issue create --title t)"', 'no --repo'],
    [`echo "$(printf ')'; gh pr create)"`, 'no --repo'],
    ['echo $(echo "(" ; gh issue create --title t)', 'no --repo'],
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
