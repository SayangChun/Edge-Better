/**
 * EdgeBetter —— 书签导航落点决策（纯函数）
 */
import { isBlankPage } from './ntp.js';

/**
 * 决定一次 newtab@ 书签导航的落点：
 *  - 'override'      ：覆盖当前标签页（当前是空白新标签页，或该标签本就是为这个书签新建的——中键/Ctrl 点击）
 *  - 'create-restore'：照原插件逻辑，新建标签页打开书签，原页面保留
 *
 * @param {object} opts
 * @param {string|undefined} opts.prevUrl 导航发生前当前标签页的 URL
 * @param {boolean} opts.createdForBookmark 该标签页是否是为这次书签导航新建的
 * @param {string[]} opts.extraBlankPatterns 用户自定义的额外空白页正则
 */
export function decideAction({ prevUrl, createdForBookmark = false, extraBlankPatterns = [] }) {
  if (createdForBookmark) return 'override';
  if (isBlankPage(prevUrl, extraBlankPatterns)) return 'override';
  return 'create-restore';
}
