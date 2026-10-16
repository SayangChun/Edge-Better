# EdgeBetter

在新标签页打开书签 —— 复刻并增强 [Open bookmarks in a new tab](https://microsoftedge.microsoft.com/addons/detail/%E5%9C%A8%E6%96%B0%E6%A0%87%E7%AD%BE%E9%A1%B5%E4%B8%AD%E6%89%93%E5%BC%80%E4%B9%A6%E7%AD%BE/bafanlmplgllnpdbemmppkbggiooifep)（Vitaliy Potapov，2.1 万+ 用户，微软精选认证）。

原插件闭源。本仓库按其官方公开描述的机制重建，并修复已知问题、增加新功能。全部数据本地处理。

## 功能（v0.1）

**核心（复刻原插件）**

- 左键点击书签 → 在新标签页打开，当前页不被覆盖
- 书签 URL 加 `newtab@` 标记；弹窗 / 选项页一键开关，全部可逆
- 纯本地实现，无外部跳转依赖

**增强与修复**

- **覆盖空白新标签页**（v0.1 首个新功能）：在空白新标签页（Edge 默认 NTP、about:blank 等）点击书签时，直接在当前页打开，不再叠加一个新标签。可在选项中关闭
- **自定义空白页规则**：第三方新标签页（如 Momentum）可加入正则匹配，同样被覆盖
- **中键 / Ctrl 点击书签不再多开空白标签**（原插件会先多开一个新标签再叠一个书签页）
- **卸载安全**：即使扩展损坏或被卸载而未还原，书签仍可正常打开（前缀位于 URL 的 userinfo 位置，被浏览器忽略，仅地址栏外观残留标记）——原插件卸载不还原会留下打不开的书签
- **手动豁免**：编辑书签 URL 去掉 `newtab@` 前缀即可豁免该书签，不会被自动补回
- **非 http(s) 书签不改写**：`javascript:`、`edge://`、`file:` 等保持浏览器默认行为

## 机制

1. 开启时，为所有 http(s) 书签 URL 插入 `newtab@` 标记（位于 userinfo 位置，保留原 scheme）：
   `https://example.com/a` → `https://newtab@example.com/a`
2. `declarativeNetRequest` 动态规则拦截所有 `^https?://newtab@` 的主框架导航，重定向到扩展的 `open.html`
3. `open.html` 询问后台落点：
   - 当前是空白新标签页（或该标签本就是为这次书签导航新建的——中键点击）→ `tabs.update` 直接覆盖当前页
   - 否则 → `tabs.create` 新建标签打开书签，`open.html` 再 `history.back()` 恢复用户原页面

关键前提（原插件同款机制，经其 2.1 万用户验证，本仓库亦在真机 Edge 实测通过）：浏览器把 URL 的 userinfo 原样带进网络层，DNR 得以命中；而 userinfo 本身被浏览器忽略——这正是"关闭后书签仍可用"的原因。

## 与原版已知问题的对照

| 原版已知问题 | EdgeBetter |
| --- | --- |
| 部分书签图标短暂丢失，首次打开后恢复 | 机制固有（URL 变化导致 favicon 缓存失效），保持同样行为 |
| 部分网站弹"要离开此站点吗" | 机制固有（离开带 beforeunload 的页面不可避免），点击"离开"后原页面仍保留 |
| 地址栏星标认不出当前网站已收藏 | 机制固有（书签 URL 带前缀），扩展侧无法修复 |
| 受限域名依赖外部 `bookmarks-evz.pages.dev` 静态跳转页 | 已去除，纯本地实现 |
| 卸载不还原 → 书签 URL 损坏 | 已修复（见"卸载安全"） |
| 中键点击书签多开空白标签 | 已修复 |

## 安装

1. Edge 地址栏输入 `edge://extensions`
2. 打开左下角"开发人员模式"
3. 点"加载解压缩的扩展"，选择本目录（`E:\project\EdgeBetter`）
4. 工具栏出现 EdgeBetter 图标。**首次安装默认开启**（会改写全部书签，弹窗可一键关闭并还原）

## 使用

- **弹窗**（点工具栏图标）：总开关 + 已改写书签数量 + 进入设置
- **选项页**（右键图标 → 选项）：
  - 总开关、覆盖空白新标签页开关
  - 自定义空白页正则（每行一条，如 `^https://momentumdash\.com/`）
  - 重新扫描统计 / 重新改写全部 / 恢复所有书签为原始 URL
- **豁免单个书签**：手动编辑该书签 URL、去掉 `newtab@` 前缀
- **卸载前**：先点"恢复所有书签为原始 URL"（不还原也不影响书签可用性，见上）

## 开发

```
background.js        MV3 Service Worker：书签改写 / DNR / 标签页调度
open.html / open.js  重定向落地页（问后台、history.back 恢复）
popup.* / options.*  弹窗与选项页
lib/                 纯函数：前缀、空白页判定、落点决策、改写计划（background 与页面共用）
test/                单元测试（node:test，23 项）
tools/browser-test.cjs  真机 Edge 集成测试
icons/gen_icons.py  图标生成脚本（Pillow）
```

单元测试：

```bash
node --test
```

浏览器集成测试（playwright-core 驱动本机 Edge + 临时 profile + 加载扩展，CDP 模拟书签点击的主框架导航）：

```bash
NODE_PATH="C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/workspace/node_modules" \
  "C:/Users/ZenithChunyang/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe" tools/browser-test.cjs
```

2026-10-16 实测 13/13 通过：覆盖空白页、新建标签 + 原页恢复、中键防叠标签、开关与降级、选项页。**测试只操作临时 profile，绝不碰用户真实 Edge profile。**

## 路线图（待定）

- 快捷键切换总开关
- 书签快速搜索弹窗
- 书签默认后台打开（不抢焦点）
- 打开记录统计
