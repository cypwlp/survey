<template>
  <div class="shell">
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="../index.html">
          <span class="logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h6M9 3h6v4H9z"/><path d="M7 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><path d="m9 14 2 2 4-4"/></svg>
          </span>
          <span>小威問卷</span>
        </a>
        <nav class="nav">
          <a href="../index.html">我的問卷</a>
          <a href="../account.html">帳號</a>
          <a :href="'../survey.html?id=' + id">返回問卷</a>
        </nav>
      </div>
    </header>

    <main class="wrap">
      <section class="hero">
        <el-tag round effect="light" class="eyebrow-tag">回收統計</el-tag>
        <h1>{{ stats ? stats.title : '載入中…' }}</h1>
        <p v-if="stats">{{ statusText }}｜{{ modeText }}<template v-if="stats.deadline">｜截止 {{ fmt(stats.deadline, true) }}</template></p>
      </section>

      <el-skeleton v-if="loading" :rows="8" animated class="block" />

      <el-result v-else-if="needLogin" icon="warning" title="需要先登入" sub-title="這個對照版讀的是同一份資料，請先登入管理端">
        <template #extra>
          <el-button type="primary" @click="goLogin">去登入</el-button>
        </template>
      </el-result>

      <template v-else-if="stats">
        <div class="kpis">
          <div class="kpi kpi-hero">
            <div class="kpi-value">{{ stats.answerCount || 0 }}</div>
            <div class="kpi-label">份提交</div>
            <span class="kpi-dot" />
          </div>
          <div class="kpi">
            <div class="kpi-value">{{ stats.visitCount || 0 }}</div>
            <div class="kpi-label">人開啟</div>
          </div>
          <div class="kpi">
            <div class="kpi-value">{{ rate }}<small>%</small></div>
            <div class="kpi-label">提交／開啟</div>
          </div>
        </div>

        <div class="columns">
          <el-card shadow="never" class="block">
            <template #header>
              <div class="card-head">
                <span class="card-title">近 7 天提交</span>
                <span class="card-sub">今天 {{ today }} 份</span>
              </div>
            </template>
            <div class="trend">
              <div v-for="d in stats.daily" :key="d.label" class="trend-col">
                <div class="trend-val">{{ d.count || '' }}</div>
                <div class="trend-track">
                  <div class="trend-bar" :style="{ height: barHeight(d.count) }" />
                </div>
                <div class="trend-label">{{ d.label }}</div>
              </div>
            </div>
          </el-card>

          <el-card shadow="never" class="block export">
            <template #header>
              <div class="card-head">
                <span class="card-title">匯出</span>
                <span class="card-sub">時間已轉 +8</span>
              </div>
            </template>
            <div class="export-btns">
              <el-button type="primary" @click="exportFile('xlsx')">匯出 Excel</el-button>
              <el-button @click="exportFile('csv')">匯出 CSV</el-button>
            </div>
            <p class="export-hint">Excel 含答卷明細與統計摘要；CSV 適合貼到其他系統。</p>
          </el-card>
        </div>

        <el-card
          v-for="(q, i) in stats.questions"
          :key="q.k"
          shadow="hover"
          class="block question"
        >
          <template #header>
            <div class="q-head">
              <span class="q-no">{{ i + 1 }}</span>
              <span class="q-title">{{ q.title }}</span>
              <el-tag size="small" effect="plain" round>{{ typeLabel(q) }}</el-tag>
            </div>
          </template>
          <div class="q-meta">已回收 {{ q.answerCount || 0 }} 份</div>

          <template v-if="q.type === 'choice'">
            <div class="stack">
              <span
                v-for="(d, idx) in q.distribution || []"
                :key="d.option"
                :style="{ width: d.pct + '%', background: color(idx) }"
              />
            </div>
            <div v-for="(d, idx) in q.distribution || []" :key="d.option" class="dist-row">
              <div class="dist-head">
                <span class="dist-name"><i :style="{ background: color(idx) }" />{{ d.option }}</span>
                <span class="dist-num"><b>{{ d.pct }}%</b> · {{ d.count }} 份</span>
              </div>
              <el-progress
                :percentage="d.pct"
                :color="color(idx)"
                :stroke-width="8"
                :show-text="false"
              />
            </div>
          </template>

          <template v-else>
            <div v-if="(q.words || []).length && q.k !== 'name'" class="cloud">
              <el-tag
                v-for="w in q.words"
                :key="w.w"
                :size="w.n === maxWord(q) ? 'large' : 'default'"
                :type="w.n === maxWord(q) ? 'primary' : 'info'"
                effect="light"
                round
              >{{ w.w }}</el-tag>
            </div>
            <div v-if="(q.texts || []).length" class="answers">
              <div v-for="(t, idx) in q.texts" :key="idx" class="answer">
                <p>{{ t.value }}</p>
                <small>{{ t.openid }} · {{ fmt(t.submitTime) }}</small>
              </div>
            </div>
            <el-empty v-else description="還沒有人回答這一題" :image-size="72" />
          </template>
        </el-card>

        <footer class="foot">Vue 3 + Element Plus 對照版 · 資料與正式統計頁相同</footer>
      </template>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';

const id = new URLSearchParams(location.search).get('id') || '8';
const COLORS = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
const stats = ref(null);
const loading = ref(true);
const needLogin = ref(false);
const today = computed(() => {
  const daily = stats.value && stats.value.daily;
  return daily && daily.length ? daily[daily.length - 1].count : 0;
});
const rate = computed(() => {
  if (!stats.value || !stats.value.visitCount) return '—';
  return Math.round((stats.value.answerCount / stats.value.visitCount) * 100);
});
const statusText = computed(() => {
  const s = stats.value;
  if (!s) return '';
  if (s.isClosed) return '問卷已結束';
  if (s.isExpired) return '問卷已截止';
  return '問卷進行中';
});
const modeText = computed(() => {
  const s = stats.value;
  if (!s) return '';
  return s.bindMode === 'group' ? (s.hasGroupBound ? '已綁定群組' : '待綁定群組') : '開放作答';
});

function color(i) { return COLORS[i % COLORS.length]; }
function typeLabel(q) { return q.type === 'choice' ? '單選' : (q.type === 'date' ? '日期' : '填充'); }
function maxWord(q) { return Math.max(1, ...(q.words || []).map((w) => w.n)); }
function barHeight(n) {
  const max = Math.max(1, ...(stats.value.daily || []).map((d) => d.count));
  return Math.round((n / max) * 100) + '%';
}
function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function api(path) {
  const res = await fetch('/api/admin/proxy', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'GET', path, data: {}, query: {} }),
  });
  if (res.status === 401) { needLogin.value = true; throw new Error('401'); }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function goLogin() { location.href = '../index.html?next=' + encodeURIComponent(location.pathname + location.search); }

async function exportFile(kind) {
  const res = await fetch(`/api/admin/proxy`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'GET', path: `/surveys/${id}/export.${kind}`, data: {}, query: {} }),
  });
  if (!res.ok) return;
  const data = await res.json();
  if (kind === 'csv') {
    const blob = new Blob([String(data || '')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `survey-${id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else if (data && data.base64) {
    const a = document.createElement('a');
    a.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + data.base64;
    a.download = data.filename || `survey-${id}.xlsx`;
    a.click();
  }
}

onMounted(async () => {
  try {
    stats.value = await api(`/surveys/${id}/stats`);
  } catch (e) {
    needLogin.value = needLogin.value || false;
  } finally {
    loading.value = false;
  }
});
</script>

<style>
:root {
  --el-color-primary: #4f46e5;
  --el-color-primary-light-3: #7c74f2;
  --el-color-primary-light-5: #a5a0f7;
  --el-color-primary-light-7: #cdc9fb;
  --el-color-primary-light-9: #eef1ff;
  --el-border-radius-base: 10px;
  --el-font-family: -apple-system, BlinkMacSystemFont, "PingFang TC", "PingFang SC", "Microsoft JhengHei", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #f5f6fa;
  background-image:
    radial-gradient(760px 420px at 6% -10%, rgba(79, 70, 229, .08), transparent 60%),
    radial-gradient(700px 380px at 100% 0, rgba(14, 165, 164, .06), transparent 58%);
  background-repeat: no-repeat;
  color: #151b26;
  font-family: var(--el-font-family);
}
a { color: inherit; text-decoration: none; }
.topbar {
  position: sticky; top: 0; z-index: 20;
  background: rgba(255, 255, 255, .82);
  backdrop-filter: blur(14px) saturate(180%);
  border-bottom: 1px solid #e9ecf3;
}
.topbar-inner { max-width: 1120px; margin: 0 auto; height: 62px; padding: 0 24px; display: flex; align-items: center; gap: 20px; }
.brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 800; letter-spacing: -.02em; }
.logo { width: 30px; height: 30px; border-radius: 10px; background: #4f46e5; color: #fff; display: grid; place-items: center; box-shadow: 0 8px 16px -8px rgba(79, 70, 229, .7); }
.logo svg { width: 17px; height: 17px; }
.nav { margin-left: auto; display: flex; gap: 4px; font-size: 13.5px; }
.nav a { color: #5f6b7c; font-weight: 600; padding: 8px 12px; border-radius: 9px; transition: .15s; }
.nav a:hover { background: #f1f3f9; color: #151b26; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 36px 24px 64px; }
.hero h1 { margin: 14px 0 6px; font-size: 34px; letter-spacing: -.03em; line-height: 1.2; }
.hero p { margin: 0 0 24px; color: #5f6b7c; font-size: 14px; }
.eyebrow-tag { font-weight: 700; }
.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 18px; }
.kpi { position: relative; background: #fff; border: 1px solid #e9ecf3; border-radius: 16px; padding: 20px; box-shadow: 0 1px 2px rgba(20, 27, 38, .03); overflow: hidden; }
.kpi-value { font-size: 34px; font-weight: 800; letter-spacing: -.04em; font-variant-numeric: tabular-nums; line-height: 1.1; }
.kpi-value small { font-size: 18px; margin-left: 2px; }
.kpi-label { margin-top: 4px; color: #8b95a7; font-size: 12px; }
.kpi-hero { background: linear-gradient(135deg, #4f46e5, #7c3aed 55%, #6d28d9); border-color: transparent; color: #fff; box-shadow: 0 18px 36px -24px rgba(79, 70, 229, .9); }
.kpi-hero .kpi-label { color: rgba(255, 255, 255, .78); }
.kpi-dot { position: absolute; right: -30px; top: -30px; width: 120px; height: 120px; border-radius: 50%; background: rgba(255, 255, 255, .12); }
.columns { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, .9fr); gap: 18px; align-items: start; }
.block { margin-bottom: 18px; border-radius: 16px; border-color: #e9ecf3; }
.block .el-card__header { border-bottom-color: #eef1f7; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.card-title { font-size: 15px; font-weight: 800; letter-spacing: -.01em; }
.card-sub { color: #8b95a7; font-size: 12px; }
.trend { display: flex; gap: 10px; align-items: flex-end; }
.trend-col { flex: 1; min-width: 0; text-align: center; }
.trend-val { height: 18px; color: #8b95a7; font-size: 10.5px; font-variant-numeric: tabular-nums; }
.trend-track { height: 110px; border-radius: 9px; background: linear-gradient(180deg, #f4f6fa, #eef1f7); display: flex; align-items: flex-end; overflow: hidden; }
.trend-bar { width: 100%; min-height: 3px; border-radius: 7px 7px 0 0; background: linear-gradient(180deg, #7c74f2, #4f46e5); box-shadow: 0 8px 16px -12px rgba(79, 70, 229, .9); transition: height .4s ease; }
.trend-label { margin-top: 6px; color: #8b95a7; font-size: 9.5px; }
.export-btns { display: flex; gap: 10px; flex-wrap: wrap; }
.export-hint { margin: 12px 0 0; color: #8b95a7; font-size: 11.5px; line-height: 1.6; }
.question { padding: 4px 0; }
.q-head { display: flex; align-items: flex-start; gap: 10px; }
.q-no { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 8px; background: #eef1ff; color: #4f46e5; font-size: 11.5px; font-weight: 800; display: grid; place-items: center; }
.q-title { flex: 1; min-width: 0; font-size: 15px; font-weight: 750; line-height: 1.5; }
.q-meta { color: #8b95a7; font-size: 11.5px; margin: 0 0 16px 36px; }
.stack { display: flex; height: 9px; border-radius: 99px; overflow: hidden; background: #eef1f7; margin-bottom: 18px; }
.stack span { display: block; height: 100%; }
.dist-row { margin-bottom: 14px; }
.dist-head { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; margin-bottom: 6px; }
.dist-name { display: inline-flex; align-items: center; gap: 8px; color: #2c3543; }
.dist-name i { width: 8px; height: 8px; border-radius: 50%; }
.dist-num { color: #8b95a7; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dist-num b { color: #151b26; font-size: 13px; }
.cloud { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px; background: #f8f9fc; border-radius: 12px; margin-bottom: 14px; }
.answers { border-top: 1px solid #eef1f7; }
.answer { padding: 13px 0; border-bottom: 1px solid #eef1f7; }
.answer:last-child { border-bottom: 0; }
.answer p { margin: 0; font-size: 13.5px; white-space: pre-wrap; word-break: break-word; }
.answer small { display: block; color: #8b95a7; font-size: 10.5px; margin-top: 5px; }
.foot { margin-top: 8px; text-align: center; color: #8b95a7; font-size: 11.5px; }
@media (max-width: 900px) {
  .columns { display: block; }
  .kpis { gap: 8px; }
  .kpi { padding: 15px 12px; border-radius: 14px; }
  .kpi-value { font-size: 26px; }
  .wrap { padding: 24px 16px 48px; }
  .hero h1 { font-size: 27px; }
  .topbar-inner { padding: 0 16px; }
  .nav a { padding: 7px 8px; }
}
</style>
