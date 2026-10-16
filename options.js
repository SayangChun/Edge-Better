/** EdgeBetter —— 选项页 */
const $ = (id) => document.getElementById(id);
const toast = $('toast');
let toastTimer = 0;

function showToast(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

async function getState() {
  return chrome.runtime.sendMessage({ type: 'getState' });
}

async function refresh() {
  const state = await getState();
  $('toggleEnabled').checked = !!state.enabled;
  $('toggleOverride').checked = state.overrideBlankTab !== false;
  $('patterns').value = (state.extraBlankPatterns || []).join('\n');
  const n = state.stats && typeof state.stats.prefixedCount === 'number' ? state.stats.prefixedCount : 0;
  const t = state.stats && state.stats.lastScan ? new Date(state.stats.lastScan).toLocaleString() : '—';
  $('statsLine').innerHTML = `已改写书签：<b>${n}</b> 个 · 最近扫描：${t}`;
}

$('toggleEnabled').addEventListener('change', async (e) => {
  e.target.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'setEnabled', value: e.target.checked });
    showToast(e.target.checked ? '已开启' : '已关闭，书签已还原');
  } catch {
    /* ignore */
  } finally {
    e.target.disabled = false;
    refresh();
  }
});

$('toggleOverride').addEventListener('change', async (e) => {
  try {
    await chrome.runtime.sendMessage({ type: 'saveSettings', overrideBlankTab: e.target.checked });
    showToast('已保存');
  } catch {
    /* ignore */
  }
});

$('savePatterns').addEventListener('click', async () => {
  const patterns = $('patterns').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = patterns.filter((p) => {
    try { new RegExp(p); return false; } catch { return true; }
  });
  try {
    await chrome.runtime.sendMessage({ type: 'saveSettings', extraBlankPatterns: patterns });
    $('patternsHint').textContent = bad.length
      ? `已保存 ${patterns.length} 条（${bad.length} 条不是合法正则，已被忽略）`
      : `已保存 ${patterns.length} 条`;
    showToast('已保存');
  } catch {
    /* ignore */
  }
});

$('rescan').addEventListener('click', async () => {
  await refresh();
  showToast('已重新扫描');
});

$('rewriteAll').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'setEnabled', value: true });
  showToast('已重新改写全部书签');
  refresh();
});

$('restoreAll').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'setEnabled', value: false });
  showToast('所有书签已还原为原始 URL');
  refresh();
});

refresh();
