# 0.1.0 Windows 验收记录

验收日期：2026-10-21。Node.js 22.18.0，npm 10.9.3。许可证 MIT。

## 实现与本机迁移

- 独立 npm 包及全局命令 `weapp` 已实现，本机全局安装版本为 `0.1.0`。
- 已提供显式安装向导、共享/复制/仅 CLI 模式、四 Agent 多选、JSON 和 dry-run。
- `skills list/sync/uninstall`、`update`、扩展 `doctor` 已实现；安装记录、内容校验、备份、事务恢复与回滚分别管理。
- 本机旧技能已完整备份，包括运行脚本、参考资料、原依赖和手工内容；备份位置记录在本地安装结果中。
- 共享目录已迁移为轻量 Skill，Claude Code 创建了逐技能 Junction；其他三个目标使用共享根发现。
- 未保留旧 `scripts/weapp.mjs` 入口。未执行 npm publish、远程仓库创建、commit 或 push。

## 自动化与分发验证

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 自动化单元与集成测试 | **158/158 通过** | 迁入的运行时测试，以及安装器、回滚、恢复、生命周期、依赖兼容测试 |
| npm 分发与 Windows 隔离场景 | **9/9 通过** | 真实 npm 进程与本地只读 registry；不是已发布到公共 registry 的验收 |
| npx 安装入口 | 通过 | 固定运行版本 0.1.0；即使 registry latest 为 0.1.1，也先安装准确版本再交接 |
| 全局安装后显式 install | 通过 | `--ignore-scripts` 下仍能接入四 Agent；CLI 不依赖 postinstall |
| 升级交接 | 通过 | 使用临时 0.1.1 测试产物，确认由新进程同步新 Skill 内容；未修改正式源码版本 |
| 共享/复制/卸载 | 通过 | 共享根、Junction、四份文档副本、显式共享源清理及 npx 独立清理 |
| 终端启动脚本 | 通过 | npm 生成的 cmd、PowerShell shim；覆盖中文、空格及括号路径 |
| 真实交互向导 | 通过 | 选择共享模式、四 Agent 多选、目录输入、计划预览和最终取消；取消后无记录或技能目录写入 |
| 发布内容检查 | 通过 | 40 个发布文件；白名单、资源完整性与个人路径/凭据形状检查 |

本地明细：

- [单元测试输出](../.artifacts/unit-tests.txt)
- [Windows 隔离安装报告](../.artifacts/windows-acceptance.json)
- [终端交互记录](../.artifacts/interactive-acceptance.json)
- [打包内容](../.artifacts/package-contents.json)

上述 `.artifacts` 证据保留在本机，不包含在 npm 包或源码提交中。

## 四 Agent 验证边界

| Agent | 当前证据 | 尚未声称通过的内容 |
| --- | --- | --- |
| Codex 0.147.0 | 实际 app-server 的 `skills/list` 已发现并启用新 Skill，无本技能解析错误 | 未发送模型任务或执行聊天中的工具调用 |
| DeepSeek Harness 0.1.2-rc.1 | 已安装的官方 filesystem provider 发现共享 Skill、加载正文，确认正文使用全局 `weapp` | 未确认已有桌面聊天的缓存是否已刷新 |
| VS Code 1.142.0 / Copilot 0.70.0 | 已识别内置 `GitHub.copilot-chat`，共享文件可读，接入记录健康 | 当前 Copilot 聊天需重载后确认实际加载与调用 |
| Claude Code 2.1.176 | 命令存在，Junction 与 Skill 正文可读，接入记录健康 | 当前 Claude 会话需重载后确认 `/weapp-automation` 与工具调用 |

全局 CLI 在当前 Windows shell 可用；文件落盘、实际技能发现及聊天工具调用分别记录，没有将文件存在当作四个客户端均已执行成功。

详细结果：[Agent 发现记录](../.artifacts/agent-discovery.json)、[本机接入状态](../.artifacts/installed-skills.json)。

## 微信开发者工具只读实测

最终使用用户明确指定并打开的 `s-miniprogram` 编译项目。当前页面保持原状，未调用业务提交、导航或 mock。

- 全局 CLI 正常连接，运行 appid 与项目配置一致。
- 页面读取、数据键列表和原生元素尺寸读取成功。
- 整页模拟器截图 **390 × 844**。
- 稳定元素裁剪 **259 × 45**，连续两次截图比较 **0 个差异像素、0% 差异**，尺寸一致。
- 脚本清理结果中无 mock 残留或失败。

这证明模拟器中的连接、读取、截图和元素 baseline 回归通过；没有声称业务功能验收、物理手势、Android/iOS 真机或 macOS 已通过。

详细结果：[开发者工具报告](../.artifacts/devtools-acceptance.json)、[元素基线完整结果](../.artifacts/current-project-baseline.json)。早期临时项目的超时记录仅保留为诊断，不作为最终通过证据。

复测现有项目时，使用独立 PowerShell 会话设置以下环境变量后运行 `node scripts/devtools-acceptance.mjs`：

```powershell
$env:WEAPP_ACCEPTANCE_PROJECT = '<已编译项目目录>'
$env:WEAPP_ACCEPTANCE_ENTRY = '<全局包目录>/bin/weapp.mjs'
$env:WEAPP_ELEMENT_SELECTOR = '<当前页稳定且可见的元素选择器>'
node scripts/devtools-acceptance.mjs
```

指定项目后该脚本只 attach 和读取，不生成或改写用户项目，也不导航。未指定项目时会生成独立空白 fixture；它是否能在本机自动编译仍依赖开发工具环境。

## 依赖与兼容限制

- 保留 `miniprogram-automator 0.13.0`、`pixelmatch 5.3.0`、`pngjs 7.0.0`。
- 用兼容补丁固定 minimist 0.2.4、jpeg-js 0.4.4、debug 4.3.4，并通过参数解析、PNG/JPEG 往返、mkdirp 和 SDK-facing API 验证。
- registry 安装场景确认发布的 shrinkwrap 保留上述版本；本机未发布 tarball 安装后也已通过包目录内 `npm ci` 恢复同一锁定树。
- 官方 registry 审计：**0 critical、0 high、0 low，5 moderate 受影响节点**。剩余节点来自同一个 phin 旧版重定向头部泄露公告；未为消除数字而替换不兼容的 callback API。
- npm 10 对文件 tarball manifest 的处理不会提供 registry shrinkwrap 标记，未发布 tarball 的锁定树补充步骤见 README。
- npm 的 Windows CMD shim 对 prefix 中的 `& | < > ^ %` 不可靠；显式安装器会在写入前拒绝这种 prefix，不修改 npm 配置或重写 shim。
- Windows 验收已执行，macOS 无环境，标记待验证。

审计明细：[dependency-audit.json](../.artifacts/dependency-audit.json)。
