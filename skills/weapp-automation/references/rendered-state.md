# 原生渲染、虚拟列表和组合就绪验收

## 先区分三个事实

1. Vue/Vuex 与 `page.data` 是提交的数据，不是实际像素或实际节点矩形。
2. `probe` 是实际节点取证；`status:passed` 仅表示读数可得，不表示布局正确。
3. `assert-nodes` 才比较独立预期与实际节点；缺少所需字段返回 unsupported（CLI exit 2），不会假装通过。

## 只读原生探针

```powershell
weapp probe --spec "@probe.json" --attach-only --result-out evidence/native.json
```

```json
{
  "selector": "#example-list .virtual-node",
  "containerSelector": "#example-scroll",
  "keyAttribute": "nodeKey",
  "computedStyle": ["position", "top", "height", "transform"],
  "properties": [],
  "scope": "auto",
  "timeoutMs": 5000
}
```

- 默认 scope:auto 对 uni-app 用当前 `$vm.$scope`，否则原生 page；也可指定 page/uni。
- 输出包括实际 viewport 坐标 `rect`、`dataset`、`inlineStyle`、`computedStyle`、`properties`、滚动位置、viewport/container 裁剪区域以及每项 capability/source。
- **rect 与 computedStyle 分组读取**：微信 `fields({rect:true,computedStyle:['top','height']})` 的同名字段会覆盖矩形，不能把 `top:'0px'` 当实际 viewport top。
- 原生 fields 不暴露 inline style 时，兼容用 SDK `attribute('style')`；只有路由、节点数、业务 key（若有）、前后实际 offset/size 都与原生结果一致才合并，并记录 `sources.inlineStyle`。不改 SDK，不写 setData。
- 查询间 count/key/rect 变化会标记 unsupported；等待布局稳定后重试。
- `properties:['item']` 可取自定义组件业务内容。文本不是所有原生节点都可读；不能把模型文本冒充实际文本。

## 联合断言

```powershell
weapp assert-nodes --spec "@nodes.json" --attach-only --result-out evidence/assertion.json
```

```json
{
  "probe": {
    "selector": ".row",
    "containerSelector": "#scroll",
    "keyAttribute": "nodeKey"
  },
  "assert": {
    "expected": [
      {"key":"activity-42","rect":{"top":300,"height":152},"style":"height:152px;transform:translateY(1008px);"}
    ],
    "tolerancePx": 1,
    "requireOrder": true,
    "requireUniqueKeys": true,
    "coverage": {"axis":"y","top":300,"bottom":452,"maxGapPx":1}
  }
}
```

- expected 必须来自业务规则/独立模型，不可复制同一份 actual 后声称验证正确。
- `rect` 是 viewport 坐标；若模型是 list-local：`expectedViewportTop = listActualTop + model.rect.top`。offset 已是 viewport 坐标，不能重复减 scrollTop。
- key严格类型、数量、唯一性、顺序和内容都检查。key-only 且无覆盖要求不能证明画面，返回 unsupported。
- style 字符串检查完整声明集合（忽略顺序）；style 对象检查属性子集。computedStyle 按实际 computed CSS 比较，`matrix(...)` 不会擅自等价为 `translateY(...)`。
- coverage 只证明**几何覆盖**，不证明像素可见或无遮挡；透明/hidden但仍占位的节点需要显式computedStyle期望（如opacity:'1'、visibility:'visible'、display）。颜色/opacity等无单位值精确比较，只有双方px长度可用tolerancePx。
- coverage 合并**实际矩形**在指定竖向 x 线的区间，列出 gap；默认检查 viewport∩container。可显式允许设计中的行间距，如 maxGapPx:20；不要以面积求和或窗口首尾范围代替覆盖。
- 横向 swiper 隐藏面板可能有正确节点和样式但实际 x 不在视口；coverage 必须失败/未覆盖，不能据数据正常宣称画面正常。

run 里可动态构建预期：

```js
const { snapshot, assessment } = await ctx.assertNodes(probeOptions, {
  expected: independentExpectedNodes,
  coverage: { axis: 'y', maxGapPx: 20 },
});
```

## 可组合 ready

```powershell
weapp ready --spec "@ready.json" --attach-only
```

```json
{
  "conditions": [
    {"type":"route","equals":"pages/example/index"},
    {"type":"selector","selector":"#example-list .virtual-node","minCount":1},
    {"type":"data","keyPath":"exampleListLoading","equals":false},
    {"type":"data","keyPath":"exampleList","minLength":1},
    {"type":"layout"},
    {"type":"scroll"}
  ],
  "layoutSelector":"#example-list .virtual-node",
  "scrollSelector":"#example-scroll",
  "timeoutMs":8000,
  "intervalMs":100,
  "stableSamples":3,
  "stableWindowMs":300,
  "epsilon":0.5
}
```

所有条件必须在同一个连续窗口内满足；业务 key/数据/路由/数量变化重置窗口。布局看真实矩形，滚动看原生 scrollOffset；全窗口 max-min≤epsilon，不只比较相邻样本。空读数/缺字段/null 不能“稳定通过”。超时保留 lastSample、lastReadError、lastConditionResults 与 unmetConditions。

ready 是**观测稳定**不是永远不会再更新的保证。异步业务须提供明确的 loading=false / 请求版本等条件；不能只等元素出现。

## 虚拟列表必须逐项走查

1. 不刷新故障现场：记录路由、筛选、真实/合成来源、总数、scrollTop、模型窗口；先保存原生 probe 和截图。
2. 对每个窗口节点核对：业务 key → 卡片 item → inline/computed style → 实际 rect，单独检查实际 viewport 覆盖。
3. 同时检查加载中/无更多、布局重建及滚动稳定，再断言；不能只看 visibleKeys 或 page.data。
4. 程序正反滚动覆盖顶/中/底、分页追加、窗口复用、筛选切换/回顶；每次都复核实际节点，不只复核模型。
5. 再单列真实手势及松手后的惯性采样、Android/iOS 真机。SDK程序scrollTo不能替代此项。
6. 真实数据与合成极端数据分开记录；直接调用页面方法仅是补充路径，不当作实际点击。
7. 证据中记录未覆盖/能力不足，尤其是 gesture、inertia、真机及截图不可用；不以 data 正确替代视觉验收。
