/**
 * EdgeBetter —— 书签树改写计划（纯函数，便于测试与审计）
 */
import { addPrefix, removePrefix, isPrefixed, isRewriteable } from './bookmark-url.js';

/**
 * 遍历书签树，生成改写计划。
 * @param {Array} nodes chrome.bookmarks.getTree() 返回的节点数组
 * @param {'enable'|'disable'} mode enable=加前缀，disable=去前缀
 * @returns {{id:string, from:string, to:string}[]}
 */
export function planPrefixUpdates(nodes, mode) {
  const ops = [];
  const walk = (list) => {
    for (const node of list || []) {
      if (node.url) {
        if (mode === 'enable' && isRewriteable(node.url) && !isPrefixed(node.url)) {
          const to = addPrefix(node.url);
          if (to) ops.push({ id: node.id, from: node.url, to });
        } else if (mode === 'disable' && isPrefixed(node.url)) {
          ops.push({ id: node.id, from: node.url, to: removePrefix(node.url) });
        }
      }
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return ops;
}

/** 统计已被改写的书签数量 */
export function countPrefixed(nodes) {
  let n = 0;
  const walk = (list) => {
    for (const node of list || []) {
      if (node.url && isPrefixed(node.url)) n += 1;
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return n;
}
