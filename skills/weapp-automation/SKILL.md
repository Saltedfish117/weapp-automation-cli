---
name: weapp-automation
description: 驱动微信开发者工具执行小程序自动化检查：页面导航、原生节点和数据断言、交互、截图基线、wx API mock 及可复现脚本。适用于小程序回归、模拟器走查与布局取证；H5 和 PC 页面使用浏览器自动化工具。
compatibility: Requires weapp-automation-cli >=0.1.0 <0.2.0, Node.js >=22 and WeChat DevTools with its service port enabled. Windows verified separately; macOS pending validation.
metadata:
  short-description: 微信小程序自动化 CLI 与可审计验收
---

# weapp-automation

通过全局 `weapp` 命令调用 `miniprogram-automator`。Skill 目录只含说明和参考资源，不含运行时代码或依赖。缺少命令时，让用户安装 `weapp-automation-cli` 并确认 npm 全局 bin 在 Agent 的 PATH 中；不要在 Skill 目录运行 npm install。

## 开始检查

```bash
weapp --version
weapp doctor --project /path/to/miniprogram
weapp page --project /path/to/miniprogram --attach-only
weapp shot --project /path/to/miniprogram --attach-only --out shots/current.png
```

- 首先确认项目与端口。优先 `--project`，其次 `WEAPP_PROJECT`、最近的 `.weapp.json` 和 `project.config.json`；端口默认 9420，可用 `--port` 或 `WEAPP_PORT` 指定。
- uni-app 项目先有编译产物；CLI 会解析 `miniprogramRoot` 或常见 `mp-weixin` 编译目录。不要把源码目录存在当作项目已就绪。
- 只读现场检查用 `--attach-only`；未运行即失败，不启动、不重启。确需启动时运行 `weapp up --project ...`。
- 每次调用独立连接并退出；普通命令不会关闭开发者工具。只有显式 `up --restart` 允许关闭后重启。不要清除活锁或重启其他会话占用的工具。
- 当前项目 appid 与运行项目不匹配时停止；仅在确认目标后使用 `--allow-other-project`。

## 命令选择

| 目的 | 命令 |
| --- | --- |
| 查看全部自动化命令 | `weapp help` |
| 页面与状态 | `page`、`stack`、`data [path]`、`eval <expression>` |
| 导航 | `open`、`navigate`、`redirect`、`switch-tab`、`back` |
| 元素与交互 | `find`、`find-all`、`find-text`、`tap`、`tap-text`、`input`、`trigger` |
| 等待和实际节点验收 | `wait-for`、`probe`、`assert-nodes --spec @file`、`ready --spec @file` |
| 滚动 | `scroll`、`scroll-observe --spec @file`、`swipe <selector> --spec @file` |
| 截图与基线 | `shot --out file.png`、`--selector`、`--baseline`、`--mask`、`--update-baseline` |
| 其他 | `mock`、`restore`、`native`、`audit`、`run scenario.mjs`、`lock status` |

PowerShell 传 JSON 使用 `@file`；直接嵌套双引号容易被 shell 改写。交互采用唯一选择器，必要时添加 `--index`、`--strict --within <unique-container>`。

## 如何解释证据

- 业务命令 stdout 是一个 JSON 信封，日志在 stderr。退出码：0 成功、1 运行错误、2 断言/视觉失败、3 开发者工具不可达、4 参数/配置错误；检查 `ok` 和退出码。
- 数据、路由到达、元素存在和 `tapped:true` 都不能单独证明业务或渲染成功。验证操作后的明确状态和实际节点；不明接口字段先查对应项目的接口文档。
- 虚拟列表检查业务 key、实际原生 rect/style/content 和视口覆盖；不能只检查 page.data 或 visibleKeys。详见 [实际渲染验收](references/rendered-state.md)。
- `scroll` 是程序滚动；`swipe` 只是 SDK 手势尝试。未测出实际位移或可信输入时必须标记未覆盖。详见 [滚动与证据](references/scroll-and-evidence.md)。
- 导航后重新 `await ctx.page()`；`ctx.currentPage` 只是连接快照。交互后等待实际业务状态，避免固定 sleep 作为唯一验收依据。
- 截图只覆盖模拟器视口；原生面板可能不在截图内。裁剪和视口判断以 `shot` 返回的 `viewport` 为准；`page.size()` 可能包含整页内容高度，不代表截图视口。不假定固定机型，也不把模拟器结果声称为真机结果。
- 结果预览可能截断；检查截断路径和原始数量。需要完整数据用 `--result-out evidence/full.json`，父目录须存在。
- 截图、baseline 和故障证据可能包含敏感信息，使用受控本地输出目录；敏感页面可 `--no-diagnostics`。不要写入 CLI 或 Skill 安装目录。

## 按需读取

- 编写或运行场景脚本：[run 上下文与清理](references/run-context.md)。`run` 默认恢复它设置的 mock；保留 mock 需显式 `--keep-mocks`。
- 处理截图、动态遮罩或元素 baseline：[视觉检查](references/visual-testing.md)。元素 baseline 使用同一裁剪图；动态区域先稳定或遮罩，不能盲目使用严格像素阈值。
- 查询 SDK 能力与限制：[Automator API](references/automator-api.md)。

## 接入诊断

`weapp skills list --json` 查看安装状态，`weapp skills sync --dry-run --json` 预览文档同步。Skill 文件存在只证明接入已准备，不代表当前 Agent 已加载；按安装器提示重载后检查。CLI、依赖和安装管理属于 npm 包，不要恢复旧 `scripts/weapp.mjs` 绝对路径调用。
