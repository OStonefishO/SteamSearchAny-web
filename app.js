// Steam 灯塔 · 前端
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'random',
  mode: 'hidden',
  tagId: '',
  seeds: [], // {id, name, img, weight}
  results: [],
  recent: [],
  lastSeedIds: [],
  indexSize: 0,
  busy: false,
};

const CDN = (id, kind) => {
  const map = {
    header: `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`,
    cover: `https://cdn.akamai.steamstatic.com/steam/apps/${id}/library_600x900.jpg`,
    capsule: `https://cdn.akamai.steamstatic.com/steam/apps/${id}/capsule_231x87.jpg`,
  };
  return map[kind] ?? map.header;
};

const STORE = (id) => `https://store.steampowered.com/app/${id}/`;

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

async function api(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pctClass = (p) => (p >= 90 ? 'pct-good' : p >= 75 ? 'pct-mid' : 'pct-bad');

function imgTag(src, alt, cls = '', fallbackId = null) {
  const fb = fallbackId ? `this.onerror=null;this.src='${CDN(fallbackId, 'header')}'` : `this.onerror=null;this.style.display='none'`;
  return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" class="${cls}" onerror="${fb}">`;
}

// ---------------- 语料库状态 ----------------
async function loadStatus() {
  try {
    const data = await api('/api/status');
    state.indexSize = data.index.games;
    $('#corpusText').textContent = `${data.index.games.toLocaleString()} 款 · ${data.index.tags} 标签`;
    $('#corpusPill').title = `本地语料库：${data.index.games} 款游戏，${data.index.tags} 个 Valve 官方标签`;
  } catch {
    $('#corpusText').textContent = '语料库未就绪';
  }
}

async function loadTags() {
  try {
    const data = await api('/api/tags?limit=70');
    const sel = $('#tagSelect');
    for (const t of data.tags) {
      const opt = document.createElement('option');
      opt.value = String(t.id);
      opt.textContent = `${t.zh} (${t.count})`;
      sel.appendChild(opt);
    }
  } catch {
    /* 忽略 */
  }
}

// ---------------- 盲盒 ----------------
function whyLine(g) {
  const rev = g.rev ?? { total: 0, pct: 0 };
  const nowYear = new Date().getFullYear();
  const pct = rev.pct;
  const total = rev.total;
  let text;
  if (!total) text = '还没人留下评测 —— 真正的未开垦地带';
  else if (total < 300) text = `只有 <b>${total}</b> 条评测，却拿到 <b>${pct}%</b> 好评`;
  else if (total < 2000) text = `<b>${total}</b> 条评测、<b>${pct}%</b> 好评，还没被大部队发现`;
  else if (total < 20000) text = `<b>${total.toLocaleString()}</b> 条评测、<b>${pct}%</b> 好评，属于小众圈子的口碑作`;
  else text = `<b>${total.toLocaleString()}</b> 条评测、<b>${pct}%</b> 好评，是这次抽到的熟面孔`;
  if (g.year && g.year >= nowYear - 1) text += ` · ${g.year} 年新品`;
  return `<div class="hero-why">🎯 ${text}</div>`;
}

function renderHero(g) {
  const card = $('#heroCard');
  const rev = g.rev ?? { total: 0, pct: 0, label: '暂无评测' };
  const tags = (g.tags ?? []).slice(0, 8);
  const gem = g.gem ?? 0;

  card.innerHTML = `
    <div class="hero-bg">${imgTag(g.header || CDN(g.id, 'header'), g.name, '', g.id)}</div>
    <div class="hero-inner">
      <div class="hero-top">
        <div>
          <h2 class="hero-title">${esc(g.name)}</h2>
          <div class="hero-sub">
            <span>${g.year ?? '未知年份'}</span>
            <span class="meta-sep">·</span>
            <span>${esc(g.price ?? (g.free ? '免费' : '—'))}</span>
            <span class="meta-sep">·</span>
            <span class="${pctClass(rev.pct)}">${rev.pct ? rev.pct + '% 好评' : '暂无评测'}</span>
            ${rev.total ? `<span class="meta-sep">·</span><span>${rev.total.toLocaleString()} 条评测</span>` : ''}
          </div>
        </div>
        <div class="gem-dial" style="--p:${gem}">
          <div><b>${gem}</b><span>冷门指数</span></div>
        </div>
      </div>

      ${whyLine(g)}

      ${rev.total ? `<div class="review-bar">
        <div class="review-track"><div class="review-fill" style="width:${Math.max(4, rev.pct)}%"></div></div>
        <span class="review-text">${esc(rev.label ?? '')} · ${rev.total.toLocaleString()} 人评价</span>
      </div>` : ''}

      <div class="hero-tags">
        ${tags.map((t) => `<span class="chip clickable" data-tag="${t.id}">${esc(t.zh)}</span>`).join('')}
      </div>

      <div class="hero-actions">
        <button class="btn btn-primary" id="rollAgain"><span>🎲</span> 再来一款</button>
        <button class="btn" id="heroDetail">看看详情</button>
        <button class="btn btn-ghost" id="heroSimilar">以此找相似</button>
        <a class="btn btn-ghost" href="${STORE(g.id)}" target="_blank" rel="noreferrer">Steam ↗</a>
      </div>
    </div>`;

  $$('.chip.clickable', card).forEach((chip) =>
    chip.addEventListener('click', () => {
      const id = chip.dataset.tag;
      $('#tagSelect').value = id;
      state.tagId = id;
      switchView('random');
      roll();
    })
  );
  $('#rollAgain', card)?.addEventListener('click', roll);
  $('#heroDetail', card)?.addEventListener('click', () => openDetail(g));
  $('#heroSimilar', card)?.addEventListener('click', () => {
    addSeed({ id: g.id, name: g.name, img: g.header || CDN(g.id, 'header') });
    switchView('similar');
    runSimilar();
  });
}

function pushRecent(g) {
  state.recent = [g, ...state.recent.filter((x) => x.id !== g.id)].slice(0, 12);
  renderRecent();
  localStorage.setItem('lighthouse.recent', JSON.stringify(state.recent.map((x) => ({ id: x.id, name: x.name, header: x.header }))));
}

function renderRecent() {
  const wrap = $('#recentWrap');
  const list = $('#recentList');
  if (!state.recent.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  list.innerHTML = state.recent
    .map(
      (g) => `<div class="recent-item" data-id="${g.id}">
        ${imgTag(g.header || CDN(g.id, 'header'), g.name, '', g.id)}
        <span title="${esc(g.name)}">${esc(g.name)}</span>
      </div>`
    )
    .join('');
  $$('.recent-item', list).forEach((el) =>
    el.addEventListener('click', () => {
      const g = state.recent.find((x) => x.id === Number(el.dataset.id));
      if (g) openDetail(g);
    })
  );
}

async function roll() {
  if (state.busy) return;
  state.busy = true;
  const card = $('#heroCard');
  card.style.opacity = '0.55';
  try {
    const exclude = state.recent.slice(0, 8).map((g) => g.id).join(',');
    const params = new URLSearchParams({ mode: state.mode, count: '1' });
    if (state.tagId) params.set('tag', state.tagId);
    if (exclude) params.set('exclude', exclude);
    const data = await api(`/api/random?${params}`);
    if (!data.items?.length) {
      toast('这个筛选下没货了，换个标签试试');
      return;
    }
    const g = data.items[0];
    renderHero(g);
    pushRecent(g);
    $('#poolInfo').textContent = `候选池 ${data.poolSize.toLocaleString()} 款${data.tag ? ' · ' + data.tag.zh : ''}`;
  } catch (e) {
    toast('抽卡失败：' + e.message);
  } finally {
    card.style.opacity = '1';
    state.busy = false;
  }
}

// ---------------- 相似追踪 ----------------
function renderSeeds() {
  const wrap = $('#seedChips');
  if (!state.seeds.length) {
    wrap.innerHTML = '<p class="seeds-empty">先加一两款游戏。加得越多，结果越靠向它们的共同点。</p>';
    return;
  }
  wrap.innerHTML = state.seeds
    .map(
      (s, i) => `
    <div class="seed-chip" data-idx="${i}">
      ${imgTag(s.img || CDN(s.id, 'header'), s.name, '', s.id)}
      <div class="seed-name" title="${esc(s.name)}">${esc(s.name)}</div>
      <div class="seed-ctl">
        <input type="range" min="0.2" max="2" step="0.1" value="${s.weight}" data-weight="${i}">
        <span class="wval">${Number(s.weight).toFixed(1)}×</span>
        <button class="rm" data-rm="${i}" title="移除">✕</button>
      </div>
    </div>`
    )
    .join('');

  $$('input[data-weight]', wrap).forEach((el) =>
    el.addEventListener('input', () => {
      const i = Number(el.dataset.weight);
      state.seeds[i].weight = Number(el.value);
      el.nextElementSibling.textContent = `${Number(el.value).toFixed(1)}×`;
      scheduleSimilar();
    })
  );
  $$('button[data-rm]', wrap).forEach((el) =>
    el.addEventListener('click', () => {
      state.seeds.splice(Number(el.dataset.rm), 1);
      renderSeeds();
      if (state.seeds.length) runSimilar();
      else $('#results').innerHTML = '';
    })
  );
}

function addSeed(game) {
  if (state.seeds.some((s) => s.id === game.id)) {
    toast('已经在里面了');
    return;
  }
  if (state.seeds.length >= 6) {
    toast('最多 6 款，先删一个吧');
    return;
  }
  state.seeds.push({ id: game.id, name: game.name, img: game.img, weight: 1 });
  renderSeeds();
}

let similarTimer = null;
function scheduleSimilar() {
  clearTimeout(similarTimer);
  similarTimer = setTimeout(() => runSimilar(), 420);
}

function cardHtml(g, index) {
  const rev = g.rev ?? { total: 0, pct: 0 };
  // 展示用曲线：把原始加权分映射到更好读的区间（排序仍按原始分）
  const pctScore = Math.min(99, Math.round(Math.pow(Math.max(0, g.score ?? 0), 0.7) * 100));
  return `
  <article class="card" style="animation-delay:${Math.min(index * 22, 400)}ms" data-id="${g.id}">
    <div class="card-cover">
      ${imgTag(g.cover || CDN(g.id, 'cover'), g.name, '', g.id)}
      <div class="card-score" style="--p:${pctScore}" title="综合相似度 ${pctScore}%"><span>${pctScore}</span></div>
    </div>
    <div class="card-body">
      <div class="card-name" title="${esc(g.name)}">${esc(g.name)}</div>
      <div class="card-meta">
        <span>${g.year ?? '—'}</span>
        ${rev.total ? `<span class="${pctClass(rev.pct)}">${rev.pct}%</span><span>${rev.total > 9999 ? (rev.total / 1000).toFixed(0) + 'k' : rev.total} 评</span>` : '<span>暂无评测</span>'}
      </div>
      ${g.shared?.length ? `<div class="card-why">因为 ${g.shared.slice(0, 3).map(esc).join(' · ')}</div>` : ''}
      <div class="card-actions">
        <button class="mini-btn" data-act="detail">详情</button>
        <button class="mini-btn" data-act="seed">加为种子</button>
      </div>
    </div>
  </article>`;
}

function renderResults(data) {
  const box = $('#results');
  const explain = $('#explain');

  if (!data.results?.length) {
    box.innerHTML = `<div class="empty-state"><span class="big">🕳️</span>这组条件下一款都没匹配到，试试去掉筛选或换一款种子。</div>`;
    explain.hidden = true;
    return;
  }

  explain.hidden = false;
  explain.innerHTML = `
    <span>扫描 <b>${data.indexSize.toLocaleString()}</b> 款 · 候选 <b>${data.poolMatched.toLocaleString()}</b> 款 · <b>${data.tookMs}ms</b></span>
    <div class="mini-bars">
      ${(data.seeds ?? [])
        .map(
          (s) => `<span class="mini-bar"><b>${esc(s.name)}</b>
          <i style="width:${Math.round(18 + (s.weight ?? 1) * 22)}px"></i>${Number(s.weight).toFixed(1)}×</span>`
        )
        .join('')}
    </div>`;

  box.innerHTML = data.results.map((g, i) => cardHtml(g, i)).join('');
  $$('.card', box).forEach((el) =>
    el.addEventListener('click', async (ev) => {
      const id = Number(el.dataset.id);
      const g = data.results.find((x) => x.id === id);
      const act = ev.target?.dataset?.act;
      if (act === 'seed') {
        ev.stopPropagation();
        if (g) {
          addSeed({ id: g.id, name: g.name, img: g.header || CDN(g.id, 'header') });
          runSimilar();
        }
        return;
      }
      if (g) openDetail(g);
    })
  );

  if (data.unresolved?.length) {
    toast(`有 ${data.unresolved.length} 款种子取不到标签（appid ${data.unresolved.join(', ')}），已跳过`);
  }
}

function syncUrl() {
  const url = new URL(location.href);
  if (state.seeds.length) {
    url.searchParams.set('ids', state.seeds.map((s) => s.id).join(','));
    url.searchParams.set('w', state.seeds.map((s) => s.weight).join(','));
  } else {
    url.searchParams.delete('ids');
    url.searchParams.delete('w');
  }
  history.replaceState(null, '', url);
}

/** 支持 ?ids=275850,413150&w=1,1.5 直接分享一组种子 */
async function applyDeepLink() {
  const params = new URLSearchParams(location.search);
  const ids = (params.get('ids') || '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 6);
  if (!ids.length) return false;
  const weights = (params.get('w') || '').split(',').map(Number);

  switchView('similar');
  $('#results').innerHTML = `<div class="empty-state"><span class="big">🧭</span>正在解析链接里的种子…</div>`;
  try {
    const q = new URLSearchParams({ ids: ids.join(','), limit: '30' });
    if (weights.some((w) => Number.isFinite(w) && w > 0)) q.set('weights', weights.join(','));
    const data = await api(`/api/similar?${q}`);
    state.seeds = (data.seedCards ?? []).map((c, i) => ({
      id: c.id,
      name: c.name,
      img: c.header,
      weight: Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 1,
    }));
    renderSeeds();
    renderResults(data);
    return true;
  } catch (e) {
    $('#results').innerHTML = `<div class="empty-state"><span class="big">⚠️</span>链接里的游戏解析失败：${esc(e.message)}</div>`;
    return true;
  }
}

async function runSimilar() {
  if (!state.seeds.length) {
    $('#results').innerHTML = '';
    $('#explain').hidden = true;
    return;
  }
  const box = $('#results');
  box.innerHTML = `<div class="empty-state"><span class="big">🧭</span>正在比对标签向量…</div>`;
  try {
    const params = new URLSearchParams({
      ids: state.seeds.map((s) => s.id).join(','),
      weights: state.seeds.map((s) => s.weight).join(','),
      limit: '30',
    });
    const minRev = Number($('#minRev').value) || 0;
    if (minRev) params.set('minReviews', String(minRev));
    if ($('#onlyHidden')?.checked) params.set('maxReviews', '5000');
    const data = await api(`/api/similar?${params}`);
    renderResults(data);
    syncUrl();
    localStorage.setItem('lighthouse.seeds', JSON.stringify(state.seeds));
  } catch (e) {
    box.innerHTML = `<div class="empty-state"><span class="big">⚠️</span>检索失败：${esc(e.message)}${
      e.data?.hint ? `<br><span style="font-size:12px;color:var(--dim)">${esc(e.data.hint)}</span>` : ''
    }</div>`;
  }
}

// ---------------- 搜索下拉 ----------------
let searchTimer = null;
let ddActive = -1;

function closeDropdown() {
  const dd = $('#dropdown');
  dd.hidden = true;
  dd.innerHTML = '';
  ddActive = -1;
}

async function doSearch(q) {
  const dd = $('#dropdown');
  if (!q.trim()) return closeDropdown();
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&limit=10`);
    if (!data.items.length) {
      dd.innerHTML = `<div class="dd-empty">没找到——换个关键词试试（支持中英文名）</div>`;
      dd.hidden = false;
      return;
    }
    dd.innerHTML = data.items
      .map(
        (it, i) => `<div class="dd-item" data-i="${i}" data-id="${it.id}" data-name="${esc(it.name)}">
        ${imgTag(CDN(it.id, 'capsule'), it.name, '', it.id)}
        <span>${esc(it.name)}</span>
        ${it.inCorpus ? '' : '<span class="badge">需补全</span>'}
      </div>`
      )
      .join('');
    dd.hidden = false;
    ddActive = -1;
    $$('.dd-item', dd).forEach((el) =>
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        pickSeed(Number(el.dataset.id), el.dataset.name);
      })
    );
  } catch {
    closeDropdown();
  }
}

function pickSeed(id, name) {
  closeDropdown();
  $('#seedInput').value = '';
  addSeed({ id, name, img: CDN(id, 'header') });
  runSimilar();
}

// ---------------- 详情弹窗 ----------------
async function openDetail(g) {
  const modal = $('#modal');
  const content = $('#modalContent');
  modal.hidden = false;
  content.innerHTML = `<div class="m-body" style="padding-top:24px"><h3>${esc(g.name)}</h3><p style="color:var(--dim)">载入中…</p></div>`;
  try {
    const data = await api(`/api/game/${g.id}`);
    const full = data.game ?? g;
    const rev = full.rev ?? { total: 0, pct: 0, label: '暂无评测' };
    content.innerHTML = `
      <div class="m-hero">${imgTag(full.header || CDN(full.id, 'header'), full.name, '', full.id)}</div>
      <div class="m-body">
        <h3>${esc(full.name)}</h3>
        <div class="hero-sub">
          <span>${full.year ?? '未知年份'}</span><span class="meta-sep">·</span>
          <span>${esc(full.price ?? (full.free ? '免费' : '—'))}</span><span class="meta-sep">·</span>
          <span class="${pctClass(rev.pct)}">${rev.pct ? rev.pct + '% 好评' : '暂无评测'}</span>
        </div>
        <div class="m-stats">
          <div class="m-stat"><b>${full.gem ?? 0}</b><span>冷门指数</span></div>
          <div class="m-stat"><b>${rev.total.toLocaleString()}</b><span>评测数</span></div>
          <div class="m-stat"><b>${esc(rev.label ?? '—')}</b><span>总评</span></div>
          <div class="m-stat"><b>${(full.tags ?? []).length}</b><span>标签</span></div>
        </div>
        <div class="hero-tags">
          ${(full.tags ?? []).slice(0, 10).map((t) => `<span class="chip">${esc(t.zh)}</span>`).join('')}
        </div>
        <div class="m-section">
          <h4>你可能也想看看</h4>
          <div class="m-related">
            ${(data.related ?? [])
              .slice(0, 5)
              .map(
                (r) => `<span class="mini" data-id="${r.id}">${imgTag(CDN(r.id, 'capsule'), r.name, '', r.id)}${esc(r.name)}</span>`
              )
              .join('') || '<span style="color:var(--dim);font-size:12px">没有找到相近的作品</span>'}
          </div>
        </div>
        <div class="hero-actions" style="margin-top:20px">
          <a class="btn btn-primary" href="${STORE(full.id)}" target="_blank" rel="noreferrer">在 Steam 打开 ↗</a>
          <button class="btn" id="modalSeed">以此找相似</button>
        </div>
      </div>`;

    $$('.mini[data-id]', content).forEach((el) =>
      el.addEventListener('click', () => {
        const rel = (data.related ?? []).find((r) => r.id === Number(el.dataset.id));
        if (rel) openDetail(rel);
      })
    );
    $('#modalSeed', content)?.addEventListener('click', () => {
      addSeed({ id: full.id, name: full.name, img: full.header || CDN(full.id, 'header') });
      closeModal();
      switchView('similar');
      runSimilar();
    });
  } catch (e) {
    content.innerHTML = `<div class="m-body" style="padding-top:24px"><h3>${esc(g.name)}</h3>
      <p style="color:var(--bad)">取详情失败：${esc(e.message)}</p>
      <a class="btn" href="${STORE(g.id)}" target="_blank" rel="noreferrer">直接在 Steam 打开 ↗</a></div>`;
  }
}

function closeModal() {
  $('#modal').hidden = true;
}

// ---------------- 视图切换 ----------------
function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-random').classList.toggle('hidden', view !== 'random');
  $('#view-similar').classList.toggle('hidden', view !== 'similar');
  if (view === 'similar') setTimeout(() => $('#seedInput')?.focus(), 60);
}

// ---------------- 初始化 ----------------
function boot() {
  loadStatus();
  loadTags();

  // 恢复最近 & 种子
  try {
    state.recent = JSON.parse(localStorage.getItem('lighthouse.recent') || '[]').slice(0, 12);
    renderRecent();
    const seeds = JSON.parse(localStorage.getItem('lighthouse.seeds') || '[]');
    if (Array.isArray(seeds) && seeds.length) {
      state.seeds = seeds.slice(0, 6);
      renderSeeds();
    }
  } catch {
    /* 忽略 */
  }

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  $$('.seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.mode = b.dataset.mode;
      roll();
    })
  );
  $('#tagSelect').addEventListener('change', (e) => {
    state.tagId = e.target.value;
    roll();
  });
  $('#rollBtn').addEventListener('click', roll);
  $('#clearRecent').addEventListener('click', () => {
    state.recent = [];
    renderRecent();
    localStorage.removeItem('lighthouse.recent');
  });

  // 搜索
  const input = $('#seedInput');
  input.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value;
    searchTimer = setTimeout(() => doSearch(q), 170);
  });
  input.addEventListener('keydown', (e) => {
    const dd = $('#dropdown');
    const items = $$('.dd-item', dd);
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      ddActive = (ddActive + 1) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === ddActive));
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      ddActive = (ddActive - 1 + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === ddActive));
    } else if (e.key === 'Enter') {
      if (ddActive >= 0 && items[ddActive]) {
        pickSeed(Number(items[ddActive].dataset.id), items[ddActive].dataset.name);
      } else if (items.length === 1) {
        pickSeed(Number(items[0].dataset.id), items[0].dataset.name);
      } else if (state.seeds.length) {
        runSimilar();
      }
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });
  input.addEventListener('blur', () => setTimeout(closeDropdown, 140));
  $('#findBtn').addEventListener('click', runSimilar);
  $('#minRev').addEventListener('input', (e) => {
    $('#minRevOut').textContent = Number(e.target.value).toLocaleString();
    scheduleSimilar();
  });
  $('#onlyHidden')?.addEventListener('change', scheduleSimilar);

  // 空格抽卡
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.view === 'random') roll();
    }
  });

  // 弹窗关闭
  $$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  });

  // 首屏：有深链就打开相似追踪，否则先抽一款
  (async () => {
    const gameParam = Number(new URLSearchParams(location.search).get('game'));
    const fromLink = await applyDeepLink();
    if (!fromLink) roll();
    if (Number.isFinite(gameParam) && gameParam > 0) openDetail({ id: gameParam, name: '载入中…' });
  })();
}

boot();
