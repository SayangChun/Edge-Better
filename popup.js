/** Edge Better —— 弹窗：快捷开关 + 统计 */
const toggle = document.getElementById('toggle');
const statsEl = document.getElementById('stats');
const hintEl = document.getElementById('hint');

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'getState' });
  toggle.checked = !!state.enabled;
  const n = state.stats && typeof state.stats.prefixedCount === 'number' ? state.stats.prefixedCount : 0;
  statsEl.textContent = state.enabled ? `已改写书签 ${n} 个` : '已关闭（书签已还原为原始 URL）';
  hintEl.textContent = state.enabled && state.overrideBlankTab
    ? '在空白新标签页点书签，将直接在该页打开'
    : '';
}

toggle.addEventListener('change', async () => {
  toggle.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'setEnabled', value: toggle.checked });
  } finally {
    toggle.disabled = false;
    refresh();
  }
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

refresh();
