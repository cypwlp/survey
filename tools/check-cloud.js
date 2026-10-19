/*
 * 云函数静态检查 + 本机自测（不需要开发者工具、不需要云环境）：
 *     node tools/check-cloud.js
 * 检查：文件齐备、语法正确、没有误用 ESM 语法、package.json 依赖、
 *       project.config.json 指到 cloudfunctions/、小程序 config 里的云函数名对得上，
 *       最后跑一遍 test/local-smoke.js（内存驱动，全链路）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'cloudfunctions', 'osurvey');
let bad = 0;
const fail = (m) => { bad++; console.log('  X ' + m); };

const FILES = ['index.js', 'router.js', 'db.js', 'lib/questions.js', 'lib/stats.js', 'lib/memory-db.js', 'package.json', 'test/local-smoke.js'];
for (const f of FILES) {
  if (!fs.existsSync(path.join(FN, f))) fail(`云函数缺文件：cloudfunctions/osurvey/${f}`);
}
console.log(`云函数文件：${FILES.length} 个已核对`);

const jsFiles = FILES.filter((f) => f.endsWith('.js'));
for (const f of jsFiles) {
  const full = path.join(FN, f);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, 'utf8');
  if (/^\s*(import|export)\s/m.test(src)) fail(`${f} 出现 ESM 语法（云函数要 CommonJS）`);
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
  } catch (e) {
    fail(`${f} 语法不过：${String(e.stderr || e.message).split('\n')[0]}`);
  }
}
console.log('语法检查：全部通过（CommonJS）');

const pkg = JSON.parse(fs.readFileSync(path.join(FN, 'package.json'), 'utf8'));
for (const dep of ['wx-server-sdk', 'exceljs']) {
  if (!pkg.dependencies || !pkg.dependencies[dep]) fail(`package.json 少了依赖：${dep}`);
}
console.log('依赖声明：wx-server-sdk + exceljs');

const rootCfgPath = path.join(ROOT, 'project.config.json');
if (!fs.existsSync(rootCfgPath)) fail('项目根目录缺 project.config.json（开发者工具要用它找云函数）');
else {
  const cfg = JSON.parse(fs.readFileSync(rootCfgPath, 'utf8'));
  if (cfg.cloudfunctionRoot !== 'cloudfunctions/') fail(`project.config.json 的 cloudfunctionRoot 应是 cloudfunctions/，现在是 ${cfg.cloudfunctionRoot}`);
  if (cfg.miniprogramRoot !== 'miniprogram/') fail(`project.config.json 的 miniprogramRoot 应是 miniprogram/，现在是 ${cfg.miniprogramRoot}`);
  if (!cfg.appid) fail('project.config.json 缺 appid');
  console.log(`开发者工具项目：小程序 ${cfg.miniprogramRoot} + 云函数 ${cfg.cloudfunctionRoot}`);
}

const mpCfg = fs.readFileSync(path.join(ROOT, 'miniprogram', 'config.js'), 'utf8');
const m = mpCfg.match(/CLOUD_FUNCTION:\s*'([^']*)'/);
const fnName = m ? m[1] : '';
if (fnName && fnName !== 'osurvey') fail(`miniprogram/config.js 的 CLOUD_FUNCTION 是 '${fnName}'，但云函数目录叫 osurvey`);
if (!fnName) console.log('提醒：miniprogram/config.js 的 CLOUD_FUNCTION 还是空的 → 现在走自架 https 链路（填上 osurvey 即切云开发）');
else console.log(`小程序已指向云函数：${fnName}`);

console.log('\n跑一遍云函数本机自测（内存驱动）…');
try {
  const out = execFileSync(process.execPath, [path.join(FN, 'test', 'local-smoke.js')], { encoding: 'utf8' });
  const last = out.trim().split('\n').pop();
  console.log('  ' + last);
  if (!/通過/.test(out) || /✗/.test(out)) fail('本机自测有失败项');
} catch (e) {
  fail('本机自测跑不起来：' + String(e.stdout || e.message).slice(-300));
}

console.log(bad ? `\n发现 ${bad} 个问题` : '\n云函数检查 + 自测全部通过');
process.exit(bad ? 1 : 0);
