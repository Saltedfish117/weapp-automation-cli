# weapp-automation-cli

[简体中文](#简体中文) | [English](#english)

## 简体中文

通过命令行控制微信开发者工具，运行小程序自动化脚本。配套 Skill 支持 Codex、
DeepSeek Harness、VS Code 中的 GitHub Copilot 和 Claude Code，安装后可供这些 Agent 调用。

需要 Node.js **22+**。0.1.0 已在 Windows 验收；macOS 的路径和命令入口做了兼容处理，
但还没有实测。

使用前请自行安装微信开发者工具，准备可运行的小程序项目，并开启开发者工具的服务端口。
需要微信登录时，请在开发者工具中完成。

### 安装

```bash
npx weapp-automation-cli@latest install
```

也可以先全局安装，再运行向导。

```bash
npm i -g weapp-automation-cli
weapp install
```

向导会检测本机的 Agent，供你多选。执行前会列出安装路径和包版本，确认后才写入。
单独运行 `npm install` 不会修改 Agent 配置，包也没有交互式 `postinstall`。

安装时可选择以下模式。

- **共享目录**只存放一份 Skill，默认在 `~/.agents/skills/weapp-automation`。
  Codex、DSH 和支持该目录的 VS Code 版本会直接读取它；Claude Code 通过单个 Skill
  的目录链接读取。也可以自定义共享目录，安装器会按需为所选 Agent 建立链接。
  Windows 使用 Junction。
- **分别复制**会把 Skill 说明文档放进各 Agent 的 Skills 目录。它们调用同一个
  `weapp` 命令，不重复安装依赖。
- **仅 CLI**只安装终端命令，不添加 Agent Skills。

即使没在向导中选中某个 Agent，它仍可能读到共享目录中的 Skill。已有用户内容会保留，
除非你选择**备份后替换**。

| Agent 标识 | 默认复制目录 |
| --- | --- |
| `codex` | `$CODEX_HOME/skills/weapp-automation`（`CODEX_HOME` 默认 `~/.codex`） |
| `deepseek-harness` | `$DSH_HOME/skills/weapp-automation`（`DSH_HOME` 默认 `~/.dsh`） |
| `vscode-copilot` | `~/.copilot/skills/weapp-automation` |
| `claude-code` | `$CLAUDE_CONFIG_DIR/skills/weapp-automation`（`CLAUDE_CONFIG_DIR` 默认 `~/.claude`） |

DSH 还会根据 `DSH_AGENTS_HOME` 查找共享 Skill。检测 Copilot 时，安装器会检查用户扩展
和 VS Code 内置的 `GitHub.copilot-chat`，不会仅凭 VS Code 已安装就判断 Copilot 可用。
登录状态、扩展是否启用，以及 Skill 是否加载，还需要在对应客户端确认。

### 非交互式安装

```bash
weapp install --mode shared --agents codex,deepseek-harness,claude-code --dry-run --json
weapp install --mode shared --agents codex,deepseek-harness,claude-code --yes
weapp install --mode copy --agents vscode-copilot --yes
weapp install --mode shared --agents claude-code --shared-dir /path/to/skills --yes
weapp install --mode copy --agents codex --agent-dir codex=/custom/skills --yes
```

没有交互终端（TTY）时，需要用 `--yes` 确认写入，并指定安装目标。`--yes` 不会自动
选择检测到的 Agent。可以先用 `--dry-run` 查看计划，它不会创建 Skill 目录、安装记录、
锁或备份。不过 npx 在启动 CLI 前，仍可能下载包到自己的缓存。

JSON 模式向 stdout 输出一个 JSON 结果，日志和 npm 进度写入 stderr。

遇到同名或改过的 Skill，先检查内容，再决定是否加 `--conflict backup`。安装器会先完整
备份，再替换。之前由本工具安装、内容未变的 Skill 会直接复用。要降级全局包，需要加上
`--allow-downgrade`。

### 小程序自动化

```bash
weapp --version
weapp help
weapp doctor --project /path/to/miniprogram
weapp up --project /path/to/miniprogram
weapp page --attach-only
weapp shot --out shots/current.png --attach-only
weapp run /path/to/scenario.mjs --project /path/to/miniprogram --attach-only
```

CLI 按 `--project`、`WEAPP_PROJECT`、最近的 `.weapp.json`、最近的 `project.config.json`
的顺序查找项目。端口默认是 9420，可用 `--port` / `WEAPP_PORT` 修改。
开发者工具 CLI 路径可用 `--cli` / `WEAPP_CLI` 指定。

uni-app 项目请指向编译后的 `mp-weixin` 目录，不能直接用源码目录运行。

自动化命令输出一个 JSON 结果，退出码见下表。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 运行时或生命周期操作失败 |
| 2 | 断言失败或视觉对比不匹配 |
| 3 | 开发者工具不可达或忙碌 |
| 4 | 参数或配置无效 |

取消安装或维护操作时，退出码为 130，Skill 目标保持原样。普通命令不会关闭开发者工具，
只有 `up --restart` 会重启它。不同 Agent 和不同位置安装的 CLI 共用同一套端口锁。

PowerShell 中建议用 `@file` 传入 JSON，避免嵌套引号。

交互是否成功要看业务结果，不能只看点击是否发出。页面数据和画面也需要分别检查。
程序滚动不能代替真实手势，模拟器截图也不能作为真机验收结果。用法和检查建议见
[Skill](skills/weapp-automation/SKILL.md) 及其中的参考资料。

### 管理 Skill 与升级

```bash
weapp skills list --json
weapp skills sync --dry-run --json
weapp skills sync --yes
weapp update --yes
weapp update --version 0.1.0 --dry-run --json
```

`sync` 把当前 CLI 自带的 Skill 资源同步到已安装的位置，不升级 npm 包。
`update` 会确定要安装的版本，安装后由新版本同步已登记的 Skill。CLI 升级和 Skill 同步
如果失败，会分别报告。直接通过 npm 升级后，记得运行 `weapp skills sync`。

文件完整、命令可用、开发者工具就绪和 Agent 加载成功，需要分别确认。看到重载提示时，
还需要在客户端重载并检查 Skill 是否加载。

安装前请先处理 PATH 中的同名命令冲突。本工具不修改 shell 配置、npm prefix、registry
或 PATH。

### 卸载与恢复

```bash
weapp skills uninstall --agents claude-code --dry-run --json
weapp skills uninstall --agents claude-code --yes
weapp skills uninstall --remove-shared --yes
npm uninstall -g weapp-automation-cli
```

默认保留共享源文件，只有加上 `--remove-shared` 才会删除；如果还有其他 Agent 的安装
记录引用它，安装器会拒绝删除。只移除某个 Agent 的登记，无法阻止它继续扫描共享目录。
卸载会保留并报告用户改过的内容和无关文件；移除目录链接时，只删链接本身。

安装清单、完整备份和事务日志保存在 `~/.weapp-automation/`。如果操作中断，下次写入前
会尝试恢复。恢复过程中发现目标已被修改时，会留下文件供你手动处理。

CLI 已卸载也可以清理 Skill，无需重新全局安装包，运行
`npx weapp-automation-cli@0.1.0 skills uninstall --yes` 即可。

`npm uninstall` 不会清理 Agent 目录，备份也会保留，方便手动恢复。安装记录不存储凭据。
旧的 `node .../skills/weapp-automation/scripts/weapp.mjs` 入口已停用，请改用 `weapp`。

使用独立用户目录或做隔离验收时，可以用 `WEAPP_USER_HOME` 指定安装器的用户根目录，
用 `WEAPP_STATE_DIR` 指定安装记录目录。这两个变量不会改变操作系统的用户主目录。
VS Code 装在非标准位置时，可用 `WEAPP_VSCODE_ROOT` 指定应用目录。状态目录应单独
存放，不要指向用户主目录本身、包目录或 Skill 安装目录。

### 开发与发布

`npm-shrinkwrap.json` 锁定了依赖版本，包括 `minimist`、`jpeg-js` 和 `debug` 的兼容修复。
原有三项自动化依赖保持指定版本。旧版 SDK 依赖的 `phin` 仍有上游中危公告，验收报告中
有记录。它使用回调 API，直接替换成新大版本会破坏兼容性。

用 npm 10 安装未发布的本地 tarball 时，包信息中没有 registry 提供的 shrinkwrap 标记。
安装后可以运行 `npm ci --ignore-scripts --omit=dev --prefix <installed-package-directory>`，
按包内的锁定文件重新安装依赖。通过 registry 安装的两种流程已单独验证。

Windows 的 npm CMD 启动脚本无法可靠处理全局 prefix 中的 `&`、`|`、`<`、`>`、`^` 和 `%`。
安装器会在写入 Skill 前拒绝这些路径。中文、空格和括号路径已通过验收；本工具不会改写
npm 启动脚本或用户配置。

```bash
npm ci
npm test
npm run check-package
npm pack --pack-destination .artifacts
```

源码和测试在本仓库维护。npm 包只包含命令入口、运行时、安装器、Skill 资源、示例和
公开文档，没有安装或卸载钩子。项目使用 MIT 许可证，第三方依赖声明见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

源码、版本 tag 和问题反馈在 [GitHub](https://github.com/Saltedfish117/weapp-automation-cli)，
每个版本的改动见 [更新日志](https://github.com/Saltedfish117/weapp-automation-cli/blob/main/CHANGELOG.md)。

## English

Control WeChat DevTools from the command line and run mini-program automation
scripts. The included skill supports Codex, DeepSeek Harness, GitHub Copilot in
VS Code, and Claude Code.

Requires Node.js **22+**. Version 0.1.0 has been tested on Windows. The code accounts
for macOS paths and entrypoints, but macOS has not been tested yet.

Before you start, install WeChat DevTools, prepare a runnable mini-program project,
and enable the DevTools service port. If WeChat sign-in is needed, complete it in
DevTools.

### Install

```bash
npx weapp-automation-cli@latest install
```

Or install globally, then run the setup wizard.

```bash
npm i -g weapp-automation-cli
weapp install
```

The wizard detects agents on your machine, lets you select more than one, and
shows the paths and package version before asking you to confirm. Running
`npm install` alone does not change agent configuration. The package has no
interactive `postinstall`.

Choose an installation mode.

- **Shared** keeps one skill at `~/.agents/skills/weapp-automation` by default.
  Codex, DSH and supported VS Code versions read it directly; Claude Code uses a
  directory link for this skill. You can choose a custom shared directory, and
  the installer adds links for the selected agents where needed. Windows uses
  Junctions.
- **Copy** puts the skill documentation in each selected agent's skills directory.
  Each copy uses the same `weapp` command without duplicating dependencies.
- **CLI only** installs the terminal command without adding Agent Skills.

An agent can still discover skills in a shared directory even if you did not
select it in the wizard. Existing content stays in place unless you choose
**back up and replace**.

| Agent id | Default copy directory |
| --- | --- |
| `codex` | `$CODEX_HOME/skills/weapp-automation` (`CODEX_HOME` defaults to `~/.codex`) |
| `deepseek-harness` | `$DSH_HOME/skills/weapp-automation` (`DSH_HOME` defaults to `~/.dsh`) |
| `vscode-copilot` | `~/.copilot/skills/weapp-automation` |
| `claude-code` | `$CLAUDE_CONFIG_DIR/skills/weapp-automation` (`CLAUDE_CONFIG_DIR` defaults to `~/.claude`) |

DSH also uses `DSH_AGENTS_HOME` to find shared skills. For Copilot, the installer
checks user extensions and VS Code's bundled `GitHub.copilot-chat`, rather than
assuming Copilot is available because VS Code is installed. Check sign-in,
extension activation and skill loading in the client itself.

### Non-interactive installation

```bash
weapp install --mode shared --agents codex,deepseek-harness,claude-code --dry-run --json
weapp install --mode shared --agents codex,deepseek-harness,claude-code --yes
weapp install --mode copy --agents vscode-copilot --yes
weapp install --mode shared --agents claude-code --shared-dir /path/to/skills --yes
weapp install --mode copy --agents codex --agent-dir codex=/custom/skills --yes
```

Without an interactive terminal (TTY), confirm writes with `--yes` and specify
the installation targets. `--yes` does not select detected agents for you.
Use `--dry-run` to review the plan without creating skill directories, records,
locks or backups. npx may still download packages into its own cache before the
CLI starts.

JSON mode writes one JSON result to stdout. Logs and npm progress go to stderr.

Review any existing or modified skill before adding `--conflict backup`. The
installer makes a full backup before replacing it. Skills already installed by
this tool are reused if unchanged. Downgrading a global package requires
`--allow-downgrade`.

### Automation

```bash
weapp --version
weapp help
weapp doctor --project /path/to/miniprogram
weapp up --project /path/to/miniprogram
weapp page --attach-only
weapp shot --out shots/current.png --attach-only
weapp run /path/to/scenario.mjs --project /path/to/miniprogram --attach-only
```

The CLI looks for a project in this order, using `--project`, `WEAPP_PROJECT`,
the nearest `.weapp.json`, then the nearest `project.config.json`. The port
defaults to 9420; change it with `--port` / `WEAPP_PORT`. Set the DevTools CLI
path with `--cli` / `WEAPP_CLI`.

For uni-app, point to the compiled `mp-weixin` directory. The source directory
cannot be used directly.

Automation commands return one JSON result and use the exit codes below.

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Runtime or lifecycle failure |
| 2 | Assertion or visual mismatch |
| 3 | DevTools unreachable or busy |
| 4 | Invalid arguments or configuration |

Canceling an installation or maintenance command exits with code 130 and leaves
skill targets unchanged. Ordinary commands do not close DevTools. Only
`up --restart` restarts it. Agents and separate CLI installations share the same
port lock.

In PowerShell, use `@file` to pass JSON without nested quotes.

After an interaction, check the business result, not just whether a tap was sent.
Check page data and the rendered page separately. Programmatic scrolling does not
replace physical gestures, and simulator screenshots do not establish device
acceptance. See the packaged [Skill](skills/weapp-automation/SKILL.md) and its
references for usage and testing guidance.

### Manage skills and update

```bash
weapp skills list --json
weapp skills sync --dry-run --json
weapp skills sync --yes
weapp update --yes
weapp update --version 0.1.0 --dry-run --json
```

`sync` copies the current CLI's skill resources to their installed locations
without upgrading the npm package. `update` resolves and installs a specific
version, then runs that version to sync registered skills. CLI update failures
and skill-sync failures are reported separately. If you upgrade with npm
directly, remember to run `weapp skills sync`.

Check file integrity, CLI availability, DevTools readiness and agent loading
separately. If the installer suggests a reload, reload the client and check that
the skill is available.

Resolve conflicting commands on PATH before installation. This tool does not
change your shell profile, npm prefix, registry or PATH.

### Uninstall and recover

```bash
weapp skills uninstall --agents claude-code --dry-run --json
weapp skills uninstall --agents claude-code --yes
weapp skills uninstall --remove-shared --yes
npm uninstall -g weapp-automation-cli
```

Shared source files stay in place unless you pass `--remove-shared`. The installer
refuses to remove them if another agent's installation record still references
them. Removing one agent's registration does not stop it from scanning shared
directories. Uninstall keeps and reports modified content and unrelated files.
When removing a directory link, it deletes only the link.

Installation manifests, full backups and transaction journals are stored in
`~/.weapp-automation/`. If an operation is interrupted, recovery runs before the
next write. Recovery leaves modified targets in place for you to handle manually.

If the CLI is already uninstalled, run
`npx weapp-automation-cli@0.1.0 skills uninstall --yes` to clean registered skills
without reinstalling the global package.

`npm uninstall` does not clean agent directories. Backups stay available for
manual recovery, and installation records do not store credentials. The old
`node .../skills/weapp-automation/scripts/weapp.mjs` entrypoint is no longer
supported; use `weapp` instead.

For isolated testing or a separate user directory, set `WEAPP_USER_HOME` to the
installer's user root and `WEAPP_STATE_DIR` to the records directory. These do not
change the operating system's home directory. Use `WEAPP_VSCODE_ROOT` if VS Code
is installed in a nonstandard location. Keep the state directory separate from
the home root, package directory and skill installation directories.

### Development and release

`npm-shrinkwrap.json` pins dependency versions, including compatible fixes for
`minimist`, `jpeg-js`, and `debug`. The three original automation dependencies
keep their specified versions. The legacy SDK's `phin` dependency still has an
upstream moderate advisory, recorded in the acceptance report. Replacing its
callback API with a newer major version would break compatibility.

When npm 10 installs an unpublished local tarball, the package metadata lacks the
shrinkwrap marker supplied by the registry. After installing, run
`npm ci --ignore-scripts --omit=dev --prefix <installed-package-directory>` to
reinstall dependencies from the included lockfile. Both registry installation
flows have been tested separately.

On Windows, npm's CMD shims cannot reliably handle `&`, `|`, `<`, `>`, `^`, or `%`
in a global prefix. The installer rejects these paths before writing skills.
Chinese text, spaces and parentheses have passed testing. This tool does not
rewrite npm's shims or your npm configuration.

```bash
npm ci
npm test
npm run check-package
npm pack --pack-destination .artifacts
```

Source and tests are maintained in this repository. The npm package contains only
the CLI entrypoint, runtime, installer, skill resources, examples and public
documentation, with no install or uninstall hooks. The project is MIT licensed;
dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Find the source, version tags and issue tracker on
[GitHub](https://github.com/Saltedfish117/weapp-automation-cli). See the
[changelog](https://github.com/Saltedfish117/weapp-automation-cli/blob/main/CHANGELOG.md)
for each version's changes.
