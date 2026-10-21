# run 上下文契约

`node weapp.mjs run <script.mjs>` 在 CLI 进程内 import 脚本；脚本必须 `export default async (ctx) => ...` 或导出命名 `run`。返回的 JSON 进入 CLI 信封的 `data.result`。

## 最小可运行模板

```js
// scenario.mjs
export default async (ctx) => {
  const { mp, assert, shot, log, sleep, signal } = ctx;

  // 导航后一定用函数取当前页；ctx.currentPage 是连接时的快照。
  const page = await ctx.page();
  const data = await page.data();
  log(`page=${page.path}`);
  assert(data.list !== undefined, 'list 字段缺失');

  await shot('shots/home.png', {
    selector: '.example-card',
    index: 0,
    pad: 8,
    baseline: 'shots/base',
    threshold: 0.1,
    settleMs: 200,
  });

  if (signal.aborted) return { aborted: true };
  await sleep(100);
  return { path: page.path, total: data.total ?? null };
};
```

运行：

```powershell
weapp run scenario.mjs --run-timeout 120000
```

## ctx 字段

| 字段 | 说明 |
|---|---|
| `mp` | 原始 `MiniProgram`；普通 `close()` 被禁用（exit 2 `close-disabled`） |
| `page()` | 异步函数，返回当前 `Page`；导航后用这个 |
| `currentPage` | 连接时的页面快照，导航后可能已过期 |
| `shot(path, options)` | 截图/裁剪/基线；失败抛 exit 2，成功返回 data（含 `viewport`/`cropped`/`baseline`） |
| `assert(cond, msg)` | 条件不成立抛 exit 2 |
| `log(...)` | 写 stderr（推荐） |
| `sleep(ms)` | 延时 |
| `sanitize(value)` | 去掉函数/循环，Date/Map/Set/Buffer 转可 JSON 值 |
| `config` | 解析后的 project/miniprogramRoot/appid/cliPath/port 等 |
| `flags` | 原始 CLI flags |
| `mode` | `attached` 或 `launched` |
| `signal` | `AbortSignal`；`--run-timeout` 超时后 abort |
| `step(name, fn, {timeoutMs})` | 有名步骤/耗时/路由；失败时保存状态与尝试截图，截图失败记warning |
| `probe(options)` | 只读实际原生rect/dataset/style，逐项capability；读取成功不等于布局正确 |
| `assertNodes(probeSpec, assertSpec)` | 实际节点与独立expected key/rect/style/content/coverage联合断言；缺读/失败抛exit2 |
| `ready(spec)` | route/data/selector/layout/scroll同一连续稳定窗口，超时带最后样本 |
| `observeScroll(options)` | 原生offset只读轨迹，输入来源无法由SDK认证 |
| `swipe(selector, options)` | SDK touch尝试；不fallback程序滚动，结果真实手势始终未覆盖 |
| `evidence({dataSource,deviceType,uncovered,notes})` | 声明来源且记录为script-declared，不会自动认证真实数据 |
| `recordInteraction(method,detail)` | 为原始mp操作补交互分类，例如direct-method/programmatic-scroll |

## shot options（camelCase）

```js
await shot('shots/x.png', {
  selector: '.card',       // 可选；元素截图
  index: 0,                // 多个匹配时选第 n 个（0-based）
  pad: 8,                  // 元素截图外扩
  baseline: 'shots/base',  // 目录或文件
  mask: '.swiper,.countdown', // 仅整页；不能和 selector 同用
  threshold: 0.1,          // 像素差异百分比阈值
  pixelThreshold: 0.1,     // pixelmatch 单像素阈值 0..1
  updateBaseline: false,
  label: null,
  settleMs: 0,
});
```

## stdout / stderr 契约

- stdout 只有 CLI 的单个 JSON 信封；脚本里 **不要** `process.stdout.write`。
- `ctx.log` 写 stderr；`run` 期间 `console.log` / `console.info` 也被重定向到 stderr（前缀 `[script]`），但仍建议只用 `ctx.log`。
- 判断命令成功请用顶层 `ok` + 退出码；run脚本返回的 `{status:'unsupported'}` 只是结果数据，不会自动变成断言失败。业务验收必须使用 `ctx.assert`/`ctx.assertNodes`/`ctx.ready`抛出失败，且检查报告的未覆盖项，不能仅看run命令ok。

## 原生布局与有名步骤

```js
ctx.evidence({dataSource:'real-service',notes:['真实请求响应，无mock/替换列表']});
await ctx.step('等待实际窗口稳定', () => ctx.ready(readySpec), {timeoutMs:10000});
await ctx.step('检查复用节点', () => ctx.assertNodes(probeSpec, independentlyBuiltAssertions), {timeoutMs:10000});
```

expected不能复制actual作自证；只检查page.data/visibleKeys无法发现原生style滞留。完整schema见 [rendered-state.md](rendered-state.md)。

`--result-out result.json` 在单JSON stdout预览之外保存不截断完整结果；默认预览截断会在 `meta.serialization` 列出路径/原始数，不再静默丢数组。自动诊断含page.data等敏感数据，可用 `--no-diagnostics` 禁用。原始 `ctx.mp` 操作默认归类raw-sdk-untracked，请显式recordInteraction。

## 超时、mock 清理与结果

- `--run-timeout`（默认 600000ms，0 关闭）超时后 exit 1 `run-timeout`，并 abort `ctx.signal`；run上的全局`--timeout`也折入该内部deadline取较短非零值，先进入诊断/清理再退出，避免外层race跳过mock restore。
  - Promise.race 不能强行终止任意 JS；脚本应在循环/长任务里检查 `signal.aborted`。
- `run` 自动追踪脚本里设置的 wx/plugin mock，并在结束时 restore；`--keep-mocks` 可保留。
- 结果包含：

```json
"cleanup": {
  "kept": false,
  "mockedWx": ["getSystemInfoSync"],
  "mockedPlugin": [],
  "failed": []
}
```

- 显式 `restore` 失败不会提前取消追踪，最终清理会重试；若仍失败，`cleanup.failed` 列出失败项，命令 exit 1。
- cleanup 失败不保证 mock 已清掉；需要人工 `restore` 或 `up --restart`。
