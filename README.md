# weapp-automation-cli

WeChat DevTools automation CLI with installable Agent Skills for **Codex,
DeepSeek Harness, GitHub Copilot in VS Code, and Claude Code**.

Version 0.1.0 targets Node.js **22+**. Windows is the first acceptance platform;
macOS paths and entrypoints are designed for portability but remain **unverified**.
WeChat DevTools, a runnable mini-program project, and its service port must be
prepared separately. This package does not install DevTools or log in to WeChat.

## Install

```bash
npx weapp-automation-cli@latest install
```

Alternatively:

```bash
npm i -g weapp-automation-cli
weapp install
```

The explicit installer detects supported agents, offers multi-selection, displays
the actual paths and package version, and asks before applying changes. npm install
itself does not modify agent configuration and needs no interactive postinstall.

Choose one mode:

- **Shared**: one skill at `~/.agents/skills/weapp-automation`. Codex, DSH and
  supported VS Code versions discover the shared root; Claude Code receives a
  per-skill directory link. A custom shared root is connected through per-skill
  links where needed. On Windows these links are Junctions.
- **Copy**: lightweight documentation in each selected agent's own skills root.
  All copies invoke the same `weapp` CLI; dependencies are not duplicated.
- **CLI only**: install the terminal command without Agent Skills.

Shared visibility is not an access control boundary: an unselected agent that
natively scans the shared root can still discover the skill. Existing user
content is preserved unless you explicitly choose **back up and replace**.

| Agent id | Default copy directory |
| --- | --- |
| `codex` | `$CODEX_HOME/skills/weapp-automation` (default `~/.codex`) |
| `deepseek-harness` | `$DSH_HOME/skills/weapp-automation` (default `~/.dsh`) |
| `vscode-copilot` | `~/.copilot/skills/weapp-automation` |
| `claude-code` | `$CLAUDE_CONFIG_DIR/skills/weapp-automation` (default `~/.claude`) |

DSH's shared discovery also respects `DSH_AGENTS_HOME`. Copilot detection checks
both user extensions and VS Code's bundled `GitHub.copilot-chat`; application
installation alone is not treated as Copilot installation. Detection is not
evidence of sign-in, extension activation, or successful skill loading.

## Non-interactive installation

```bash
weapp install --mode shared --agents codex,deepseek-harness,claude-code --dry-run --json
weapp install --mode shared --agents codex,deepseek-harness,claude-code --yes
weapp install --mode copy --agents vscode-copilot --yes
weapp install --mode shared --agents claude-code --shared-dir /path/to/skills --yes
weapp install --mode copy --agents codex --agent-dir codex=/custom/skills --yes
```

Without a TTY, writes require `--yes` and explicit targets. `--yes` never selects
all detected agents. `--dry-run` does not create skill folders, records, locks or
backups; npx itself may download packages into its own cache before the CLI runs.
JSON output is a single envelope on stdout; logs and npm progress use stderr.

Use `--conflict backup` only after reviewing a same-name or modified skill. It
stores a complete backup before replacement. Repeated installations reuse
unchanged managed targets. A newer global version is not downgraded unless
`--allow-downgrade` is explicit.

## Automation

```bash
weapp --version
weapp help
weapp doctor --project /path/to/miniprogram
weapp up --project /path/to/miniprogram
weapp page --attach-only
weapp shot --out shots/current.png --attach-only
weapp run /path/to/scenario.mjs --project /path/to/miniprogram --attach-only
```

Project precedence: `--project`, `WEAPP_PROJECT`, the nearest `.weapp.json`, then
the nearest `project.config.json`. Port defaults to 9420 (`--port` / `WEAPP_PORT`).
DevTools CLI can be supplied by `--cli` / `WEAPP_CLI`. uni-app requires compiled
`mp-weixin` output; source directory existence alone is insufficient.

Automation commands preserve one JSON envelope and these exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Runtime or lifecycle failure |
| 2 | Assertion or visual mismatch |
| 3 | DevTools unreachable or busy |
| 4 | Invalid arguments or configuration |

Lifecycle cancellation exits 130 without changing skill targets. Ordinary
commands never close DevTools; only `up --restart` explicitly restarts it.
The port lock is shared across agents and package installations.

In PowerShell, pass JSON with `@file` rather than nested quotes. Validate business
state after interactions: a sent tap is not business success, page data is not
rendered-state evidence, programmatic scroll is not a real gesture, and simulator
screenshots are not device acceptance. See the packaged
[Skill](skills/weapp-automation/SKILL.md) and linked references for full guidance.

## Manage skills and update

```bash
weapp skills list --json
weapp skills sync --dry-run --json
weapp skills sync --yes
weapp update --yes
weapp update --version 0.1.0 --dry-run --json
```

`sync` uses the running CLI's packaged resources without upgrading npm packages.
`update` installs an exact resolved version, hands off to it, then synchronizes
registered skills. CLI update and skill-sync failures are reported separately.
After upgrading with npm directly, run `weapp skills sync` yourself.

File health, CLI availability, DevTools readiness and actual Agent loading are
separate results. A reload hint is not a claim that the agent already loaded the
skill. Resolve PATH conflicts before installation; the tool does not edit your
shell profile, npm prefix, registry or PATH.

## Uninstall and recover

```bash
weapp skills uninstall --agents claude-code --dry-run --json
weapp skills uninstall --agents claude-code --yes
weapp skills uninstall --remove-shared --yes
npm uninstall -g weapp-automation-cli
```

Without `--remove-shared`, shared source files are retained. Removing only one
registration cannot disable an agent's native discovery. A shared source still
registered by other targets cannot be removed. Modified content and unrelated
files are preserved and reported. Directory-link removal unlinks the link itself.

Manifests, full replacement backups and transaction journals live under
`~/.weapp-automation/`. Interrupted transactions are recovered before the next
write; changed recovery targets are preserved for manual attention. If the CLI
was already removed, `npx weapp-automation-cli@0.1.0 skills uninstall --yes` can
clean registered skills without reinstalling the global package.

npm uninstall does not clean external Agent directories. Backups are retained
for deliberate manual recovery; installation records never store credentials.
Old `node .../skills/weapp-automation/scripts/weapp.mjs` calls are not forwarded.

For isolated acceptance or a dedicated user directory, `WEAPP_USER_HOME` supplies
the installer user root and `WEAPP_STATE_DIR` overrides the records directory.
These do not change the operating-system home. `WEAPP_VSCODE_ROOT` can identify
a nonstandard VS Code application root. Do not point the state directory at a
home root, the package directory or a skill installation directory.

## Development and release

The published `npm-shrinkwrap.json` pins the dependency tree, including compatible
fixes for `minimist`, `jpeg-js`, and `debug`. The three original automation
dependencies keep their specified versions. The legacy SDK's callback-based
`phin` dependency still has an upstream moderate advisory; it is recorded in the
acceptance report rather than replaced with an incompatible major API.

For an unpublished tarball on npm 10, npm's file-spec manifest does not advertise
the registry shrinkwrap marker. After the tarball install, running `npm ci
--ignore-scripts --omit=dev --prefix <installed-package-directory>` enforces the
same frozen tree. The registry-based installation paths are validated separately.

On Windows, npm-generated CMD shims cannot reliably use global prefixes
containing `&`, `|`, `<`, `>`, `^`, or `%`. The explicit installer rejects these
prefixes before applying skills. Chinese text, spaces and parentheses are covered
by acceptance. This tool does not rewrite npm's shims or your npm configuration.

```bash
npm ci
npm test
npm run check-package
npm pack --pack-destination .artifacts
```

Runtime source and tests are maintained in this repository; published tarballs
include only the bin, runtime/installer, Skill resources, examples and public
documentation. The package has no install or uninstall hooks. MIT licensed;
dependency notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Source, tagged versions and issue tracking are available on
[GitHub](https://github.com/Saltedfish117/weapp-automation-cli). See the
[changelog](https://github.com/Saltedfish117/weapp-automation-cli/blob/main/CHANGELOG.md)
for release notes.
