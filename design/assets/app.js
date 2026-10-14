/* Gold Daily — 設計稿互動。純前端，所有價格皆為 Mock 資料。 */
(function () {
  'use strict';

  const DAY = 86400000;
  const END = Date.UTC(2026, 9, 13);
  const WEEKDAY = '日一二三四五六';

  // ---------- 工具 ----------

  function load(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* 無痕或封鎖儲存時忽略 */ }
  }
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const fmt = (v, dp) => v.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const signed = (v, dp) => (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), dp);
  const isoDate = (d) => d.toISOString().slice(0, 10);
  const md = (d) => (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
  const mmdd = (d) => pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate());
  const fullDate = (d) =>
    d.getUTCFullYear() + '/' + mmdd(d) + '（' + WEEKDAY[d.getUTCDay()] + '）';
  // 9/24 模擬「來源未更新」：當天沒有寫入快照
  const isGap = (d) => d.getUTCMonth() === 8 && d.getUTCDate() === 24;

  // ---------- Mock 資料 ----------

  function tradingDays() {
    const days = [];
    for (let t = END - 90 * DAY; t <= END; t += DAY) {
      const d = new Date(t);
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6) days.push(d);
    }
    return days;
  }

  let seriesCache = null;
  function series() {
    if (seriesCache) return seriesCache;
    let s = 20261013;
    const rnd = () => {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const days = tradingDays().filter((d) => !isGap(d));
    const n = days.length;
    const p = new Array(n);
    p[n - 1] = 4051.2;
    p[n - 2] = 4043.95;
    for (let i = n - 3; i >= 0; i--) {
      p[i] = Math.round((p[i + 1] / (1 + (rnd() - 0.46) * 0.016)) * 100) / 100;
    }
    seriesCache = days.map((d, i) => ({ d: d, p: p[i] }));
    return seriesCache;
  }

  // 每日快照列（新到舊），含缺漏日與第一筆無參考價
  function historyRows() {
    const prices = new Map(series().map((x) => [isoDate(x.d), x.p]));
    let prev = null;
    let prevDay = null;
    let afterGap = false;
    const rows = tradingDays().map((d) => {
      const key = isoDate(d);
      if (isGap(d)) {
        afterGap = true;
        return { iso: key, kind: 'missing', d: d };
      }
      const p = prices.get(key);
      const row = { iso: key, kind: prev === null ? 'noref' : 'valid', d: d, p: p, prev: prev, refDay: afterGap ? prevDay : null };
      afterGap = false;
      prev = p;
      prevDay = md(d);
      return row;
    });
    return rows.reverse();
  }

  // ---------- 共用 UI ----------

  function applyConvention(v) {
    document.documentElement.setAttribute('data-convention', v === 'intl' ? 'intl' : 'tw');
  }
  applyConvention(load('gd-convention'));

  // 預設 Penelope 暖米；classic 為原版冷灰
  function applyTheme(v) {
    if (v === 'classic') document.documentElement.setAttribute('data-theme', 'classic');
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme(load('gd-theme'));

  function toast(message) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 3600);
  }

  function previewPanel(extraHtml) {
    const el = document.createElement('details');
    el.className = 'preview-ctl';
    el.innerHTML =
      '<summary><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"></path><circle cx="16" cy="7" r="2"></circle><circle cx="10" cy="17" r="2"></circle></svg>設計稿預覽</summary>' +
      '<div class="preview-ctl__body">' +
      '<label>色系<select class="input" data-pv="theme">' +
      '<option value="penelope">Penelope 暖米</option>' +
      '<option value="classic">原版冷灰</option>' +
      '</select></label>' +
      '<label>漲跌配色<select class="input" data-pv="convention">' +
      '<option value="tw">紅漲綠跌（台灣慣例）</option>' +
      '<option value="intl">綠漲紅跌（國際慣例）</option>' +
      '</select></label>' +
      (extraHtml || '') +
      '<p class="caption">只用來切換設計稿狀態，正式版不會出現。</p>' +
      '</div>';
    document.body.appendChild(el);
    const sel = el.querySelector('[data-pv="convention"]');
    sel.value = document.documentElement.getAttribute('data-convention');
    sel.addEventListener('change', () => {
      applyConvention(sel.value);
      save('gd-convention', sel.value);
    });
    const themeSel = el.querySelector('[data-pv="theme"]');
    themeSel.value = document.documentElement.getAttribute('data-theme') === 'classic' ? 'classic' : 'penelope';
    themeSel.addEventListener('change', () => {
      applyTheme(themeSel.value);
      save('gd-theme', themeSel.value);
    });
    return el;
  }

  // ---------- 走勢圖 ----------

  function lineChart(host, live) {
    const svg = host.querySelector('svg');
    const tip = host.querySelector('.chart__tip');
    let pts = [];
    let offset = 0;
    let geo = null;
    let active = -1;

    function niceStep(raw) {
      const pow = Math.pow(10, Math.floor(Math.log10(raw)));
      const f = raw / pow;
      return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
    }

    function render() {
      if (!pts.length) return;
      const W = host.clientWidth;
      const H = svg.getBoundingClientRect().height || 280;
      const padL = 60, padR = 12, padT = 12, padB = 30;
      const vals = pts.map((x) => x.p);
      const min = Math.min.apply(null, vals);
      const max = Math.max.apply(null, vals);
      const step = niceStep((max - min) / 4 || 10);
      const lo = Math.floor(min / step) * step;
      const hi = Math.ceil(max / step) * step;
      const iw = W - padL - padR;
      const ih = H - padT - padB;
      const x = (i) => padL + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
      const y = (v) => padT + ((hi - v) / (hi - lo)) * ih;
      const base = (padT + ih).toFixed(1);

      let out = '';
      const ticks = Math.round((hi - lo) / step);
      for (let k = 0; k <= ticks; k++) {
        const v = lo + k * step;
        const yy = y(v).toFixed(1);
        out += '<line class="' + (k === 0 ? 'axis' : 'grid') + '" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '"></line>';
        out += '<text x="' + (padL - 10) + '" y="' + yy + '" text-anchor="end" dominant-baseline="middle">' + fmt(v, 0) + '</text>';
      }
      const nx = Math.min(5, pts.length);
      const idx = Array.from(new Set(Array.from({ length: nx }, (_, k) => Math.round((k * (pts.length - 1)) / (nx - 1 || 1)))));
      idx.forEach((i, k) => {
        const anchor = k === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle';
        out += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor + '">' + md(pts[i].d) + '</text>';
      });
      const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.p).toFixed(1)).join(' ');
      const li = pts.length - 1;
      out += '<path class="area" d="' + line + ' L' + x(li).toFixed(1) + ' ' + base + ' L' + x(0).toFixed(1) + ' ' + base + ' Z"></path>';
      out += '<path class="line" d="' + line + '"></path>';
      out += '<circle class="last" cx="' + x(li).toFixed(1) + '" cy="' + y(pts[li].p).toFixed(1) + '" r="5"></circle>';
      out += '<line class="cross" x1="0" x2="0" y1="' + padT + '" y2="' + base + '" visibility="hidden"></line>';
      out += '<circle class="hover-dot" r="5" visibility="hidden"></circle>';
      out += '<rect x="' + padL + '" y="' + padT + '" width="' + Math.max(iw, 0) + '" height="' + Math.max(ih, 0) + '" fill="transparent"></rect>';
      svg.innerHTML = out;
      geo = { x: x, y: y, padL: padL, iw: iw };
    }

    function show(i) {
      if (!geo || !pts.length) return;
      active = Math.max(0, Math.min(pts.length - 1, i));
      const p = pts[active];
      const cx = geo.x(active);
      const cy = geo.y(p.p);
      const cross = svg.querySelector('.cross');
      const dot = svg.querySelector('.hover-dot');
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.setAttribute('visibility', 'visible');

      const all = series();
      const prev = offset + active > 0 ? all[offset + active - 1].p : null;
      let change = '<span>資料中第一筆，無參考價</span>';
      let spoken = '';
      if (prev !== null) {
        const c = p.p - prev;
        change = '<span class="' + (c >= 0 ? 'tip-up' : 'tip-down') + '">' + (c >= 0 ? '▲ ' : '▼ ') + signed(c, 2) + '（' + signed((c / prev) * 100, 2) + '%）</span>';
        spoken = '，較前一交易日 ' + signed(c, 2);
      }
      tip.innerHTML = '<span>' + fullDate(p.d) + ' 09:00</span><b>' + fmt(p.p, 2) + '</b>' + change;
      tip.hidden = false;
      const W = host.clientWidth;
      const half = tip.offsetWidth / 2;
      tip.style.left = Math.max(half, Math.min(W - half, cx)) + 'px';
      tip.style.top = cy + 'px';
      tip.style.transform = cy < 80 ? 'translate(-50%, 14px)' : '';
      if (live) live.textContent = fullDate(p.d) + ' ' + fmt(p.p, 2) + ' 美元' + spoken;
    }

    function hide() {
      tip.hidden = true;
      svg.querySelectorAll('.cross, .hover-dot').forEach((el) => el.setAttribute('visibility', 'hidden'));
    }

    svg.addEventListener('pointermove', (e) => {
      if (!geo) return;
      const r = svg.getBoundingClientRect();
      show(Math.round(((e.clientX - r.left - geo.padL) / geo.iw) * (pts.length - 1)));
    });
    svg.addEventListener('pointerleave', () => { if (document.activeElement !== svg) hide(); });
    svg.addEventListener('focus', () => show(active >= 0 ? active : pts.length - 1));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const map = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: pts.length - 1 };
      if (e.key in map) {
        e.preventDefault();
        show(map[e.key]);
      }
    });

    if ('ResizeObserver' in window) {
      new ResizeObserver(() => { render(); if (!tip.hidden) show(active); }).observe(host);
    } else {
      window.addEventListener('resize', render);
    }

    return {
      set(next) {
        pts = next;
        offset = series().length - next.length;
        active = -1;
        hide();
        render();
      }
    };
  }

  // ---------- 儀表板 ----------

  function initDashboard() {
    const STATES = {
      fresh: {
        now: '10:42:18', headerState: '有效', statusLabel: '有效', statusCls: 'chip chip--ok',
        price: '4,072.35', chg: '+28.40', pct: '+0.70%',
        quote: '2026/10/13 10:30:00', fetched: '2026/10/13 10:30:04', age: '12 分鐘前',
        pos: 76, vsBase: '+0.52%', next: '10:45',
        gaugeText: '目前價格相對基準 +0.52%，未達 ±1% 門檻。',
        jobCls: 'chip chip--ok', jobStatus: '成功', jobTime: '10:30:00 → 10:30:04（4.2 秒）',
        jobNote: '寫入 1 筆報價，未觸發提醒。'
      },
      stale: {
        now: '11:42:18', headerState: '過期', statusLabel: '過期', statusCls: 'chip chip--warn',
        price: '4,051.20', chg: '+7.25', pct: '+0.18%',
        quote: '2026/10/13 09:00:00', fetched: '2026/10/13 11:30:03', age: '2 小時 42 分鐘前',
        pos: 50, vsBase: '暫停判斷', next: '11:45',
        gaugeText: '報價過期，暫停異動判斷；來源恢復後會用新報價重新判斷。',
        jobCls: 'chip chip--warn', jobStatus: '報價未更新', jobTime: '11:30:00 → 11:30:03（3.1 秒）',
        jobNote: '報價時間與上次相同，未寫入新快照，已標記過期。'
      }
    };
    const params = new URLSearchParams(window.location.search);
    let state = params.get('state') === 'stale' ? 'stale' : 'fresh';

    function applyState() {
      const h = STATES[state];
      document.querySelectorAll('[data-h]').forEach((el) => { el.textContent = h[el.dataset.h]; });
      document.getElementById('stale-alert').hidden = state !== 'stale';
      document.getElementById('price-status').className = h.statusCls;
      document.getElementById('job-status').className = h.jobCls;
      document.getElementById('price-big').classList.toggle('is-stale', state === 'stale');
      const gauge = document.getElementById('gauge');
      gauge.classList.toggle('is-paused', state === 'stale');
      gauge.querySelector('.gauge__marker').style.left = h.pos + '%';
      gauge.querySelector('.gauge__bubble').style.left = h.pos + '%';
    }

    const live = document.getElementById('chart-live');
    const chart = lineChart(document.getElementById('chart'), live);
    let range = 30;

    function update() {
      const cut = END - range * DAY;
      const pts = series().filter((x) => x.d.getTime() >= cut);
      chart.set(pts);
      const vals = pts.map((x) => x.p);
      const first = pts[0];
      const last = pts[pts.length - 1];
      const delta = last.p - first.p;
      document.getElementById('st-hi').textContent = fmt(Math.max.apply(null, vals), 2);
      document.getElementById('st-lo').textContent = fmt(Math.min.apply(null, vals), 2);
      const st = document.getElementById('st-delta');
      st.textContent = signed(delta, 2) + '（' + signed((delta / first.p) * 100, 2) + '%）';
      st.className = 'num ' + (delta >= 0 ? 'up' : 'down');
      document.getElementById('st-count').textContent = pts.length;
      document.getElementById('chart-svg').setAttribute(
        'aria-label',
        '近 ' + range + ' 天每日快照走勢（模擬資料），' + md(first.d) + ' ' + fmt(first.p, 2) + ' 至 ' + md(last.d) + ' ' + fmt(last.p, 2) + '。可用左右方向鍵逐日查看。'
      );
      document.querySelectorAll('[data-range]').forEach((b) => {
        b.setAttribute('aria-pressed', String(Number(b.dataset.range) === range));
      });
    }

    document.querySelectorAll('[data-range]').forEach((b) => {
      b.addEventListener('click', () => { range = Number(b.dataset.range); update(); });
    });

    const panel = previewPanel(
      '<label>資料狀態<select class="input" data-pv="state">' +
      '<option value="fresh">有效（12 分鐘前）</option>' +
      '<option value="stale">過期（來源未更新）</option>' +
      '</select></label>'
    );
    const stateSel = panel.querySelector('[data-pv="state"]');
    stateSel.value = state;
    stateSel.addEventListener('change', () => {
      state = stateSel.value;
      applyState();
      const url = new URL(window.location.href);
      if (state === 'stale') url.searchParams.set('state', 'stale');
      else url.searchParams.delete('state');
      window.history.replaceState(null, '', url);
    });

    applyState();
    update();
  }

  // ---------- 歷史資料 ----------

  function initHistory() {
    const all = historyRows();
    const PER = 20;
    const MIN = isoDate(new Date(END - 90 * DAY));
    const MAX = isoDate(new Date(END));
    const from = document.getElementById('f-from');
    const to = document.getElementById('f-to');
    const status = document.getElementById('f-status');
    const body = document.getElementById('history-body');
    let page = 1;

    function rowHtml(r) {
      const date = '<td class="num nowrap">' + fullDate(r.d) + '</td>';
      if (r.kind === 'missing') {
        return '<tr class="is-gap">' + date +
          '<td class="num r">—</td><td class="num r">—</td><td class="num r">—</td>' +
          '<td>Mock Provider</td><td class="soft">來源未更新</td>' +
          '<td><span class="chip chip--err">未取得有效報價</span><span class="cell-note">報價時間停在前一日，未寫入快照</span></td></tr>';
      }
      const quote = '<td class="num soft nowrap">' + mmdd(r.d) + ' 09:00:00</td>';
      if (r.kind === 'noref') {
        return '<tr>' + date +
          '<td class="num r">' + fmt(r.p, 2) + '</td><td class="num r soft">—</td><td class="num r soft">—</td>' +
          '<td>Mock Provider</td>' + quote +
          '<td><span class="chip chip--muted">有效・無參考價</span><span class="cell-note">第一筆快照，無法計算漲跌</span></td></tr>';
      }
      const c = r.p - r.prev;
      const cls = c >= 0 ? 'up' : 'down';
      const note = r.refDay ? '<span class="cell-note">參考價取自 ' + r.refDay + '（前一有效交易日）</span>' : '';
      return '<tr>' + date +
        '<td class="num r">' + fmt(r.p, 2) + '</td>' +
        '<td class="num r ' + cls + '">' + signed(c, 2) + '</td>' +
        '<td class="num r ' + cls + '">' + signed((c / r.prev) * 100, 2) + '%</td>' +
        '<td>Mock Provider</td>' + quote +
        '<td><span class="chip chip--ok">有效</span>' + note + '</td></tr>';
    }

    function render() {
      const f = from.value || MIN;
      const t = to.value || MAX;
      const s = status.value;
      const rows = all.filter((r) => r.iso >= f && r.iso <= t && (s === 'all' || r.kind === s));
      const pages = Math.max(1, Math.ceil(rows.length / PER));
      page = Math.min(page, pages);
      body.innerHTML = rows.slice((page - 1) * PER, page * PER).map(rowHtml).join('');
      document.getElementById('history-empty').hidden = rows.length > 0;
      document.getElementById('h-count').textContent = rows.length;
      document.getElementById('h-page').textContent = page;
      document.getElementById('h-pages').textContent = pages;
      document.getElementById('h-prev').disabled = page <= 1;
      document.getElementById('h-next').disabled = page >= pages;
      let btns = '';
      for (let i = 1; i <= pages; i++) {
        btns += '<button type="button" class="pg" data-page="' + i + '" aria-label="第 ' + i + ' 頁"' + (i === page ? ' aria-current="page"' : '') + '>' + i + '</button>';
      }
      document.getElementById('h-pagebtns').innerHTML = btns;
    }

    [from, to, status].forEach((el) => el.addEventListener('change', () => { page = 1; render(); }));
    document.getElementById('h-clear').addEventListener('click', () => {
      from.value = MIN;
      to.value = MAX;
      status.value = 'all';
      page = 1;
      render();
    });
    document.getElementById('h-prev').addEventListener('click', () => { page -= 1; render(); });
    document.getElementById('h-next').addEventListener('click', () => { page += 1; render(); });
    document.getElementById('h-pagebtns').addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]');
      if (b) { page = Number(b.dataset.page); render(); }
    });

    previewPanel();
    render();
  }

  // ---------- 推播設定 ----------

  function initSettings() {
    const form = document.getElementById('settings-form');
    const el = form.elements;

    const switches = Array.from(form.querySelectorAll('.switch'));
    function syncSwitch(sw) {
      const on = sw.getAttribute('aria-checked') === 'true';
      document.getElementById(sw.dataset.text).textContent = on ? '啟用' : '停用';
      document.getElementById(sw.dataset.controls).disabled = !on;
    }
    switches.forEach((sw) => {
      sw.addEventListener('click', () => {
        sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
        syncSwitch(sw);
        validateAll(false);
      });
    });

    const RULES = {
      rise: { min: 0.1, max: 20, msg: '請輸入 0.1 到 20 之間的百分比' },
      fall: { min: 0.1, max: 20, msg: '請輸入 0.1 到 20 之間的百分比' },
      cooldown: { min: 15, max: 1440, int: true, msg: '請輸入 15 到 1440 之間的整數（分鐘）' },
      manual: { min: 0.01, max: 1000000, msg: '請輸入大於 0 的基準價格' },
      quota: { min: 1, max: 1000000, int: true, msg: '請輸入正整數，並與 LINE 當期方案一致' },
      buffer: { min: 0, max: 100, int: true, msg: '請輸入 0 到 100 之間的整數' }
    };

    function validate(name) {
      const input = el[name];
      const rule = RULES[name];
      const err = document.getElementById(name + '-error');
      if (input.matches(':disabled')) {
        input.removeAttribute('aria-invalid');
        err.textContent = '';
        return true;
      }
      const raw = input.value.trim();
      const n = Number(raw);
      const ok = raw !== '' && Number.isFinite(n) && n >= rule.min && n <= rule.max && (!rule.int || Number.isInteger(n));
      input.setAttribute('aria-invalid', String(!ok));
      err.textContent = ok ? '' : rule.msg;
      return ok;
    }
    // all = false：只重新檢查已經檢查過的欄位，避免一進頁面就滿版錯誤
    function validateAll(all) {
      return Object.keys(RULES).filter((name) => {
        if (!all && el[name].getAttribute('aria-invalid') === null) return false;
        return !validate(name);
      });
    }
    Object.keys(RULES).forEach((name) => el[name].addEventListener('input', () => validate(name)));

    function syncCooldown() {
      const m = Number(el.cooldown.value);
      const hint = document.getElementById('cooldown-hint');
      if (!Number.isFinite(m) || m <= 0) { hint.textContent = ''; return; }
      const h = Math.floor(m / 60);
      const r = m % 60;
      hint.textContent = '＝ ' + (h ? h + ' 小時' : '') + (r ? ' ' + r + ' 分鐘' : '');
    }
    el.cooldown.addEventListener('input', syncCooldown);

    function syncBaseline() {
      el.manual.disabled = el.baseline.value !== 'manual';
      validate('manual');
    }
    form.querySelectorAll('input[name="baseline"]').forEach((r) => r.addEventListener('change', syncBaseline));

    function syncPolling() {
      const dailyOnly = el.polling.value === 'daily';
      document.getElementById('note-intraday').hidden = dailyOnly;
      document.getElementById('note-daily-only').hidden = !dailyOnly;
    }
    el.polling.addEventListener('change', syncPolling);

    function syncAll() {
      switches.forEach(syncSwitch);
      syncCooldown();
      syncBaseline();
      syncPolling();
      validateAll(false);
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const bad = validateAll(true);
      if (bad.length) {
        el[bad[0]].focus();
        toast('有 ' + bad.length + ' 個欄位需要修正');
        return;
      }
      document.getElementById('saved-at').textContent = '剛剛';
      toast('設定已儲存（設計稿：沒有連線後端）');
    });
    form.addEventListener('reset', () => {
      setTimeout(() => {
        switches.forEach((sw) => sw.setAttribute('aria-checked', sw.dataset.default));
        Object.keys(RULES).forEach((name) => el[name].removeAttribute('aria-invalid'));
        syncAll();
        Object.keys(RULES).forEach((name) => { document.getElementById(name + '-error').textContent = ''; });
      }, 0);
    });

    document.getElementById('reset-baseline').addEventListener('click', () => {
      toast('設計稿：正式版會寫入事件紀錄，並以下一筆有效報價作為新基準');
    });
    document.getElementById('test-push').addEventListener('click', () => {
      document.getElementById('test-result').textContent = '設計稿沒有連線後端，這次沒有實際發送。正式版會在這裡顯示 LINE API 的回應結果。';
    });

    previewPanel();
    syncAll();
  }

  // ---------- 系統狀態 ----------

  function initStatus() {
    const buttons = document.querySelectorAll('[data-filter]');
    const rows = document.querySelectorAll('#jobs-body tr');
    buttons.forEach((b) => {
      b.addEventListener('click', () => {
        const f = b.dataset.filter;
        buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        let shown = 0;
        rows.forEach((r) => {
          const on = f === 'all' || r.dataset.job === f;
          r.hidden = !on;
          if (on) shown += 1;
        });
        document.getElementById('jobs-count').textContent = shown;
      });
    });
    previewPanel();
  }

  // ---------- 捲動淡入、跑馬燈 ----------

  function initReveal() {
    const items = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach((el) => io.observe(el));
  }

  function initTicker() {
    document.querySelectorAll('.ticker').forEach((ticker) => {
      const btn = ticker.querySelector('.ticker__toggle');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const paused = ticker.classList.toggle('is-paused');
        btn.setAttribute('aria-pressed', String(paused));
        btn.setAttribute('aria-label', paused ? '播放跑馬燈' : '暫停跑馬燈');
      });
    });
  }

  document.documentElement.classList.add('js');
  initReveal();
  initTicker();

  const page = document.body.dataset.page;
  if (page === 'dashboard') initDashboard();
  else if (page === 'history') initHistory();
  else if (page === 'settings') initSettings();
  else if (page === 'status') initStatus();
  else previewPanel();
})();
