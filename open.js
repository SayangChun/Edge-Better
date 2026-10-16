/**
 * EdgeBetter —— open.html 落地页
 *
 * DNR 把 newtab@ 导航重定向到这里。本页询问后台应把书签落在哪里：
 *  - 后台已覆盖当前标签页（override）→ 无需任何操作，本页即将被目标页替换
 *  - 后台已新建标签（create-restore）→ history.back() 恢复用户原来的页面
 *  - 拿不到响应（后台未唤醒等）→ history.back() 恢复原页面，不卡死
 */
async function ask() {
  for (let i = 0; i < 25; i++) {
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({ type: 'openBookmark' });
    } catch {
      res = null;
    }
    if (res && res.action) return res;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

const res = await ask();
if (!res || res.action === 'create-restore') {
  try {
    history.back();
  } catch {
    /* 无历史可退则保持现状 */
  }
}
// res.action === 'override'：后台已把当前标签页导航到书签地址，无需处理
