/**
 * EdgeBetter —— 书签导航落点决策（纯函数）
 */
import { isBlankPage } from './ntp.js';
import { isPrefixed } from './bookmark-url.js';

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

/**
 * 判断一次书签导航**此刻**的状态——用于决定怎么"取消"它（纯函数）。
 *
 *  - 'pending' ：newtab@ 导航还没提交，当前页还在 → 用同文档导航（原 URL + fragment）取消它，
 *                文档不卸载、DOM 状态完整保留。
 *  - 'hijacked'：导航已经提交，当前页已被书签页顶掉。此时**不能**再 tabs.update 导航回原页
 *                （那是跨文档导航 = 整页重载）；应该 tabs.goBack() 回退一步——原页在 bfcache 里，
 *                会被冻结-恢复，状态无损、无重载。
 *
 * 什么时候会 'hijacked'：Service Worker 被空闲回收后（MV3 常态），事件送达时导航早已提交
 * （实测 20~50ms 就提交，而冷启动唤醒要几十到几百毫秒）。
 *
 * @param {object} opts
 * @param {string|undefined} opts.prevUrl 导航发生前该标签页的 URL（未知则传 undefined）
 * @param {string|undefined} opts.curUrl 该标签页此刻的实时 URL
 * @param {string} opts.target 书签真正的目标 URL（已去前缀）
 */
export function navState({ prevUrl, curUrl, target }) {
  if (prevUrl === undefined || curUrl === undefined) return 'pending'; // 信息不足：按未提交处理
  if (curUrl === prevUrl) return 'pending'; // 还停在原页
  if (curUrl === target) return 'hijacked'; // 已经变成书签目标页
  if (isPrefixed(curUrl)) return 'hijacked'; // 还带着 newtab@ 标记（部分版本会保留 userinfo）
  return 'pending'; // 其它（页面自己改了 hash 等）仍按未提交处理
}
