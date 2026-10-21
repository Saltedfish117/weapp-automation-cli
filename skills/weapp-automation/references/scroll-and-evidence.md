# 滚动覆盖、故障步骤及证据分类

## 程序滚动不是手势

`scroll --top ...` 使用 SDK scrollTo/pageScrollTo(duration:0)。结果明确标为 `interaction:'programmatic-scroll'`，`physicalGestureVerified:false`，未覆盖真实手势/惯性。原生 offset 不可读时 exit 2 `scroll-unverified`，不再把 null 当滚动成功。

`swipe` 只尝试 SDK touchstart/move/end，绝不偷偷 fallback 到 scrollTo：

```powershell
weapp swipe "#example-scroll" --spec "@swipe.json" --attach-only
```

```json
{
  "from":{"x":160,"y":700},
  "to":{"x":160,"y":350},
  "durationMs":250,
  "steps":6,
  "observeMs":1200,
  "intervalMs":60,
  "minDisplacementPx":10,
  "requireInertia":true
}
```

坐标是模拟器内容 viewport CSS px，不是电脑截图坐标。会读取原生 offset 的前值、触摸过程、touchend及松手后的轨迹。无实际位移时标记未覆盖；即便应用事件改变了位置，也不能证明 SDK 发出了可信原生输入，CLI `swipe` 仍 exit 2 `gesture-unverified`。不要将 `touched/moved` 写成真实惯性手势通过。

SDK无法可靠产生滚动时，可由用户/获授权的电脑控制或真机手势执行输入，同时用只读监测：

```powershell
weapp scroll-observe --spec "@observe.json" --attach-only --result-out evidence/scroll.json
```

```json
{"selector":"#example-scroll","durationMs":2500,"intervalMs":60,"releaseAtMs":500,"interaction":"external-gesture-observed","requireInertia":true}
```

releaseAtMs 必须是实际松手相对监测开始的时间，不能凭空填写。监测只能证明 offset 轨迹，输入来源需独立录像/操作记录，仍不会自动认证真实手势。没有 computer-use 工具/授权时是会话环境限制，应写未覆盖；不能以 wheel/程序scroll代替手指惯性。

## 严格点击与限定容器

```powershell
weapp tap ".action" --strict --within ".filter-bar"
weapp tap-text "筛选" --strict --within ".filter-bar" --wait-for ".filter-popup"
```

- 容器必须唯一；strict选择器匹配多个且未显式index时拒绝，不发送事件。
- strict文本强制精确匹配；不按相同几何或矩形包含推测父子、也不合并不同SDK节点。多个匹配（包括包装祖先）需--tag/--within或显式--index收窄，否则拒绝。扫描上限导致未扫完时strict拒绝，非strict回显incomplete。
- 默认兼容首匹配，但多匹配结果附warning。tapped/eventSent只是事件发送，businessVerified:false；元素存在等待不等于业务状态断言。需ready data条件/ctx.assert/联合节点断言验证副作用。
- `--wait-for`若目标原本就存在，不证明点击引起了变化；需要业务expected前后值/版本或`ctx.ready`的数据条件。等待当前页每次重新取，不固定使用导航前旧Page handle。
- SDK无法可靠得知哪个节点真实绑定handler；uni-icons壳无效可点内部text。不要将heuristic最小元素等同真正可点击元素。

## 步骤、超时现场

```js
await ctx.step('筛选后原生布局就绪', () => ctx.ready(readySpec), { timeoutMs: 10000 });
```

失败带步骤名、耗时、当前路由；会尝试保存完整page.data、步骤状态和截图。默认目录 `.weapp-evidence/<time-command-pid>/`，可 `--evidence-dir <dir>`，敏感现场可 `--no-diagnostics` 禁用。

状态快照和截图分别限时，截图失败仍保存state且记录warning，不重启/导航/改数据。文件可能含账号及业务数据，请放受控本地目录。超时会abort ctx.signal，但不能强杀任意脚本JS或取消已发送SDK请求；长循环主动检查signal，不在被超时的异步任务里继续副作用。run的全局--timeout会折入脚本内部deadline（与--run-timeout取较短非零值），不会由外层race跳过finally；诊断与mock/session清理可比deadline晚数秒完成。连接本身使用connect-timeout/launch-timeout。其它命令全局超时在可用session内尝试诊断，连接失败则只返回连接错误。

## 证据固定字段

每个session输出 `meta.evidence`：

- dataSource: unknown / real-service / synthetic / mocked / mixed
- deviceType: unknown / devtools-simulator / android-device / ios-device
- device: wx实际平台/model/system/SDKVersion（读不到保持unknown）
- interactions: element-tap / text-tap / input / direct-method / programmatic-scroll / sdk-touch-events / external-gesture-observed / read-only / raw-sdk-untracked
- uncovered: 默认真实手势、Android、iOS未覆盖
- declarations: 脚本声明的来源，不能当作SDK自动认证

```js
ctx.evidence({dataSource:'real-service',notes:['由实际请求响应确认；没有替换列表或mock']});
ctx.recordInteraction('direct-method',{name:'test-only setup'});
```

原始ctx.mp操作无法自动判断是直接调用handler还是物理输入；必须主动记录，不记录保持raw-sdk-untracked。程序滚动与SDK触摸单独分类，声明不能消除未覆盖项。

## 有界stdout与完整导出

`--result-out result.json` 输出完整JSON-safe信封（不限制数组数/深度，循环/特殊值有显式类型标记）；父目录须存在，文件通过同目录临时文件原子替换。导出失败明确exit1，不静默忽略。

stdout预览默认300原始数组项、深度6；有`$type:'Truncated'`标记，`meta.serialization`包含每个路径、originalCount/retainedCount、原因及完整结果路径。**不要以预览数组length当业务原始数量**（末尾可能含一个截断标记）。完整数据不再在data/eval/run内部提前sanitize。

```powershell
weapp data exampleList --result-out evidence/example-data.json --attach-only
```

无截断的普通JSON数据形状保持；Date/Map/Set/BigInt/循环等使用typed marker。`meta.serialization`本身不再截断，以免截断信息也被隐藏。stdout写完才退出，避免大中文/emoji信封缺尾。
