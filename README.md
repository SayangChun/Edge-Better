# Edge Better

在新标签页打开书签 —— 复刻并增强 [Open bookmarks in a new tab](https://microsoftedge.microsoft.com/addons/detail/%E5%9C%A8%E6%96%B0%E6%A0%87%E7%AD%BE%E9%A1%B5%E4%B8%AD%E6%89%93%E5%BC%80%E4%B9%A6%E7%AD%BE/bafanlmplgllnpdbemmppkbggiooifep)（Vitaliy Potapov，2.1 万+ 用户，微软精选认证）。

原插件闭源。本仓库按其官方公开描述的机制重建，并修复已知问题、增加新功能。全部数据本地处理。

## 功能（v0.2.1）

**核心（复刻原插件）**

- 左键点击书签 → 在新标签页打开，当前页不被覆盖
- 书签 URL 加 `newtab@` 标记；弹窗 / 选项页一键开关，全部可逆
- 纯本地实现，无外部跳转依赖

**增强与修复**

- **覆盖空白新标签页**（首个增强功能）：在空白新标签页（Edge 默认 NTP、about:blank 等）点击书签时，直接在当前页打开，不再叠加一个新标签。可在选项中关闭
- **自定义空白页规则**：第三方新标签页（如 Momentum）可加入正则匹配，同样被覆盖
- **中键 / Ctrl 点击书签不再多开空白标签**（原插件会先多开一个新标签再叠一个书签页）
- **卸载安全**：即使扩展损坏或被卸载而未还原，书签仍可正常打开（前缀位于 URL 的 userinfo 位置，被浏览器忽略，仅地址栏外观残留标记）——原插件卸载不还原会留下打不开的书签
- **手动豁免**：编辑书签 URL 去掉 `newtab@` 前缀即可豁免该书签，不会被自动补回
- **非 http(s) 书签不改写**：`javascript:`、`edge://`、`file:` 等保持浏览器默认行为

## 版本历史

| 版本 | 变更 |
| --- | --- |
| v0.2.1 | 修复冷 Service Worker（空闲回收后唤醒慢于导航提交）下点书签仍会刷新当前页 |
| v0.2 | 修复点书签时当前页被刷新（三层防线：alarms 保活 SW / 热路径零 await 取消 / 冷路径 bfcache 回退）；修复新建书签时收藏文件夹被冲回默认文件夹（加前缀延后到收藏气泡关闭之后）；中键 / Ctrl 点击不再多开空白标签 |
| v0.1 | 书签在新标签页打开 + 覆盖空白新标签页；卸载安全（前缀在 userinfo 位置被浏览器忽略）；手动豁免；非 http(s) 书签不改写 |

## 机制

1. 开启时，为所有 http(s) 书签 URL 插入 `newtab@` 标记（位于 userinfo 位置，保留原 scheme）：
   `https://example.com/a` → `https://newtab@example.com/a`
2. `webNavigation.onBeforeNavigate` 捕获主框架上的 `^https?://newtab@` 导航，直接决定落点：
   - 当前是空白新标签页（或该标签本就是为这次书签导航新建的——中键 / Ctrl 点击）→ `tabs.update` 直接覆盖当前页
   - 否则 → `tabs.create` 新建标签打开书签；**同时**把当前标签导航到「原 URL + `#edge-better`」，
     与原页只差 fragment = 同文档导航，**当前页不卸载、不刷新、DOM 状态完整保留**

关键细节（都踩过坑，改动前必读）：

- **取消导航必须抢在 `tabs.create` 之前，而且要"零 await"地立刻下发**。`newtab@` 导航在
  `onBeforeNavigate` 之后 20~50ms 就可能提交（站点秒回时），而浏览器提交一次导航期间
  没空处理扩展的 `tabs.update` —— 晚一点点，取消就会排到提交后面，退化成「整页重载」。
  所以热路径上连 `tabs.get` 都不做，决策只用同步拿到的 `prevUrl`。
- **不再用 DNR**：DNR block / redirect 都要先提交一个中间页，中间页提交即卸载当前页。
- 浏览器把 URL 的 userinfo 原样带进网络层，`webNavigation` 得以命中；而 userinfo 本身被
  浏览器忽略——这正是「关闭后书签仍可用」的原因。地址栏星标判断当前页是否已收藏时同样
  忽略 userinfo，因此带前缀的书签照常被识别（见下方「星标识别实测」）。
- **新建书签的加前缀是延后的**，见下一节。

### 为什么能保证「当前页不刷新」（三条防线）

MV3 的 Service Worker 空闲 30s 就被回收（官方文档：Chrome 118 起调试器会话会保活，
所以挂着 DevTools / Playwright 时**看不到**这个问题）。用户点书签时才唤醒它，
冷启动要几十到上百毫秒 —— 那时导航早已提交，取消无从谈起。三层应对：

| 防线 | 做法 | 效果 |
| --- | --- | --- |
| ① 保活 SW | `chrome.alarms` 30s 周期事件重置空闲计时器 | 大多数点击走热路径，连"闪一下"都没有 |
| ② 热路径取消 | 零 await 立刻 `tabs.update` 到「原 URL + `#edge-better`」（同文档导航） | 文档不卸载，DOM / 滚动状态完整保留 |
| ③ 冷路径回退 | 先开新标签，再等导航落定；若已提交就 `tabs.goBack()` | 原页在 bfcache 里被冻结-恢复：**不是重载**，状态无损 |

第 ③ 条是关键补救：原页被书签页顶掉后**绝不能**用 `tabs.update` 导航回原 URL ——
那是跨文档导航，会整页重载（这正是用户报的 bug）。`tabs.goBack()` 走 bfcache，
实测 `pageshow persisted=true`、docId 不变。`goBack` 偶发报
"Cannot find a next page in history"（提交瞬间历史还没落定），所以带重试 + 页面内
`history.back()` 兜底。

冷启动判断依据 `swStartedAt`（SW 启动时刻）；「导航前的 URL」在**任何 await 之前**
同步快照 —— await 期间排队的 `tabs.onUpdated` 会把 `tabUrls` 里这条记录刷成
「提交后的 URL」，那样就再也认不出原页了。

### 为什么新建书签不立刻加前缀

Edge 点星标会**立即**在默认文件夹建好书签并弹出收藏气泡，用户随后在气泡里挑文件夹。
实测确认：此刻对节点的任何外部改写都会打乱这次编辑——**用户选的文件夹被丢回最初那个**
（即「即使选择了其他文件夹，还是保存在最初显示的文件夹里」）。

所以加前缀被推迟到「气泡必然已关闭」的时刻：

| 触发条件 | 为什么安全 |
| --- | --- |
| 用户切换标签 | 气泡会因失去焦点而关闭 |
| 创建它的那个标签被关掉 | 同上 |
| 创建它的那个标签导航走 | 同上 |
| 浏览器窗口彻底失焦（切到别的应用） | 同上 |
| 浏览器重启（`runtime.onStartup`） | 上一轮的气泡不可能还开着 |
| 兜底 30s | 超过它一律补上 |

在这段「待处理窗口」里书签还没有前缀，点它不会走 `newtab@` 通道。因此扩展额外按 URL
反查「这次导航的目标是不是我正等着加前缀的那个书签」，命中就走同一套落点逻辑
（地址栏手动输入同一 URL 不算，避免莫名其妙多开标签）。待处理表存在
`storage.local.pendingPrefixes`，Service Worker 被回收重启后能续上。

## 与原版已知问题的对照

| 原版已知问题 | Edge Better |
| --- | --- |
| 部分书签图标短暂丢失，首次打开后恢复 | 机制固有（URL 变化导致 favicon 缓存失效），保持同样行为 |
| 部分网站弹"要离开此站点吗" | 机制固有（离开带 beforeunload 的页面不可避免），点击"离开"后原页面仍保留 |
| 地址栏星标认不出当前网站已收藏 | **实测未复现**（详见下方"星标识别实测"），无需修复 |
| 受限域名依赖外部 `bookmarks-evz.pages.dev` 静态跳转页 | 已去除，纯本地实现 |
| 卸载不还原 → 书签 URL 损坏 | 已修复（见"卸载安全"） |
| 中键点击书签多开空白标签 | 已修复 |
| 点书签时当前页被刷新 | **已修复**：三层防线（保活 SW / 零 await 取消 / bfcache 回退），见"为什么能保证当前页不刷新" |
| 收藏时选了别的文件夹，仍存回最初那个 | **已修复**：加前缀延后到收藏气泡关闭之后（见"为什么新建书签不立刻加前缀"） |

### 星标识别实测

原版插件文档把"地址栏星标可能认不出当前网站已收藏"列为已知问题（原文 "may not detect"，作者自己用了不确定措辞）。本仓库在真机 Edge **155.0.4283.45** 上做了三状态对比实验（`tools/probe-star-state.cjs` + `tools/capture-window.py`，PrintWindow 截取真实窗口）：

| 实验状态 | 书签库 | 星标表现 |
| --- | --- | --- |
| A 对照 | 真实 URL 书签 | 点亮 |
| B 被测 | `newtab@` 前缀书签 | **点亮，与 A 像素级一致** |
| C 基线 | 无书签 | 空心 |

结论：浏览器判断当前页是否已收藏时，会忽略 URL 的 userinfo 部分再与书签库匹配——`newtab@` 前缀不影响星标识别。原版文档的该已知问题在当前 Edge 版本未复现，扩展侧也确实无需做任何处理。

> 注：实验只覆盖本机 Edge 版本。若你在其他版本上遇到星标不点亮，可以重新运行探针脚本取证。

## 为什么不支持「关闭窗口前确认」

有人会想要「点右上角 X 时不立即关闭，先弹框确认」。这个需求**没有做**，因为它与本插件的核心机制直接冲突。以下是 2026-10-17 在真机 Edge 155 上的实测依据（`tools/probe-wmclose.py`、`tools/probe-close-confirm.cjs`）：

| 实验 | 做法 | 结果 |
| --- | --- | --- |
| A 对照 | 普通页面，`PostMessage(WM_CLOSE)`（等价点 X） | 窗口消失、进程退出 |
| B 拦截 | content script 注入 `beforeunload` 后点 X | 窗口保留，弹出原生 **「是否离开网站?」** 对话框 |
| C bfcache | 注入 `beforeunload` + 用户点过页面，A→B→后退 | **原页被重新加载**，`persisted=false` |

`beforeunload` 是扩展唯一能拦下关闭动作的钩子，但 Chromium 给它配了两条触发条件恰好重合的规则：

- **只有用户交互过**（sticky user activation），关闭时才会弹确认
- **一旦用户交互过**，页面就**失去 bfcache 资格**

第二条会直接推翻本插件 v0.2 的核心修复：冷路径 `tabs.goBack()` 靠 bfcache 让原页免于重载，页面一旦失去资格，`goBack` 就退化成整页刷新——正是用户报过的那个 bug。（对照实验：无交互时注入 `beforeunload`，bfcache 仍生效 `persisted=true`，说明冲突只在交互后出现。）

另外两个无法绕开的限制：

1. **新标签页注入不了**：`edge://newtab` 禁止注入 content script（实测返回 null）。用户停在空白新标签页点 X 时不会有任何提示，而这是最常见的关窗场景
2. **文案不可定制**：浏览器强制使用自己的本地化文案（「是否离开网站?」），扩展只能决定拦不拦，做不出自定义的「确定要关闭浏览器吗」弹框

**替代方案**：Edge 自带设置「关闭具有多个选项卡的窗口时显示警告」（`edge://settings/appearance`，pref 名 `browser.show_prompt_before_closing_tabs`，本机默认 `true`）。它不影响 bfcache、零成本，但只覆盖多标签窗口。

如果将来确实要做，只能作为**默认关闭**的开关提供，并接受「交互过的页面失去 bfcache」这一代价。

## 为什么不支持「移除右键菜单里的打印」

需求：右键菜单里的「打印...」既占位置又容易误点，希望扩展能去掉它（做成可选开关）。

**结论：不做。** 不是实现成本问题，而是浏览器没有提供这个能力。

Chromium 的右键菜单属于浏览器 UI。扩展 API 只有 `chrome.contextMenus`，它只能**增删扩展自己创建的菜单项**——原生项既读不到也改不了。CDP 里没有操作浏览器 UI 菜单的域，企业策略里也没有「只隐藏打印这一项」的粒度。这是 API 能力边界，不是某个版本的行为差异，换浏览器版本也不会变。

唯一能真正去掉「打印」的做法：content script 拦截 `contextmenu` 事件并 `preventDefault()`，再**自绘一个菜单替换整个原生菜单**。代价远超收益：

| 原生菜单项 | 自绘菜单能否替代 |
| --- | --- |
| 检查（Inspect） | ❌ 扩展无法打开 DevTools 并定位到元素 |
| 翻译 / 朗读所选内容 | ❌ |
| 另存为 | ❌ |
| 添加到收藏夹 | ❌（`chrome.bookmarks` 能建书签，但会打断收藏气泡，见上一节） |
| 复制图片 / 图片另存为 | ⚠️ 跨域图片受 canvas 污染与下载限制 |
| 后退 / 前进 / 刷新 / 复制 / 粘贴 / 全选 | ✅ |
| 暗色模式、屏幕边缘自动翻转、键盘导航、高 DPI 缩放 | ⚠️ 需逐项重写，且永远与原生有差异 |

还有一层：自绘菜单**只对普通网页生效**。`edge://` 页面、PDF 查看器、扩展页面注入不了 content script，这些地方依旧是带「打印」的原生菜单。

即「为了去掉一个菜单项，牺牲整个右键菜单」，所以这个功能不做。

**如果你确实想让打印入口消失**，浏览器层面有一个真办法，但副作用明确：用组策略把 `PrintingEnabled` 设为 `0`（`HKLM\SOFTWARE\Policies\Microsoft\Edge`），会**禁用整个打印功能**——菜单项没了，`Ctrl+P` 也一起失效，且需要管理员权限。这不是扩展能做的事，也不建议为「少点错一次」付出这个代价。

## 安装

1. Edge 地址栏输入 `edge://extensions`
2. 打开左下角"开发人员模式"
3. 点"加载解压缩的扩展"，选择本目录（`E:\project\EdgeBetter`）
4. 工具栏出现 Edge Better 图标。**首次安装默认开启**（会改写全部书签，弹窗可一键关闭并还原）

## 使用

### 快速上手

1. 按上文安装后，扩展**默认开启**，会自动为所有 http(s) 书签加 `newtab@` 前缀（浏览器忽略该前缀，书签行为不变）
2. 弹窗显示当前状态与已改写书签数量
3. 想还原所有书签？选项页点"恢复所有书签为原始 URL"，或直接关闭总开关——两者都可逆

### 日常使用

- **左键点击书签**：在新标签页打开，当前页保留（原插件核心行为）
- **在空白新标签页（Edge 默认 NTP、about:blank、自定义起始页）点击书签**：直接覆盖当前空白页，不再多叠一个新标签
- **中键 / Ctrl+点击书签**：后台打开新标签，不再产生多余的空白标签（原插件会先多开一个空白标签）
- **普通地址栏访问**：不受影响，始终正常打开
- **刚收藏的网站**：`newtab@` 标记要等你关掉收藏气泡（切换标签、关闭该标签、该标签导航走、浏览器重启，最多 30 秒）才补上——这样你在气泡里选的文件夹才不会被冲掉。补上之前点它，扩展同样认得出，仍会在新标签打开

### 弹窗（工具栏图标）

点开即看：总开关、已改写书签数、进入选项页。总开关关闭时立即恢复全部书签为原始 URL。

### 选项页（右键图标 → 选项）

- **总开关**：同上
- **覆盖空白新标签页**：关闭后回到原插件行为（空白页点击书签会新建标签）
- **自定义空白页正则**：每行一条正则。第三方起始页（如 `^https://momentumdash\.com/`）匹配到时同样会被覆盖
- **重新扫描统计 / 重新改写全部 / 恢复所有书签为原始 URL**：手动控制按钮
- 已知限制说明（地址栏残留标记、favicon 缓存等）也列在选项页底部

### 豁免单个书签

书签管理器里编辑该书签 URL、去掉 `newtab@` 前缀即可。此后无论总开关如何切换，该书签都不会被重新改写。

### 关闭与卸载

- **临时关闭**：弹窗或选项页关掉总开关，书签立即还原为原始 URL
- **卸载**：建议先点"恢复所有书签为原始 URL"。即使忘记，书签也仍可正常打开（前缀在 userinfo 位置被浏览器忽略，只是地址栏外观残留标记）——这是相对原插件的关键修复

## 开发

```
background.js        MV3 Service Worker：书签改写 / 导航落点调度 / 新建书签延迟加前缀
popup.* / options.*  弹窗与选项页
lib/                 纯函数：前缀、空白页判定、落点决策、改写计划、待处理书签反查
test/                单元测试（node:test，35 项；readme-sync.test.js 校验本 README 的版本与测试数标注）
tools/browser-test.cjs      真机 Edge 集成测试（17 项）
tools/probe-refresh.cjs     「当前页被刷新」复现探针（DELAY=0 时站点秒回，最严苛）
tools/harness-real.cjs      无调试器真机测试台（冷/热 SW 场景 + bfcache 实测，见下）
tools/probe-folder.cjs      收藏气泡 UI 探针（真机点星标/下拉/完成，需真实鼠标点击）
tools/probe-star-state.cjs  星标识别探针（真机 Edge + PrintWindow 截窗口，三状态对比）
tools/capture-window.py     通用 Edge 窗口截图（PrintWindow，不受遮挡影响；--list/--all 枚举所有窗口）
tools/click-point.py        真实鼠标点击 / 抬窗口 / 按键 / 原样点击（含 --raw、--focus、--key）
tools/click-center.py       点最新 Edge 窗口中心（真实鼠标，制造 sticky user activation；harness 的 CLICK_FIRST=1 用它）
tools/probe-wmclose.py      关闭确认探针：发 WM_CLOSE（等价点 X）看 beforeunload 能否拦住关闭
tools/probe-close-confirm.cjs  CDP 侧探针：content script 的 beforeunload 是否生效、edge://newtab 能否注入
tools/build-guard-ext.py    构建注入 beforeunload 的扩展副本（供上面两个探针和 bfcache 对照实验使用）
icons/gen_icons.py  图标生成脚本（Pillow）
```

单元测试：

```bash
npm test
```

浏览器集成测试（playwright-core 驱动本机 Edge + 临时 profile + 加载扩展，CDP 模拟书签点击的主框架导航）：

```bash
NODE_PATH="C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/workspace/node_modules" \
  "C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe" tools/browser-test.cjs
```

2026-10-16 实测 17/17 通过：普通导航、覆盖空白页、新建标签 + 原页恢复（不刷新）、中键防叠标签、
开关与降级、新建书签延迟加前缀、待处理书签点击识别、选项页。
**测试只操作临时 profile，绝不碰用户真实 Edge profile。**

> 注意：集成测试里的 `SERVER_DELAY_MS` 若设得太大（如 250ms），会掩盖「取消导航」的竞态问题——
> 站点秒回时才是真实情况。回归这类问题请用 `tools/probe-refresh.cjs`（默认 `DELAY=0`）。

### ⚠ 基于 CDP 的测试看不到「冷 SW」类问题

Playwright / DevTools 附着会**保活 Service Worker**（官方文档：Chrome 118 起调试器会话
保活 SW），也会**禁用 bfcache**。所以任何基于 CDP 的测试都会系统性地掩盖这两类问题——
包括本项目曾经踩的坑：旧集成测试 13/13 全绿，真机上却会刷新当前页。

需要验证这类行为时用 `tools/harness-real.cjs`：它用 `child_process` 直接起独立 Edge
（**不接任何调试器**），测试页自己把文档身份汇报给本地服务器，事后只看服务器日志。

```bash
# 热 SW（刚启动就点书签）
MODE=race-warm "…/node.exe" tools/harness-real.cjs
# 冷 SW（静置 45~60s 让 SW 被空闲回收后再点）—— 复现「点书签刷新当前页」
MODE=race-cold IDLE_MS=60000 "…/node.exe" tools/harness-real.cjs
# bfcache 实测：原页 → 中间页（立刻 history.back()）→ 看原页是否被冻结-恢复
MODE=bfcache "…/node.exe" tools/harness-real.cjs
```

判据：原页 load 次数不变（没重载）、`pagehide persisted=true` + `pageshow persisted=true`
（bfcache 往返）、`/target` 只被新标签加载一次（当前页没被顶掉）。

两个环境变量：

- `EXT_DIR=<路径>` 指定要加载的扩展目录（默认本仓库）。配合 `tools/build-guard-ext.py`
  可以测「注入 beforeunload 的扩展」，用于验证 bfcache 资格。
- `CLICK_FIRST=1` 在导航前用真实鼠标点一下测试页，制造 sticky user activation。
  `beforeunload` 的关闭确认和 bfcache 资格都只在用户交互过后才生效，不加这个开关
  测不出「交互后失去 bfcache」的现象。

```bash
# 交互后 bfcache 是否还在（guard 扩展 + 真实点击）
EXT_DIR="$(python tools/build-guard-ext.py)" CLICK_FIRST=1 MODE=bfcache "…/node.exe" tools/harness-real.cjs
```

## 路线图（待定）

- 快捷键切换总开关
- 书签快速搜索弹窗
- 书签默认后台打开（不抢焦点）
- 打开记录统计
