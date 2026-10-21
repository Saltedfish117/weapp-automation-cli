# miniprogram-automator 0.13.0 API 与坑位

本机实测版本：`miniprogram-automator@0.13.0`（`out/` 目录，CommonJS）。
事实来源：`node_modules/miniprogram-automator/out/*.d.ts` + 本机真实调用。

## 连接

```js
const automator = require('miniprogram-automator');

// 方式 A：用 devtools CLI 拉起（CLI 内部实现，见 scripts/lib/launcher.mjs）
// 注意：不要直接调 automator.launch()，见下面的 0.13.0 冷启动坑。
const { mp } = await launchDevtools({ cliPath, projectPath, port, timeoutMs: 180000 });

// 方式 B：attach 到已在运行的实例（推荐，不打断用户）
const Connection = require('miniprogram-automator/out/Connection').default;
const MiniProgram = require('miniprogram-automator/out/MiniProgram').default;
MiniProgram.prototype.checkVersion = async () => {}; // 必须：新版 devtools 会拒绝版本握手
const mp2 = new MiniProgram(await Connection.create('ws://127.0.0.1:9420'));
```

- **0.13.0 的 `automator.launch()` 在 Node 22 上不可用**：它直接 `spawn(cli.bat)`，Node ≥ 20.12 对 `.bat/.cmd` 抛 `EINVAL`。CLI 改为 `cmd.exe /d /s /c ""<cli.bat>" auto --project ... --auto-port ..."` 预启动，再 attach（`scripts/lib/launcher.mjs`）。
- `projectPath` 必须是含 `app.json` 的编译根；CLI 对 uni-app 源码根会自动解析 `project.config.json.miniprogramRoot` 或 `unpackage/dist/dev/mp-weixin`，不会把源码根直接交给 devtools。
- 启动 `cmd.exe` 时不要再加 `windowsHide: true`：实测它会让 devtools 窗口以最小化状态启动，模拟器不绘制，`currentPage` 超时。
- `automator.launch()` 的内部超时默认 30s，CLI 的 `--launch-timeout` 必须显式传进去；CLI 自建 launcher 已使用该值。
- 端口 9420 由 devtools「设置 → 安全设置 → 服务端口」开启。
- `checkVersion` 不打补丁时，旧 SDK 常直接抛错，且报错信息不指向真实原因；CLI 默认打补丁，`--strict-version` 可关闭。
- 一个端口同时只适合一个活跃客户端；并发要自行串行化（CLI 用锁文件，活 PID 不会被抢，活锁清理需 `--force`）。
- `Tool.getInfo` 只返回 `{version, SDKVersion}`，**不返回项目路径**；CLI 改用 `wx.getAccountInfoSync()` 的 `miniProgram.appId` 与 `project.config.json` 对比，不匹配时 exit 3 `project-mismatch`，`--allow-other-project` 可放行。

## MiniProgram

| 方法 | 说明 |
|---|---|
| `pageStack()` / `currentPage()` | 页面栈 / 当前页 |
| `navigateTo / redirectTo / navigateBack / reLaunch / switchTab(url)` | 导航，返回 `Page`；内部固定 sleep 3s，重页面可能 timeout |
| `callWxMethod('navigateTo'|'redirectTo'|'switchTab'|'reLaunch', {url})` | CLI 的实际导航路径：发请求后轮询 `currentPage()`，避免 automator 的固定 sleep/超时 |
| `systemInfo()` | 设备信息（只读，**不能**用来切机型）；不含 appId |
| `callWxMethod('getAccountInfoSync')` | 返回 `{miniProgram:{appId,envVersion,version}}`；CLI 用它校验 attach 的项目 |
| `evaluate(fnOrString)` | 逻辑层求值；**内部 `fn.toString()`**，所以传字符串时必须是合法函数，如 `'() => (1+1)'` |
| `callWxMethod(name, ...args)` | 主动调 wx API |
| `mockWxMethod(name, result)` | 覆盖 wx API 返回值 |
| `mockWxMethod(name, fn)` | 覆盖为函数实现（可 `throw` 造失败） |
| `restoreWxMethod(name)` | 还原；未 mock 时调用也通常成功 |
| `callPluginWxMethod / mockPluginWxMethod / restorePluginWxMethod` | 插件侧同名能力 |
| `screenshot({path})` | 截图；**不传 path 时返回 base64**，只含模拟器视口，尺寸随机型变化 |
| `pageScrollTo(scrollTop)` | **页面级**滚动；页面使用 scroll-view 时无效 |
| `stopAudits({path})` | 停止体验评分并写报告；automator 没有 `startAudits` |
| `getTicket / setTicket / refreshTicket` | 免扫码登录态复用 |
| `native()` | 原生弹层句柄 |
| `remote(auto)` | 开启远程调试，返回二维码相关数据 |
| `testAccounts()` | 测试账号列表 |
| `exposeFunction(name, fn)` | 注入可被逻辑层调用的函数 |
| `CDP()` | **当前版本不可用**：`App.CDPEnable unimplemented` |
| `disconnect()` / `close()` | `close()` 会**关闭 devtools**；CLI 普通命令禁用，只有 `up --restart` 例外 |

## Page

`path`、`query`、`waitFor(cond|ms|selector)`、`$(sel)`、`$$(sel)`、`xpath()`、`getElementByXpath()`、
`data(keyPath?)`、`setData()`、`callMethod(name, ...args)`、`size()`、`scrollTop()`

- `$()` 未命中返回 `null`（不抛异常），**但它也会把选择器语法错误/连接错误吞成 null**。CLI 的 `find` 在 miss 时会再走一次 `$$()`，把非法选择器映射为 exit 4 `bad-selector`。
- `waitFor('selector')` 内部轮询 `$$`，比固定 `sleep` 稳；CLI 已暴露 `wait-for <selector> [--gone]`，`run` 脚本里也可直接 `await page.waitFor(sel)`。
- `scrollTop()` 对页面返回数字/字符串；对 scroll-view 页面可能返回数组。CLI 只在能读到数值时校验滚动结果。
- `getCurrentPages().slice(-1)[0].$vm` 是页面 Vue 实例，可以拿 `$vm.$refs.<component>`、调页面 handler、读 Vuex model。多个同 class 的元素优先用 CLI 的 `--index n`（`input`/`tap`/`trigger`/`find`/`shot --selector`/`scroll --selector`）；批量操作仍可用 `p.$$('input')[i].input(v)`。
- CLI 的 `find-text`/`tap-text` 靠遍历 `text`/`button`/`view` 的 `text()` 做文本定位，按「text/button 优先、面积从小到大」排序；组合行通常能靠 `tap-text` 命中最小可见子元素，命中 label 不触发时再点 `.content_text`。`wait-for` 用轮询 `$$` 实现，不依赖 automator 的固定 sleep。
- `data(keyPath)` 对不存在的 key 返回 `undefined`；CLI 的 `data` 会输出 `found:false` + `value:null`。

## Element

`size()`、`offset()`、`style(name)`、`wxml()`、`outerWxml()`、`text()`、`attribute(name)`、`property(name)`、
`data(path)`、`callMethod(name, ...args)`、
`tap()`、`longpress()`、`trigger(type, detail)`、`dispatchEvent({...})`、
`touchstart/touchmove/touchend(opt)`、`input(value)`、`scrollTo(x, y)`

子类（自动按标签分发）：`InputElement`、`ScrollViewElement`（`scrollTo`、`property('scrollTop')`）、`SwiperElement`（`swipeTo`）、
`MovableViewElement`（`moveTo`）、`SwitchElement`、`SliderElement`（`slideTo`）、`ContextElement`（`callContextMethod`）。

- `size()` / `offset()` 返回字符串或数字，比较前要 `Number`/`parseFloat`。
- **`offset()` 是视口坐标**，不是页面坐标。实测：scroll-view 滚到 200 后，子元素 `top` 从 182 变 -18。CLI 的 `shot --selector` 直接用它裁剪，不额外减 `scrollTop`。
- `input(value)` 只存在于 `InputElement` / `TextareaElement`；对 `view` 调用会 `TypeError`。CLI 会先检查并 exit 2 `element-not-input`。
- `input` 只改值，不自动触发 `confirm`/`blur`；CLI 的 `input --confirm` / `--blur` 会用 `element.trigger(event, {value})` 补事件。搜索框通常需要 `--confirm`。
- `tap()` 不检查元素是否被遮挡或完全在视口外。
- `style(name)` 返回该样式字符串，不做数值解析。

## Native（原生弹层）

`goHome`、`navigateLeft`、`confirmModal`、`cancelModal`、`switchTab({url})`、
`authorizeAllow`、`authorizeCancel`、`shareConfirm`、`shareCancel`、`closePaymentDialog`

- 方法在 `Native.prototype` 上；`Object.keys(native)` 列不到，CLI 用 prototype 检查并支持 `native switchTab --url ...`。
- 自定义 tabBar 下 `native switchTab` 可能返回 `{error:{message:"switchTab failed"}}`；CLI 会 exit 2 `native-failed`，此时改用 `open` 或 `mp.switchTab()`。
- `native confirmModal/cancelModal` 只对微信原生弹层可靠；实测 `uni.showModal`、`uni-popup`、`picker-view` 这类弹层会返回 `confirmModal failed`/`cancelModal failed`，且弹层打开时 `page.$$` 可能就是 0 个元素。后备方案是用页面 `$vm` 调组件/页面方法。
- 组合行的 `tap` 要点在真正带 `@click` 的子元素（如 `.content_text`），点在整行 `.cell_item` 的中心可能落在 label 上、不触发。
- 原生弹层不在 `captureScreenshot` 里，视觉结论另找依据。
- 调用时若当前没有对应弹层，devtools 可能返回成功/空结果，CLI 不做额外校验。

## 已踩过的坑

1. **CDP 不可用**：`mp.CDP` 是函数属性，要 `mp.CDP()` 再 `enable()`；本机直接 `App.CDPEnable unimplemented`。
2. **截图 1x**：本机 iPhone 12/13 Pro 视口 390×844；换机型/窗口状态会变，别硬编码。
3. **截图不含原生弹层**：授权/支付/分享面板由 devtools 自身渲染，`captureScreenshot` 只截模拟器内容。
4. **窗口最小化/失焦时 `captureScreenshot` 永久挂起**：协议调用仍正常；恢复窗口可见即可，不用重启工具。CLI 有 15s 超时，exit 3 `screenshot-timeout`。
5. **`navigateTo` 之后立刻读 data 会拿到旧页**：用 `wait-for`/`page.waitFor` 等目标页或关键元素出现。
6. **热重载会清空状态**：用户改代码即触发，测试中“点击无反应”优先怀疑重载。
7. **长表达式在 Console 里会被截断**：走 `eval` 命令而不是手工在 Console 粘贴；CLI 会把表达式包成 `() => (\n...\n)`，行尾 `//` 注释也不会吃掉右括号。
8. **`close()` 会关工具**：CLI 普通命令已禁用（exit 2 `close-disabled`），只有 `up --restart` 显式关闭。
9. **mock 跨 CLI 进程持久**：`mock` → 下一次 `eval` 仍生效；`run` 会在结束时自动 restore（`--keep-mocks` 关闭）。
10. **`pageScrollTo` 对 scroll-view 页面无效**：CLI `scroll` 会回读 `page.scrollTop()`，没变化 exit 2；用 `scroll --selector` 走 `ScrollViewElement.scrollTo`。
