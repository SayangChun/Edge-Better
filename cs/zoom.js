/**
 * Edge Better —— 触控板捏合「局部放大」
 *
 * 桌面 Edge 把触控板捏合合成为 ctrl+wheel，交给浏览器做 page zoom（整体缩放、
 * 布局重排）。本脚本在捕获阶段抢下这个事件，改用 transform: scale() 只放大
 * 可视区域，布局不变——即手机/触屏那种 visual viewport zoom 的手感。
 *
 * 已知代价（README「触控板捏合放大局部」一节有完整说明）：
 *   - position: fixed 的元素会失效：transform 给根元素建立了 containing block，
 *     fixed 元素改为相对文档定位，滚动时跟着内容一起走、并可能跑出视口
 *   - 网站自己实现的 ctrl+wheel 缩放（地图 / PDF / 图片查看器）会被抢走
 *   - iframe 内部不生效（只注入顶层文档）
 *
 * 关闭方式：选项页关掉开关，或对单个站点关掉；Ctrl+0 重置当前页缩放。
 */
(() => {
  if (window.__edgeBetterZoomInstalled) return;
  window.__edgeBetterZoomInstalled = true;

  const MIN_SCALE = 1;
  const MAX_SCALE = 5;
  /** 滚轮增量到缩放倍率的灵敏度：deltaY=-100 约放大 16% */
  const SENSITIVITY = 0.0015;

  // 乐观默认开启：storage.get 是异步的，若等它返回再启用，页面刚加载后的
  // 第一次捏合会被漏掉（那一下会退回浏览器的 page zoom）。读到设置后再校正。
  let enabled = true;
  let scale = MIN_SCALE;
  let originX = 0;
  let originY = 0;

  const root = document.documentElement;
  /** 仅在 URL 带 ?ebdebug 时把最近一次 deltaY 写到 DOM，供探针判断事件是否到达 */
  const DEBUG = /[?&]ebdebug\b/.test(location.search);

  function apply() {
    if (scale <= MIN_SCALE + 0.0001) {
      scale = MIN_SCALE;
      root.style.transform = '';
      root.style.transformOrigin = '';
      return;
    }
    root.style.transformOrigin = `${originX}px ${originY}px`;
    root.style.transform = `scale(${scale})`;
  }

  function reset() {
    if (scale === MIN_SCALE) return;
    scale = MIN_SCALE;
    apply();
  }

  function onWheel(e) {
    if (!e.ctrlKey) return;
    if (DEBUG) root.setAttribute('data-eb-dy', String(Math.round(e.deltaY)));
    if (!enabled) return;
    // 抢在网站自己的处理之前，同时阻止浏览器把它当成 page zoom
    e.preventDefault();
    e.stopImmediatePropagation();

    // 以光标位置为锚点：缩放后光标下的内容保持不动
    originX = e.clientX + window.scrollX;
    originY = e.clientY + window.scrollY;

    const factor = Math.exp(-e.deltaY * SENSITIVITY);
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    apply();
  }

  function onKeyDown(e) {
    if (!enabled) return;
    // Ctrl+0 重置（浏览器自身的 page zoom 重置不受影响，因为本脚本从不改 page zoom）
    if (e.ctrlKey && (e.key === '0' || e.code === 'Digit0')) {
      reset();
    }
  }

  // 捕获阶段：抢在页面自身的 wheel 监听之前
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });
  window.addEventListener('keydown', onKeyDown, { capture: true });

  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) reset();
  }

  /** 域名是否命中排除列表（精确匹配或子域） */
  function isExcluded(hostname, list) {
    const host = String(hostname || '').toLowerCase();
    return (list || []).some((d) => {
      const dom = String(d || '').toLowerCase();
      return dom && (host === dom || host.endsWith('.' + dom));
    });
  }

  let config = { pinchLocalZoom: true, zoomExcluded: [] };

  function sync() {
    setEnabled(config.pinchLocalZoom !== false && !isExcluded(location.hostname, config.zoomExcluded));
  }

  chrome.storage.local.get(['pinchLocalZoom', 'zoomExcluded'], (stored) => {
    config = {
      pinchLocalZoom: stored.pinchLocalZoom !== false,
      zoomExcluded: Array.isArray(stored.zoomExcluded) ? stored.zoomExcluded : [],
    };
    sync();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.pinchLocalZoom) config.pinchLocalZoom = changes.pinchLocalZoom.newValue !== false;
    if (changes.zoomExcluded) {
      config.zoomExcluded = Array.isArray(changes.zoomExcluded.newValue) ? changes.zoomExcluded.newValue : [];
    }
    if (changes.pinchLocalZoom || changes.zoomExcluded) sync();
  });
})();
