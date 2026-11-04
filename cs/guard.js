/**
 * Edge Better —— 当前页「无感」守卫
 *
 * 两件事，目标相同：点书签打开新标签时，当前页既不能被顶掉，也不能被惊动。
 *
 * 1) 事件静默（v0.3.1 修「看直播时点书签，直播暂停」）
 *    书签点击会让浏览器先把当前标签导航到 https://newtab@target，扩展只能用
 *    「导航到 原URL + #edge-better」把它取消掉。这是同文档导航，文档不卸载，
 *    但会触发 popstate + hashchange —— SPA（直播站基本都是）会当成路由变化
 *    重新渲染，播放器被销毁或暂停。实测：B 类页面（hash 路由）点一次书签就
 *    paused=true，currentTime 不再推进。
 *    本脚本在 document_start 注入，比页面脚本更早注册**捕获阶段**监听器，
 *    只在 hash 是取消标记时 stopImmediatePropagation，页面完全感知不到。
 *
 * 2) SW 保活
 *    MV3 的 SW 空闲 30s 被回收，而取消导航只有 20~50ms 的窗口；chrome.alarms
 *    的最小周期也是 30s，正好卡在回收阈值上，实际经常来不及（冷启动必输）。
 *    改成从页面侧每 20s 发一条消息：只要还有普通网页开着，SW 就不会睡。
 */
(() => {
  /** 取消 pending 导航时用的固定 fragment（与 background.js 的 RESTORE_FRAGMENT 一致） */
  const MARKERS = ['#edge-better', '#edge-better2'];
  const isMarker = () => MARKERS.includes(location.hash);

  // fragment 导航会把 history.state 顶成 null。留一份最近的非 null 快照，
  // 吞事件时顺手恢复，免得 SPA 读到 null 之后崩掉。
  let lastState = null;
  setInterval(() => {
    if (history.state !== null) lastState = history.state;
  }, 300);

  function silence(e) {
    if (!isMarker()) return;
    if (lastState !== null && history.state === null) {
      try {
        history.replaceState(lastState, '', location.href);
      } catch {
        /* 极端情况（URL 不可写）：放弃恢复 state，但事件照样吞掉 */
      }
    }
    e.stopImmediatePropagation();
  }

  // 捕获阶段 + document_start：一定排在页面自己的监听器之前
  window.addEventListener('popstate', silence, true);
  window.addEventListener('hashchange', silence, true);

  // ---- SW 保活 ----
  // 隐藏标签页的定时器会被节流到 1 分钟一次；此时用户不在看这个页面，
  // 保活断档可以接受（活跃标签不会节流）。
  setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
    } catch {
      /* 扩展被重载 / 上下文失效 */
    }
  }, 20_000);
})();
