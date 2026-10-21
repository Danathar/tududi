// Tests for .claude/hooks/guard-bash.mjs. Each case spawns the hook exactly
// as Claude Code does: JSON on stdin, decision from the exit code (0 allow,
// 2 block) and stderr.
import { test } from 'node:test';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide } from '../guard-bash.mjs';

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
    // Repo-scoped writes pass only when the fork is named: as the positional
    // repo, with --repo/-R, or through GH_REPO.
    'gh repo edit Danathar/tududi --description x',
    'gh repo edit https://github.com/Danathar/tududi.git --enable-wiki=false',
    'gh repo sync Danathar/tududi',
    'gh repo deploy-key add key.pub -R Danathar/tududi',
    'gh repo autolink create JIRA- https://example.com/<num> --repo Danathar/tududi',
    'GH_REPO=Danathar/tududi gh repo edit --description x',
    'export GH_REPO=Danathar/tududi; gh repo deploy-key add key.pub',
    // A shell running a script file (no -c) has no inline command to inspect.
    'bash scripts/create-version.sh',
    'sh -n scripts/create-version.sh',
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
    'git config --show-origin --list',
    'git config --show-scope --get remote.origin.url',
    'git config get --show-origin remote.origin.url',
    'env FOO=1 git status',
    'env -u FOO git status',
    // Wrapper option values are skipped, not taken for the command.
    'env -a X git status',
    'exec -a X git status',
    'sudo -u X git status',
    'sudo -h',
    'time -p npm test',
    '/usr/bin/time -v npm test',
    // An option value that is a command name, with nothing left to run.
    'env -u gh -u pr',
    'timeout -s gh',
    // A wrapper without its own option table still finds the command.
    'command -p git status',
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
    // The auto-approved test and read-only git commands in their normal forms (#65, #69).
    'node --test .claude/hooks/tests/guard-bash.test.mjs',
    'node --test scripts/tests/check-policies.test.mjs .claude/hooks/tests/guard-bash.test.mjs',
    'node --test --test-reporter=spec --test-name-pattern "fork" .claude/hooks/tests/guard-bash.test.mjs',
    'node --test --test-reporter tap --test-reporter-destination stdout scripts/tests/check-policies.test.mjs',
    'node scripts/check-policies.mjs',
    'node scripts/check-policies.mjs -p',
    'node --version',
    'npm test',
    'npm test --silent',
    'npm test -- --coverage',
    'npm run backend:test -- tests/unit/foo.test.js',
    'npm run frontend:test -- -t "renders the list" --runInBand',
    'npm run backend:test -- --testPathPattern=tests/integration --maxWorkers=2',
    'npm run test:ui',
    'npm run frontend:lint',
    'git log --oneline -20',
    'git log -p -- .claude/hooks',
    'git log -S"Order" --oneline',
    'git diff --stat HEAD~1',
    'git show HEAD --stat',
    'git branch -a',
    'git checkout --ours backend/app.js',
    'GIT_PAGER=cat git log -1',
    'GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=y git commit -m msg',
    'git -c color.ui=always diff',
    'env FOO=1 npm test',
    "git ls-files '*.js' | xargs grep -l TODO",
    // flock, watch, taskset, chrt, unshare and find in front of a command this
    // hook does not check are left alone.
    'flock /tmp/l make test',
    'watch -n 2 ls -la',
    "find . -name '*.js' -exec grep -n flock {} +",
    'find . -name node_modules -prune -o -type f -print',
    'taskset -c 0 make',
    "timeout 5 git log --grep 'find . -exec git diff'",
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
    ['gh repo edit --visibility public', 'without an explicit Danathar/tududi target'],
    ['gh repo sync', 'without an explicit Danathar/tududi target'],
    ['gh repo deploy-key add key.pub', 'without an explicit Danathar/tududi target'],
    ['gh repo edit Danathar/tududi-mirror --description x', 'without an explicit Danathar/tududi target'],
    ['gh repo create Danathar/scratch --public', 'without an explicit Danathar/tududi target'],
    ['gh repo deploy-key add key.pub -R someone/other', 'without an explicit Danathar/tududi target'],
    ['GH_REPO=someone/other gh repo edit --description x', 'without an explicit Danathar/tududi target'],
    ['gh repo deploy-key add key.pub --title Danathar/tududi', 'without an explicit Danathar/tududi target'],
    // A bare new name is not a repo target.
    ['gh repo rename tududi', 'without an explicit Danathar/tududi target'],
    // A fork name that is a flag value is not the repo gh will act on.
    ['gh repo edit --description Danathar/tududi', 'without an explicit Danathar/tududi target'],
    ['gh repo edit -d Danathar/tududi --visibility public', 'without an explicit Danathar/tududi target'],
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
    // The words after the -S string are appended to it once, in every spelling.
    ['env -S gh pr merge 1', 'no --repo'],
    ['env -Sgh pr merge 1', 'no --repo'],
    ['env --split-string gh pr merge 1', 'no --repo'],
    ['env --split-string=gh pr merge 1', 'no --repo'],
    // A wrapper option's value is not the command it runs: `env -u git gh ...`
    // unsets $git and runs gh; `exec -a gh` only names $0.
    ['env -u git gh pr merge 1', 'no --repo'],
    ['env -iu git gh pr merge 1', 'no --repo'],
    ['env --uns git gh pr merge 1', 'no --repo'],
    ['env -C git gh pr merge 1', 'no --repo'],
    ['env -a git gh pr merge 1', 'no --repo'],
    ['env --argv0 git gh pr merge 1', 'no --repo'],
    ['exec -a git gh pr merge 1', 'no --repo'],
    ['/usr/bin/time -o git gh pr merge 1', 'no --repo'],
    // The same for every wrapper with an option table, short and long spellings.
    ['timeout -s git 5 gh pr merge 1', 'no --repo'],
    ['timeout --kill-after git 5 gh pr merge 1', 'no --repo'],
    ['nice -n git gh pr merge 1', 'no --repo'],
    ['nice --adjustment git gh pr merge 1', 'no --repo'],
    ['stdbuf -o git gh pr merge 1', 'no --repo'],
    ['stdbuf --output git gh pr merge 1', 'no --repo'],
    ['ionice -c git gh pr merge 1', 'no --repo'],
    // --class is an exact name even though it is also a prefix of --classdata.
    ['ionice --class git gh pr merge 1', 'no --repo'],
    ['xargs -a git gh pr merge 1', 'no --repo'],
    ['xargs --arg-file git gh pr merge 1', 'no --repo'],
    ['/usr/bin/time --output git gh pr merge 1', 'no --repo'],
    // sudo's own option values (-u USER, -g GROUP, -D DIR, -C NUM) are not the command.
    ['sudo -u git gh pr merge 1', 'no --repo'],
    ['sudo --user git gh pr merge 1', 'no --repo'],
    ['sudo -g git gh pr merge 1', 'no --repo'],
    ['sudo -D git git push --force origin main', 'force'],
    ['sudo -C git gh pr merge 1', 'no --repo'],
    ['sudo -u git gh pr create --repo chrisvel/tududi --title t --body b', 'chrisvel/tududi'],
    ['sudo -u git git push upstream main', 'origin'],
    // sudo -h takes its host only from the same word, so `git` here is the command.
    ['sudo -hgit gh pr merge 1', 'no --repo'],
    ['env --chdir git gh pr merge 1', 'no --repo'],
    // A value joined with = does not consume the next word.
    ['env --unset=git gh pr merge 1', 'no --repo'],
    // xargs -i takes its value only from the same word, so `d` is not -d.
    ['xargs -id gh pr merge 1', 'no --repo'],
    // `--` ends the wrapper's options; the next word is the command.
    ['env -- gh pr merge 1', 'no --repo'],
    ['nice -- gh pr merge 1', 'no --repo'],
    // A nested exec is read with its own options.
    ['nice exec -a git gh pr merge 1', 'no --repo'],
    // -S packed after other options, abbreviated, after a value, or behind another wrapper.
    ["env -iS'gh pr merge 1'", 'no --repo'],
    ["env --sp='gh pr merge 1'", 'no --repo'],
    ["env -a X -S'git push --force origin main'", 'force'],
    ["timeout 5 env -S'gh pr merge 1'", 'no --repo'],
    ["nice env -S'git push --force origin main'", 'force'],
    // The `time` keyword's -p / -- before the command.
    ['time -p gh pr merge 1', 'no --repo'],
    ['time -p -- gh pr merge 1', 'no --repo'],
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
    ['git config rename-section foo core', 'rename-section'],
    // --show-origin/--show-scope only change how a read is printed; git 2.47
    // still writes `key value` with --show-scope, so they do not make it a read.
    ['git config --show-scope remote.origin.url https://github.com/someone/other.git', 'could redirect'],
    ['git config --show-origin remote.origin.url https://github.com/someone/other.git', 'could redirect'],
    ['git config --show-scope url.https://github.com/someone/.insteadOf https://github.com/Danathar/', 'could redirect'],
    ['git config set --show-scope remote.origin.pushurl https://github.com/someone/other.git', 'could redirect'],
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

// Code execution / file writes through auto-approved commands (#65, #69).
// [command, fragment of the expected stderr]
const blockedLocal = [
    // node: code-loading flags, under --test and outside it.
    ["node --test --import 'data:text/javascript,1' t.test.mjs", 'allowlist'],
    ['node --test --require ./x.js t.test.mjs', 'allowlist'],
    ['env -u git npm test -- --require ./x.js', 'allowlist'],
    ['exec -a git npm test -- --require ./x.js', 'allowlist'],
    ['sudo -u git npm test -- --require ./x.js', 'allowlist'],
    ['nohup env -a node npm test -- --require ./x.js', 'allowlist'],
    ['time -p npm test -- --require ./x.js', 'allowlist'],
    ['/usr/bin/time -f git npm test -- --require ./x.js', 'allowlist'],
    ['node --test --env-file=.env t.test.mjs', 'allowlist'],
    ['node --inspect=0.0.0.0:9229 --test t.test.mjs', 'allowlist'],
    ['node --test --test-reporter ./evil.mjs t.test.mjs', 'reporter'],
    ['node --test --test-reporter-destination=.claude/hooks/guard-bash.mjs t.test.mjs', 'destination'],
    ['node --test /tmp/evil.test.mjs', 'outside the checkout'],
    ['node --test ../evil.test.mjs', 'outside the checkout'],
    ['node -e "require(\'fs\').readFileSync(\'.env\')"', '-e'],
    ['node -pe 1', '-pe'],
    ['node --eval=1', '--eval'],
    ['node --env-file=.env scripts/check-policies.mjs', '--env-file'],
    ['node -C dev --import=data:x app.js', '--import'],
    ['nodejs -r ./x.js app.js', '-r'],
    ['env node --import=data:x app.js', '--import'],
    // npm: --node-options, NODE_OPTIONS and friends.
    ['npm test --node-options=--import=data:text/javascript,1', '--node-options'],
    ['npm run frontend:test --node-options=--require=./anyfile.js', '--node-options'],
    ['npm run backend:test --node_options=--import=data:x', '--node_options'],
    ['NODE_OPTIONS=--import=data:text/javascript,1 npm test', 'NODE_OPTIONS'],
    ['export NODE_OPTIONS=--require=./x.js; npm test', 'NODE_OPTIONS'],
    ['env NODE_OPTIONS=--import=x npm test', 'NODE_OPTIONS'],
    ['NODE_OPTIONS+=--import=x npm test', 'NODE_OPTIONS'],
    ['npm_config_node_options=--import=x npm test', 'npm_config_node_options'],
    ['BASH_ENV=./evil.sh npm run test:ui', 'BASH_ENV'],
    ['PATH=/tmp/evil:$PATH npm test', 'PATH'],
    ['npm test --script-shell=./evil.sh', '--script-shell'],
    ['npm --prefix /tmp/evil test', '--prefix'],
    // npm expands any unambiguous prefix of a config key, so the denied
    // options are still reachable abbreviated (#73 closed only the full names).
    ['npm test --node-opt=--import=data:text/javascript,1', '--node-opt'],
    ['npm test --node-o=--require=./x.js', '--node-o'],
    ['npm run backend:test --node-o=--import=data:x', '--node-o'],
    ['npm test --script-sh=./evil.sh', '--script-sh'],
    ['npm test --userconf=/tmp/evil.npmrc', '--userconf'],
    ['npm test --globalconf=/tmp/evil.npmrc', '--globalconf'],
    ['npm test -- --config \'{"globalSetup":"/tmp/x.js"}\'', 'allowlist'],
    ['npm run backend:test -- --outputFile=.claude/hooks/guard-bash.mjs --json', 'allowlist'],
    ['npm run frontend:test -- --setupFiles ./x.js', 'allowlist'],
    ['npm test -- /tmp/evil.test.js', 'outside the checkout'],
    ['npm test -- --rootDir=/', 'allowlist'],
    // git: file writes and file reads past the Read/Write rules.
    ["git log -1 --format='x' --output=.claude/hooks/guard-bash.mjs", 'writes a file'],
    ['git diff --output .claude/settings.json HEAD', 'writes a file'],
    ['git show HEAD --output=LICENSE.MIT', 'writes a file'],
    ['git log --outp=x', 'writes a file'],
    ['git format-patch -1 -o .claude/hooks', '-o'],
    ['git format-patch -1 --output-directory=.claude', 'writes a file'],
    ['git diff --no-index /dev/null .env', 'no-index'],
    ['git diff -O.env HEAD', '-O'],
    ['git log --orderfile=.env -p', 'orderfile'],
    ['bash -c "git log --output=x"', 'writes a file'],
    // git: environment and config that run programs.
    ['GIT_EXTERNAL_DIFF=./evil.sh git diff HEAD~1 HEAD', 'GIT_EXTERNAL_DIFF'],
    ['GIT_PAGER=./evil.sh git log', 'GIT_PAGER'],
    ['PAGER="sh -c id" git log', 'PAGER'],
    ['export GIT_PAGER=./evil.sh; git log', 'GIT_PAGER'],
    ['env GIT_CONFIG_PARAMETERS="\'core.pager=./evil.sh\'" git log', 'GIT_CONFIG_PARAMETERS'],
    ['GIT_TRACE=/tmp/x git status', 'GIT_TRACE'],
    ['git -c core.pager=./evil.sh log', 'core.pager'],
    ['git -c core.fsmonitor=./evil.sh status', 'core.fsmonitor'],
    ['git -c diff.external=./evil.sh diff', 'diff.external'],
    ['git config core.fsmonitor ./evil.sh', 'core.fsmonitor'],
    ['git config alias.st "!sh evil"', 'alias.st'],
    ['git --exec-path=/tmp/evil log', 'exec-path'],
    // xargs appends run-time words no argument check sees.
    ["printf '%s\\n' --output=/home/u/.bashrc | xargs git log -1 --format=format:x", 'xargs git'],
    ["printf '%s\\n' /dev/null .env | xargs git diff", 'xargs git'],
    ['xargs -a args.txt git show', 'xargs git'],
    ["echo --import=data:text/javascript,0 | xargs -n9 node --test", 'xargs node'],
    ["echo --node-options=--import=data:text/javascript,0 | xargs npm test", 'xargs npm'],
    ['find . -name x | xargs -I{} timeout 5 git diff {}', 'xargs git'],
    // A wrapper in front of xargs does not hide it.
    ["printf '%s\\n' --output=/home/u/.bashrc | nice xargs git log -1", 'xargs git'],
    ["printf '%s\\n' /dev/null .env | timeout 5 xargs git diff", 'xargs git'],
    ["echo --import=data:text/javascript,0 | nohup xargs node --test", 'xargs node'],
    // flock, watch, taskset, chrt, unshare and find run a command whose own
    // options this hook does not model, so a checked command behind them is
    // refused whatever its arguments are.
    ['flock /tmp/l git diff --no-index /dev/null .env', '`flock` runs `git`'],
    ['flock -n /tmp/l git diff HEAD', '`flock` runs `git`'],
    ["flock /tmp/l -c 'git diff --no-index /dev/null .env'", '`flock` runs `git`'],
    ["flock /tmp/l -c'git diff --no-index /dev/null .env'", '`flock` runs `git`'],
    ["flock /tmp/l --command='git diff --no-index /dev/null .env'", '`flock` runs `git`'],
    ['watch git diff --no-index /dev/null .env', '`watch` runs `git`'],
    ["watch -n 1 'git diff --no-index /dev/null .env'", '`watch` runs `git`'],
    ['taskset -c 0 git diff --no-index /dev/null .env', '`taskset` runs `git`'],
    ['chrt -f 1 git diff --no-index /dev/null .env', '`chrt` runs `git`'],
    ['chrt -o +0 git diff --no-index /dev/null .env', '`chrt` runs `git`'],
    ['chrt -o -- -0 git diff --no-index /dev/null .env', '`chrt` runs `git`'],
    ['find . -maxdepth 0 -exec git diff --no-index /dev/null .env \\;', '`find` runs `git`'],
    ['find / -maxdepth 0 -execdir git diff etc/passwd etc/hostname \\;', '`find` runs `git`'],
    ['find . -name x -ok /usr/bin/git diff {} \\;', '`find` runs `git`'],
    ['unshare -r git diff --no-index /dev/null .env', '`unshare` runs `git`'],
    ['unshare --wd=/ git diff etc/passwd etc/hostname', '`unshare` runs `git`'],
    ['/usr/bin/flock /tmp/l npm test', '`flock` runs `npm`'],
    ["watch 'node -e 1'", '`watch` runs `node`'],
    ['nice -n 5 taskset -c 0 git log', '`taskset` runs `git`'],
    ["printf '%s\\n' /dev/null .env | xargs flock /tmp/l git diff", '`flock` runs `git`'],
    ["bash -c 'flock /tmp/l git diff --no-index /dev/null .env'", '`flock` runs `git`'],
    // A shell or eval behind one of them is refused by name too, even when no
    // checked command follows it in this string.
    ['flock /tmp/l bash ./scripts/x.sh', '`flock` runs `bash`'],
    ['flock /tmp/l eval "$CMD"', '`flock` runs `eval`'],
    // A command string handed to `sh -c` is cut at each piece of shell
    // punctuation and at quotes, so the checked command is found right next to
    // any of them.
    ["watch 'cd /;git diff --no-index /dev/null .env'", '`watch` runs `git`'],
    ["watch 'true&&git diff --no-index /dev/null .env'", '`watch` runs `git`'],
    ["watch 'false||git diff --no-index /dev/null .env'", '`watch` runs `git`'],
    ["watch '(git diff --no-index /dev/null .env)'", '`watch` runs `git`'],
    ["watch 'case x in x)git diff --no-index /dev/null .env;; esac'", '`watch` runs `git`'],
    ["watch 'git</dev/null diff --no-index /dev/null .env'", '`watch` runs `git`'],
    ["watch 'git>/tmp/o diff --no-index /dev/null .env'", '`watch` runs `git`'],
    ["watch 'echo `git diff --no-index /dev/null .env`'", '`watch` runs `git`'],
    ['watch "\'git\' diff --no-index /dev/null .env"', '`watch` runs `git`'],
    ['watch \'"git" diff --no-index /dev/null .env\'', '`watch` runs `git`'],
    // A path to the command in the string is reported by its name.
    ["watch '/usr/bin/git diff --no-index /dev/null .env'", '`watch` runs `git`'],
    // The value can follow any letter of a short-option cluster, not only the
    // first.
    ["flock /tmp/l -nc'git diff --no-index /dev/null .env'", '`flock` runs `git`'],
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

for (const [command, fragment] of blockedLocal) {
    test(`blocks: ${command.replace(/\n/g, '\\n')}`, () => {
        const r = run(command);
        assert.equal(r.status, 2, `expected block, got ${r.status}`);
        assert.match(r.stderr, /guard-bash: /);
        assert.ok(r.stderr.includes(fragment), `stderr should mention "${fragment}": ${r.stderr}`);
        assert.match(r.stderr, /SECURITY-AI\.md/);
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

test('internal errors exit 2 (fail closed), not 1', () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    const r = decide(payload, () => {
        throw new Error('boom');
    });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /internal error \(boom\); blocking \(fail closed\)/);
});

test('hook still blocks when invoked through a symlinked path', () => {
    const dir = mkdtempSync(join('/var/tmp', 'guard-bash-link-'));
    try {
        const link = join(dir, 'hooks-link');
        symlinkSync(dirname(HOOK), link);
        const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr create --title t' } });
        const r = spawnSync(process.execPath, [join(link, 'guard-bash.mjs')], { input, encoding: 'utf8' });
        assert.equal(r.status, 2, `expected block via symlink, got ${r.status}: ${r.stderr}`);
        assert.match(r.stderr, /no --repo/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('hook still blocks when the script file itself is a symlink', () => {
    const dir = mkdtempSync(join('/var/tmp', 'guard-bash-link-'));
    try {
        const link = join(dir, 'guard.mjs');
        symlinkSync(HOOK, link);
        const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push upstream main' } });
        const r = spawnSync(process.execPath, [link], { input, encoding: 'utf8' });
        assert.equal(r.status, 2, `expected block via file symlink, got ${r.status}: ${r.stderr}`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
