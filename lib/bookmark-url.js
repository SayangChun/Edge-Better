/**
 * Edge Better —— 书签 URL 前缀处理（纯函数，background / options / 测试共用）
 *
 * 机制：给 http(s) 书签 URL 的 userinfo 位置插入 "newtab@" 标记。
 * 浏览器会把 userinfo 原样带进网络层，DNR 由此命中并重定向到扩展落地页；
 * 扩展关闭或损坏时，userinfo 被浏览器忽略，书签仍指向原网站（优雅降级）。
 */

/** 是否已被 Edge Better 改写过的 URL */
export const PREFIXED_RE = /^https?:\/\/newtab@/i;

/** 可改写的 URL：仅 http/https（javascript: / edge: / file: / data: 等一律不动） */
export function isRewriteable(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/** 是否已带 newtab@ 前缀 */
export function isPrefixed(url) {
  return typeof url === 'string' && PREFIXED_RE.test(url);
}

/**
 * 加前缀（保留原 scheme：http 的书签加 http://newtab@，https 的加 https://newtab@）
 * 不可改写或已改写时返回 null，由调用方跳过。
 */
export function addPrefix(url) {
  if (!isRewriteable(url) || isPrefixed(url)) return null;
  return url.replace(/^(https?:\/\/)/i, '$1newtab@');
}

/** 去前缀（恢复原始 URL；无前缀时原样返回） */
export function removePrefix(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/^(https?):\/\/newtab@/i, '$1://');
}
