/**
 * Edge Better —— 空白 / 新建标签页判定（纯函数）
 *
 * 覆盖空白新标签页功能的前置判断：当前标签页是不是"没有内容可保护"的新标签页。
 */

/** 内置空白页匹配（Edge 优先，兼顾 Chrome / 旧版 MSN NTP） */
const BUILTIN_BLANK_PATTERNS = [
  /^edge:\/\/newtab\/?$/i, // Edge 默认新标签页
  /^about:newtab\/?$/i, // Chromium 新标签页
  /^chrome:\/\/newtab\/?$/i, // Chrome 新标签页
  /^about:blank\/?$/i, // 空白页
  /^about:home\/?$/i,
  /^https?:\/\/ntp\.msn\.com\//i, // MSN 版新标签页
  /^https?:\/\/(www\.)?msn\.(com|cn)\/spartan\/ntp/i, // 旧版中文 MSN NTP
];

/** url 为空（刚创建、尚未加载）视为空白 */
export function isBlankPage(url, extraPatterns = []) {
  if (!url) return true;
  if (BUILTIN_BLANK_PATTERNS.some((re) => re.test(url))) return true;
  return extraPatterns.some((src) => {
    try {
      return new RegExp(src, 'i').test(url);
    } catch {
      return false; // 用户写错正则时静默忽略该条
    }
  });
}

/** 内置空白页模式列表（供选项页展示） */
export function builtinBlankPatterns() {
  return BUILTIN_BLANK_PATTERNS.map((re) => re.source);
}
