# 小程序 / H5 / PC 三段式视觉测试策略

结论：**视觉回归用 H5 + Playwright，小程序端用结构断言 + 截图取证。** 别指望 miniprogram-automator 做像素级基线。

## 为什么这样分工

| 端 | 渲染 | 适合 |
|---|---|---|
| 小程序（本 CLI） | devtools 内嵌 WebView，1x 截图 | 逻辑层真实、wx API 可打桩、页面数据结构真实 |
| H5（同一份 uni-app 代码） | 浏览器，可 2x/3x | 真正的 `toHaveScreenshot` 像素回归、多 viewport |
| PC（Playwright） | 浏览器 | 像素回归、可访问性、跨分辨率 |

同一份业务代码，三端各自验证不同维度，不要用小程序截图去做像素基线。

## 数据不是渲染证明

Vue/page.data正确仍可能有原生节点复用后style滞留。虚拟列表必须实际采集dataset业务key、rect、inline/computed style及实际覆盖，不能用窗口首尾代替矩形，也不能只检查模型。使用 `probe`/`assert-nodes` 与组合 `ready`；完整流程见 [rendered-state.md](rendered-state.md)。程序scrollTo不覆盖惯性，交互/设备/未覆盖分类见 [scroll-and-evidence.md](scroll-and-evidence.md)。

## 小程序端：结构与状态断言优先

```powershell
weapp open "/pages/example/index" --wait-ms 2000

# 1) 业务状态（最稳）
weapp data "exampleTitle"
weapp data "missing_field"        # -> found:false, value:null

# 2) 布局约束（找到才算通过）
weapp find ".example-card" --assert --style color,font-size
weapp find-all ".example-card" --assert --limit 10

# 3) 页面/视口尺寸（不要硬编码 390）
weapp page
```

**判定规则**（比像素更可靠）

- 元素存在：`find --assert` 直接 exit 2；不加 `--assert` 时看 `found === true`
- 不溢出：用 `find` 返回的 `offset` / `size`，配合 `shot` 的实际 `viewport`。`page.size()` 可能是整页内容尺寸，不能把其高度直接当作截图视口。
- 在视口内：`offset.top >= 0 && offset.top + size.height <= viewport.height`。`offset` **已经是视口坐标**，不要再减 `scrollTop`
- 顺序正确：`find-all` 返回数组的 `text` 依次包含期望关键字
- 空态/错误态：`data` 里 `listError`/`total === 0` 且对应文案元素存在

`find` 对**非法选择器**（如 `##`）现在 exit 4 `bad-selector`，不会再伪装成“找不到”；对合法但无匹配的选择器仍 exit 0 `found:false`，要断言存在就加 `--assert`。

## 小程序端：截图取证 + 粗粒基线

```powershell
weapp shot --out shots/example.png --baseline shots/base --update-baseline   # 建基线
weapp shot --out shots/example.png --baseline shots/base                     # 回归（退出 2 = 不一致）
```

适用：整页布局大改、tab 切换后的整屏、空态插图是否出现。
**不要**用它卡 1–2px 的间距或字体渲染差异 —— 模拟器 1x 采样会误报。

两个实测注意点：

- **动态内容会让基线必然误报**：同一页面连续两次截图（中间只有一次实际无效的 pageScrollTo）实测差异 8.63%。轮播、倒计时、随机推荐页面请先 `--settle-ms`，仍不稳定就改用结构断言、提高 `--threshold`，或用 `--mask` 遮住动态区域。
- **diff 文件独立**：`--out shots/a`（不带 `.png`）时，失败会写 `shots/a.diff.png`，不会覆盖 `shots/a` 当前截图。

遮罩动态区域：

```powershell
weapp shot --out shots/home.png --baseline shots/base --mask ".swiper,.countdown"
```

`--mask` 只支持整页截图，不能和 `--selector` 同用；baseline 仍保存未遮罩图，比较时用当前元素坐标同时遮罩 baseline/current，`diff` 里这些区域不会计数。返回值 `masked.regions` 会给出每个选择器命中的元素数和实际遮罩框。

元素级截图：

```powershell
weapp shot --selector ".example-card" --pad 8 --out shots/card.png
```

- `--selector` 用元素当前视口坐标裁剪；完全在视口外会 exit 2 `element-not-visible`。
- 部分可见时只裁可见部分，返回 `clipped: true` 和 `cropBox`，不会假装整张元素都在。
- 元素在 scroll-view 里时，先 `scroll --selector ".list" --top 300` 再截图。

## H5 端：像素回归（推荐主力）

```js
// playwright
await expect(page).toHaveScreenshot('income.png', { maxDiffPixelRatio: 0.01 });
```

要点：固定 viewport、`deviceScaleFactor: 2`、等字体加载完（`document.fonts.ready`）、关闭动画后再截。

## 异常态覆盖清单

| 场景 | 小程序做法 | 断言 |
|---|---|---|
| 接口失败 | `mock "wx.request" "@fail.json"`（`fail.json` = `{"errMsg":"request:fail"}`） | 错误文案元素 + `data.listError` |
| 空列表 | `mock "wx.request" "@empty.json"`（`empty.json` = `{"data":[]}`） | 空态元素存在、总数 0 |
| 未登录 | `mock "wx.getStorageSync" "@empty.json"` 或清缓存后重进 | 跳转登录页 |
| 权限拒绝 | `native authorizeCancel` | 页面回退到提示态 |
| 长文本 | `data` 里注入长字段 / 造超长 club 名 | 不换行溢出、不截断异常 |

PowerShell 下**不要**写 `mock "wx.request" "{\"data\":[]}"`：内层引号会被拆掉/吃掉。把 JSON 放文件里用 `@file`，或者用单引号+反斜杠转义；详见 SKILL.md 的“PowerShell 的 JSON”。

每次异常演练后要 `restore`，否则后续用例会被污染。`run` 脚本里设置的 mock 默认会在脚本结束时自动 restore；只有显式 `--keep-mocks` 才保留。

## 滚动

```powershell
weapp scroll --top 300                           # 页面级
weapp scroll --selector ".order-list" --top 200  # scroll-view
```

页面实际使用 scroll-view 时，`pageScrollTo` 不生效，CLI 会 exit 2 `scroll-no-effect` 并提示加 `--selector`；不要忽略这个信号，否则后续元素截图/布局断言都基于错误滚动位置。

## 交付节奏

1. 先用 `data`/`eval` 把业务断言跑通（快、稳、便宜）。
2. 再用 `find --assert` 补布局约束。
3. 最后才截图，作为报告里的证据，不承担主要判定。
