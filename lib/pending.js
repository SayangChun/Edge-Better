/**
 * Edge Better —— 待处理书签的 URL 反查（纯函数，background 与测试共用）
 *
 * 新建书签在"收藏气泡可能还开着"的窗口里先不加前缀。这段时间它没有 newtab@ 标记，
 * 点它不会走扩展的导航通道，所以要在 webNavigation 里按 URL 反查：
 * "这次导航的目标，是不是我正等着加前缀的那个书签？"
 */

/**
 * 在待处理表里按 URL 找书签 id。
 * @param {Record<string, {url: string}>} pending id -> 记录
 * @param {string} url 本次主框架导航的目标 URL
 * @returns {string|null} 命中的书签 id
 */
export function findPendingByUrl(pending, url) {
  if (!pending || typeof url !== 'string') return null;
  for (const [id, rec] of Object.entries(pending)) {
    if (rec && rec.url === url) return id;
  }
  return null;
}
