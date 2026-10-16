/*
 * 小程序靜態檢查（不需要開發者工具即可跑）：
 *   node tools/check-miniprogram.js
 * 檢查：app.json 頁面齊備、WXML 標籤閉合、事件常式存在、模板欄位存在、
 *       殘留 wxs（WXS 方言限制多，本專案刻意不用）、class 是否都有樣式定義。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
let bad = 0;
const fail = (m) => { bad++; console.log('  X ' + m); };

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
for (const p of appJson.pages) {
  for (const ext of ['.js', '.json', '.wxml']) {
    if (!fs.existsSync(path.join(ROOT, p + ext))) fail(`app.json 頁面缺檔 ${p}${ext}`);
  }
}
console.log(`app.json：${appJson.pages.length} 支頁面檔案齊備`);

function classesOf(css) {
  const s = new Set();
  for (const m of (css || '').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) s.add(m[1]);
  return s;
}
const appCss = classesOf(fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8'));

const wxmls = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.wxml')) wxmls.push(p);
  }
})(path.join(ROOT, 'pages'));

const BUILTIN = new Set(['true', 'false', 'null', 'undefined', 'Math', 'JSON', 'String', 'Number', 'Boolean',
  'length', 'split', 'replace', 'trim', 'map', 'filter', 'find', 'join', 'slice', 'then', 'toFixed', 'indexOf']);

for (const wp of wxmls) {
  const label = path.relative(ROOT, wp);
  const w = fs.readFileSync(wp, 'utf8');
  const js = fs.readFileSync(wp.replace(/\.wxml$/, '.js'), 'utf8');
  const ownCss = classesOf(fs.readFileSync(wp.replace(/\.wxml$/, '.wxss'), 'utf8'));
  const hasClass = (c) => appCss.has(c) || ownCss.has(c);

  if (/<wxs/i.test(w)) fail(`${label} 使用了 wxs（WXS 不支援正則字面量與 Number() 等，本專案不用）`);

  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)\s*>/g;
  let m;
  while ((m = tagRe.exec(w))) {
    if (m[1]) {
      const top = stack.pop();
      if (top !== m[2]) fail(`${label} 標籤不匹配：開 <${top}> 閉 </${m[2]}>`);
    } else if (!m[4]) stack.push(m[2]);
  }
  if (stack.length) fail(`${label} 未閉合標籤：${stack.join(',')}`);

  const handlers = new Set();
  const hRe = /\b(?:bind|catch|capture-bind|capture-catch)[:]?([a-zA-Z]+)\s*=\s*"([^"{}]+)"/g;
  while ((m = hRe.exec(w))) handlers.add(m[2].trim());
  for (const h of handlers) {
    if (!new RegExp('(^|[\\s,{])' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[(:]', 'm').test(js)) {
      fail(`${label} 綁定 ${h}，但 ${path.basename(wp)} 對應的 js 沒有這個方法`);
    }
  }

  const local = new Set(['item', 'index']);
  for (const im of w.matchAll(/wx:for-item="([^"]+)"|wx:for-index="([^"]+)"/g)) local.add(im[1] || im[2]);
  const ids = new Set();
  for (const e of w.matchAll(/\{\{([^}]*)\}\}/g)) {
    const cleaned = e[1].replace(/"[^"]*"|'[^']*'/g, "''");
    for (const id of cleaned.matchAll(/(?<![\w$.-])([a-zA-Z_$][\w$]*)\b(?!\s*:?\s*\()/g)) ids.add(id[1]);
  }
  for (const id of ids) {
    if (local.has(id) || BUILTIN.has(id)) continue;
    if (!new RegExp('\\b' + id.replace(/\$/g, '\\$') + '\\b').test(js)) fail(`${label} 模板用到 {{${id}}}，js 裡沒有該欄位`);
  }

  const used = new Set();
  for (const c of w.matchAll(/class="([^"]*)"/g)) {
    for (const x of c[1].replace(/\{\{[^}]*\}\}/g, ' ').split(/\s+/)) if (x) used.add(x);
    for (const e of c[1].matchAll(/\{\{([^}]*)\}\}/g)) {
      for (const s of e[1].matchAll(/'([^']*)'|"([^"]*)"/g)) {
        for (const x of (s[1] || s[2] || '').split(/\s+/)) if (x) used.add(x);
      }
    }
  }
  for (const h of w.matchAll(/hover-class="([^"]+)"/g)) used.add(h[1]);
  for (const c of used) {
    // 跳過「動態拼接的字串比較值」造成的誤報：只檢查含連字符或駝峰的樣式名
    if (!/[-_]/.test(c) && !/[A-Z]/.test(c)) continue;
    if (!hasClass(c)) fail(`${label} class "${c}" 沒有對應樣式定義`);
  }

  console.log(`  ${label}：${handlers.size} 事件、${ids.size} 模板欄位、${used.size} class 已核對`);
}

console.log(bad ? `\n發現 ${bad} 個問題` : '\n小程序靜態檢查全部通過');
process.exit(bad ? 1 : 0);
