// Steam 灯塔 · 前端 v2（更密的网格 / 更大的字 / 一次多给几款）
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PER_PAGE = 45; // 相似结果一页显示多少（可被显示设置覆盖）

const UI_KEY = 'lighthouse.ui';
const ui = (() => {
  try {
    return Object.assign({ perScreen: 32, perPage: 45, cardMin: 126 }, JSON.parse(localStorage.getItem(UI_KEY) || '{}'));
  } catch {
    return { perScreen: 32, perPage: 45, cardMin: 126 };
  }
})();
function saveUi() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(ui));
  } catch {}
}
function applyUi() {
  document.documentElement.style.setProperty('--card-min', `${ui.cardMin}px`);
  const ps = $('#perScreen');
  const pp = $('#perPage');
  if (ps) {
    ps.value = String(ui.perScreen);
    $('#perScreenOut').textContent = String(ui.perScreen);
  }
  if (pp) {
    pp.value = String(ui.perPage);
    $('#perPageOut').textContent = String(ui.perPage);
  }
  $$('#cardSizeSel .seg-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.min) === ui.cardMin));
  const grid = $('#randomGrid');
  if (grid) {
    grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${ui.cardMin}px, 1fr))`;
  }
}

const state = {
  view: 'random',
  mode: 'hidden',
  tagIds: [],
  tagList: [],
  seeds: [],
  allResults: [],
  shown: 0,
  recent: [],
  heroId: null,
  revealStep: 12,
  randomItems: [],
  demoMode: 'exclude',
  minPct: 0,
};

const CDN = (id, kind) => {
  const file = kind === 'cover' ? 'library_600x900.jpg' : kind === 'capsule' ? 'capsule_231x87.jpg' : 'header.jpg';
  return `https://cdn.akamai.steamstatic.com/steam/apps/${id}/${file}`;
};
const STORE = (id) => `https://store.steampowered.com/app/${id}/`;

// ---------------- 收藏（本机 localStorage，「我的信息」共用） ----------------
const FAV_KEY = 'lighthouse.favs.v1';
const favIds = (() => {
  try {
    const arr = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  } catch {
    return [];
  }
})();
const favListeners = new Set();
function favHas(id) {
  return favIds.includes(Number(id));
}
function favSave() {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favIds));
  } catch {}
  favListeners.forEach((fn) => {
    try {
      fn(favIds.slice());
    } catch {}
  });
}
function syncFavButtons(root = document) {
  $$('[data-fav]', root).forEach((b) => {
    const on = favHas(b.dataset.fav);
    b.classList.toggle('on', on);
    b.textContent = on ? '★' : '☆';
    b.title = on ? '取消收藏' : '收藏';
    b.setAttribute('aria-label', b.title);
  });
}
function toggleFav(id, name) {
  const n = Number(id);
  if (!n) return false;
  const i = favIds.indexOf(n);
  let on;
  if (i >= 0) {
    favIds.splice(i, 1);
    on = false;
  } else {
    favIds.unshift(n);
    on = true;
  }
  favSave();
  syncFavButtons();
  toast(on ? `已收藏${name ? '：' + name : ''}` : '已取消收藏');
  return on;
}
function favBtnHtml(id) {
  const on = favHas(id);
  return `<button class="card-fav${on ? ' on' : ''}" data-fav="${id}" title="${on ? '取消收藏' : '收藏'}" aria-label="${on ? '取消收藏' : '收藏'}">${on ? '★' : '☆'}</button>`;
}
// 给「我的信息」等其它模块用
window.LH_FAV = {
  key: FAV_KEY,
  ids: () => favIds.slice(),
  has: favHas,
  toggle: toggleFav,
  onChange(fn) {
    favListeners.add(fn);
    return () => favListeners.delete(fn);
  },
};
// 星标点击：捕获阶段拦下来，别让卡片的点击把详情打开
document.addEventListener(
  'click',
  (ev) => {
    const btn = ev.target.closest && ev.target.closest('[data-fav]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const host = btn.closest('.card');
    const t = host && host.querySelector('.card-title');
    toggleFav(btn.dataset.fav, t ? t.textContent.trim() : '');
  },
  true
);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pctClass = (p) => (p >= 90 ? 'good' : p >= 78 ? 'mid' : 'bad');
const shortNum = (n) => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n ?? 0));

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

function imgTag(src, alt, fallbackId) {
  const fb = fallbackId ? `this.onerror=null;this.src='${CDN(fallbackId, 'header')}'` : `this.onerror=null;this.style.opacity=0`;
  return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" onerror="${fb}">`;
}

// ---------------- 语料状态 ----------------
async function loadStatus() {
  try {
    const data = await api('/api/status');
    const built = data.index.loadedAt || data.build?.startedAt || '';
    const d = built ? new Date(built) : null;
    const dateStr = d && !Number.isNaN(d.getTime()) ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}` : '';
    $('#corpusText').textContent =
      `${data.index.games.toLocaleString()} 款 · ${data.index.tags} 标签` + (dateStr ? ` · 更新 ${dateStr}` : '');
    $('#corpusPill').title = `语料 ${data.index.games} 款游戏 / ${data.index.tags} 个 Valve 官方标签${built ? ` · 构建于 ${built}` : ''}`;
  } catch {
    $('#corpusText').textContent = '语料未就绪';
  }
}

// ---------------- 多选标签 ----------------
async function loadTags() {
  try {
    const data = await api('/api/tags?limit=120');
    state.tagList = data.tags;
    renderTagList('');
  } catch {
    /* 忽略 */
  }
}

function renderTagList(filter = '') {
  const box = $('#tagList');
  if (!box) return;
  const q = filter.trim().toLowerCase();
  const items = (state.tagList || []).filter((t) => !q || t.zh.toLowerCase().includes(q));
  if (!items.length) {
    box.innerHTML = '<div class="ms-hint" style="padding:10px 8px">没有匹配的标签</div>';
    return;
  }
  box.innerHTML = items
    .map(
      (t) => `<div class="ms-item ${state.tagIds.includes(t.id) ? 'on' : ''}" data-tag="${t.id}" role="option" aria-selected="${state.tagIds.includes(t.id)}">
        <span class="tick">✓</span><span>${esc(t.zh)}</span><span class="cnt">${t.count}</span>
      </div>`
    )
    .join('');
}

function renderTagChips() {
  const wrap = $('#tagChips');
  if (!wrap) return;
  if (!state.tagIds.length) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = state.tagIds
    .map((id) => {
      const t = (state.tagList || []).find((x) => x.id === id);
      return `<span class="ms-chip">${esc(t?.zh ?? `#${id}`)}<button data-rmtag="${id}" title="移除">✕</button></span>`;
    })
    .join('');
}

function updateTagButton() {
  const n = state.tagIds.length;
  $('#tagCount').hidden = n === 0;
  $('#tagCount').textContent = String(n);
  $('#tagBtnLabel').textContent = n === 0 ? '全部标签' : n === 1
    ? (state.tagList || []).find((t) => t.id === state.tagIds[0])?.zh ?? '1 个标签'
    : `${n} 个标签`;
}

function toggleTag(id) {
  const i = state.tagIds.indexOf(id);
  if (i >= 0) state.tagIds.splice(i, 1);
  else state.tagIds.push(id);
  updateTagButton();
  renderTagChips();
  renderTagList($('#tagSearch')?.value ?? '');
}

function closeTagPanel() {
  const panel = $('#tagPanel');
  if (panel) panel.hidden = true;
  $('#tagBtn')?.setAttribute('aria-expanded', 'false');
}

// ---------------- 卡片 ----------------
function cardHtml(g, index, { score = false } = {}) {
  const rev = g.rev ?? { total: 0, pct: 0 };
  const ratingPill = rev.total
    ? `<span class="card-pill left ${pctClass(rev.pct)}">${rev.pct}%</span>`
    : `<span class="card-pill left">无评测</span>`;
  const right = score
    ? `<span class="card-pill score">${Math.min(99, Math.round(Math.pow(Math.max(0, g.score ?? 0), 0.7) * 100))}</span>`
    : `<span class="card-pill right${(g.rev?.total || 0) >= 10000 ? ' hot' : ''}">${(g.rev?.total || 0) >= 10000 ? 'HOT' : '冷门 ' + (g.gem ?? 0)}</span>`;
  // 相似视图里好评率下移到副标题，避免两个角标抢戏
  const sub = score
    ? [g.year ?? null, rev.total ? `${rev.pct}%` : null, rev.total ? `${shortNum(rev.total)} 评测` : null]
        .filter(Boolean)
        .join(' · ')
    : [g.year ?? null, rev.total ? `${shortNum(rev.total)} 评测` : null, g.price && g.price !== '¥0.00' ? g.price : null]
        .filter(Boolean)
        .join(' · ');

  return `<article class="card" data-id="${g.id}" tabindex="0" aria-label="${esc(g.name)}" style="animation-delay:${Math.min(index * 16, 420)}ms">
    <div class="card-media">
      ${imgTag(g.cover || CDN(g.id, 'cover'), g.name, g.id)}
      ${score ? '' : ratingPill}
      ${right}
      <button class="card-info" data-info="${g.id}" title="游戏资料" aria-label="游戏资料">i</button>
      <button class="card-seed" data-seed="${g.id}" title="加为相似种子">＋</button>
      ${favBtnHtml(g.id)}
      <div class="card-foot">
        <div class="card-title">${esc(g.name)}</div>
        ${sub ? `<div class="card-sub">${esc(sub)}</div>` : ''}
      </div>
    </div>
  </article>`;
}

function renderGrid(el, items, opts = {}) {
  el.innerHTML = items.map((g, i) => cardHtml(g, i, opts)).join('');
}

// 事件委托，一次绑定
function bindGrid(el, resolve) {
  el.addEventListener('click', (ev) => {
    const infoBtn = ev.target.closest('[data-info]');
    if (infoBtn) {
      ev.stopPropagation();
      const g = resolve(Number(infoBtn.dataset.info));
      if (g) openInfo(g);
      return;
    }
    const seedBtn = ev.target.closest('[data-seed]');
    if (seedBtn) {
      ev.stopPropagation();
      const g = resolve(Number(seedBtn.dataset.seed));
      if (g) addSeed({ id: g.id, name: g.name, img: g.header || CDN(g.id, 'header') });
      return;
    }
    const card = ev.target.closest('.card');
    if (!card) return;
    const g = resolve(Number(card.dataset.id));
    if (g) openDetail(g);
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = ev.target.closest('.card');
    if (!card) return;
    ev.preventDefault();
    const g = resolve(Number(card.dataset.id));
    if (g) openDetail(g);
  });
}

// ---------------- 盲盒 ----------------
function renderHero(g) {
  const rev = g.rev ?? { total: 0, pct: 0, label: '暂无评测' };
  const tags = (g.tags ?? []).slice(0, 8);
  const gem = g.gem ?? 0;
  const pct = rev.pct;

  const note = !rev.total
    ? '还没有人留下评测 —— 真正的未开垦地带'
    : rev.total < 300
      ? `只有 <b>${rev.total}</b> 条评测，却拿到 <b>${pct}%</b> 好评`
      : rev.total < 2000
        ? `<b>${rev.total}</b> 条评测、<b>${pct}%</b> 好评，还没被大部队发现`
        : rev.total < 20000
          ? `<b>${rev.total.toLocaleString()}</b> 条评测、<b>${pct}%</b> 好评，小众圈子的口碑作`
          : `<b>${rev.total.toLocaleString()}</b> 条评测、<b>${pct}%</b> 好评，这次抽到的是熟面孔`;

  $('#heroCard').innerHTML = `
    <div class="hero-media">${imgTag(g.header || CDN(g.id, 'header'), g.name, g.id)}</div>
    <div class="hero-body">
      <div class="hero-eyebrow"><span class="spark"></span>${rev.total >= 10000 ? '热门在卖 · ' + shortNum(rev.total) + ' 条评测' : '今日捞到 · 冷门指数 ' + gem}</div>
      <h2 class="hero-title">${esc(g.name)}</h2>
      <div class="hero-chips">
        ${g.year ? `<span class="chip">${g.year}</span>` : ''}
        ${g.price ? `<span class="chip">${esc(g.price)}</span>` : ''}
        ${rev.total ? `<span class="chip ${pctClass(pct)}">${pct}% 好评</span>` : `<span class="chip">暂无评测</span>`}
        ${rev.total ? `<span class="chip">${rev.total.toLocaleString()} 条评测</span>` : ''}
        ${rev.label ? `<span class="chip accent">${esc(rev.label)}</span>` : ''}
      </div>
      <p class="hero-note">${note}</p>
      <div class="hero-chips">
        ${tags.map((t) => `<span class="chip tag" data-tag="${t.id}">${esc(t.zh)}</span>`).join('')}
      </div>
      <div class="hero-actions">
        <button class="btn" id="heroDetail">看看详情</button>
        <button class="btn" id="heroSimilar">以此找相似</button>
        <a class="btn btn-quiet" href="${STORE(g.id)}" target="_blank" rel="noreferrer">Steam ↗</a>
      </div>
    </div>
    <div class="hero-stats">
      <div class="stat hot"><b>${rev.total >= 10000 ? 'HOT' : gem}</b><span>${rev.total >= 10000 ? '热门' : '冷门指数'}</span></div>
      <div class="stat"><b>${rev.total ? shortNum(rev.total) : '0'}</b><span>评测数</span></div>
      <div class="stat"><b>${g.year ?? '—'}</b><span>发售</span></div>
    </div>`;

  $('#heroCard').onclick = (ev) => {
    const tag = ev.target.closest('[data-tag]');
    if (tag) {
      toggleTag(Number(tag.dataset.tag));
      roll();
      return;
    }
    if (ev.target.closest('#heroDetail')) openDetail(g);
    if (ev.target.closest('#heroSimilar')) {
      addSeed({ id: g.id, name: g.name, img: g.header || CDN(g.id, 'header') });
      switchView('similar');
      runSimilar();
    }
  };
}

function pushRecent(g) {
  state.recent = [g, ...state.recent.filter((x) => x.id !== g.id)].slice(0, 14);
  renderRecent();
  try {
    localStorage.setItem(
      'lighthouse.recent',
      JSON.stringify(state.recent.map((x) => ({ id: x.id, name: x.name, header: x.header })))
    );
  } catch {}
}

function renderRecent() {
  const wrap = $('#recentWrap');
  const list = $('#recentList');
  if (!state.recent.length) {
    wrap.hidden = true;
    list.hidden = true;
    return;
  }
  wrap.hidden = false;
  list.hidden = false;
  list.innerHTML = state.recent
    .map(
      (g) => `<div class="recent-item" data-id="${g.id}">
        ${imgTag(g.header || CDN(g.id, 'header'), g.name, g.id)}
        <span title="${esc(g.name)}">${esc(g.name)}</span>
      </div>`
    )
    .join('');
}

async function draw(count, { heroMode = true } = {}) {
  const params = new URLSearchParams({ mode: state.mode || 'hidden', count: String(count) });
  if (state.tagIds.length) params.set('tags', state.tagIds.join(','));
  if (state.demoMode && state.demoMode !== 'exclude') params.set('demo', state.demoMode);
  if (state.hideHot) params.set('maxReviews', '9999');
  if (state.minPct) params.set('minPct', String(state.minPct));
  const after = $('#relFrom')?.value;
  const before = $('#relTo')?.value;
  if (after) params.set('after', String(Math.floor(new Date(`${after}T00:00:00`).getTime() / 1000)));
  if (before) params.set('before', String(Math.floor(new Date(`${before}T23:59:59`).getTime() / 1000)));
  const exclude = state.recent.slice(0, 10).map((g) => g.id).join(',');
  if (exclude) params.set('exclude', exclude);
  return api(`/api/random?${params}`);
}

let rolling = false;
async function roll() {
  if (rolling) return;
  rolling = true;
  const card = $('#heroCard');
  card.style.opacity = '0.45';
  try {
    const data = await draw(ui.perScreen + 1);
    if (!data.items?.length) {
      toast('这个筛选下没货了，换个标签试试');
      return;
    }
    const [hero, ...rest] = data.items;
    state.heroId = hero.id;
    renderHero(hero);
    pushRecent(hero);
    state.randomItems = rest.slice(0, ui.perScreen);
    renderGrid($('#randomGrid'), state.randomItems);
    $('#gridCount').textContent = String(Math.min(ui.perScreen, rest.length));
    $('#poolInfo').textContent = `候选池 ${data.poolSize.toLocaleString()} 款${
      data.tags?.length ? ' · ' + data.tags.map((t) => t.zh).join(' + ') : ''
    }`;
  } catch (e) {
    toast('抽卡失败：' + e.message);
  } finally {
    card.style.opacity = '1';
    rolling = false;
  }
}

async function rollGrid() {
  const grid = $('#randomGrid');
  grid.style.opacity = '0.4';
  try {
    const data = await draw(ui.perScreen);
    state.randomItems = data.items ?? [];
    renderGrid(grid, state.randomItems);
    $('#gridCount').textContent = String(state.randomItems.length);
  } catch (e) {
    toast('刷新失败：' + e.message);
  } finally {
    grid.style.opacity = '1';
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
    <div class="seed" data-idx="${i}">
      ${imgTag(s.img || CDN(s.id, 'header'), s.name, s.id)}
      <div class="seed-name" title="${esc(s.name)}">${esc(s.name)}</div>
      <button class="seed-rm" data-rm="${i}" title="移除">✕</button>
      <div class="seed-ctl">
        <input type="range" min="0" max="3" step="0.1" value="${s.weight}" data-weight="${i}">
        <span class="seed-w">${Number(s.weight).toFixed(1)}×</span>
      </div>
    </div>`
    )
    .join('');
}

function addSeed(game) {
  if (state.seeds.some((s) => s.id === game.id)) return toast('已经在里面了');
  if (state.seeds.length >= 6) return toast('最多 6 款，先删一个吧');
  state.seeds.push({ id: game.id, name: game.name, img: game.img, weight: 1 });
  renderSeeds();
}

let similarTimer = null;
function scheduleSimilar() {
  clearTimeout(similarTimer);
  similarTimer = setTimeout(() => runSimilar(), 420);
}

/** 分数邻域内随机打散：每次检索换一批"同样好"的作品，避免永远看到同十款 */
function randomizeOrder(list) {
  return list
    .map((g) => ({ g, k: (g.score ?? 0) + (Math.random() - 0.5) * 0.22 }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.g);
}

function renderExplain(data) {
  const box = $('#explain');
  box.hidden = false;
  box.innerHTML = `
    <span>扫描 <b>${data.indexSize.toLocaleString()}</b> 款 · 候选 <b>${data.poolMatched.toLocaleString()}</b> 款 · <b>${data.tookMs}ms</b></span>
    <div class="mini-bars">
      ${(data.seeds ?? [])
        .map(
          (s) => `<span class="mini-bar"><b>${esc(s.name)}</b>
          <i style="width:${Math.round(16 + (s.weight ?? 1) * 20)}px"></i>${Number(s.weight).toFixed(1)}×</span>`
        )
        .join('')}
    </div>`;
}

function renderResults() {
  const grid = $('#results');
  const slice = state.allResults.slice(0, state.shown);
  renderGrid(grid, slice, { score: true });
  const more = $('#loadMore');
  const rest = state.allResults.length - state.shown;
  more.hidden = rest <= 0;
  more.textContent = `加载更多（还有 ${Math.max(0, rest)} 款）`;
}

async function runSimilar() {
  if (!state.seeds.length) {
    $('#results').innerHTML = '';
    $('#explain').hidden = true;
    $('#loadMore').hidden = true;
    return;
  }
  const grid = $('#results');
  grid.innerHTML = `<div class="empty-state"><span class="big">🧭</span>正在比对标签向量…</div>`;
  try {
    const q = new URLSearchParams({
      ids: state.seeds.map((s) => s.id).join(','),
      weights: state.seeds.map((s) => s.weight).join(','),
      limit: '120',
    });
    const minRev = Number($('#minRev').value) || 0;
    if (minRev) q.set('minReviews', String(minRev));
    const maxRev = Number($('#maxRev')?.value) || 0;
    if (maxRev) q.set('maxReviews', String(maxRev));
    const simPct = Number($('#simPct').value) || 0;
    if (simPct) q.set('minPct', String(simPct));
    if ($('#onlyHidden')?.checked) q.set('maxReviews', '5000');

    const data = await api(`/api/similar?${q}`);
    state.allResults = randomizeOrder(data.results ?? []);
    state.shown = Math.min(ui.perPage, state.allResults.length);
    renderExplain(data);
    renderResults();
    if (data.visualPending) {
      toast('画风特征还在解析，本次先按玩法排序，就绪后会自动刷新', 4200);
    }
    syncUrl();
    try {
      localStorage.setItem('lighthouse.seeds', JSON.stringify(state.seeds));
    } catch {}
    if (data.unresolved?.length) toast(`${data.unresolved.length} 款种子取不到标签，已跳过`);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><span class="big">⚠️</span>检索失败：${esc(e.message)}</div>`;
    $('#loadMore').hidden = true;
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
      dd.innerHTML = `<div class="dd-empty">没找到——换个关键词试试（中英文名都行）</div>`;
      dd.hidden = false;
      return;
    }
    dd.innerHTML = data.items
      .map(
        (it, i) => `<div class="dd-item" data-i="${i}" data-id="${it.id}" data-name="${esc(it.name)}">
        ${imgTag(CDN(it.id, 'capsule'), it.name, it.id)}
        <span>${esc(it.name)}</span>
        ${it.inCorpus ? '' : '<span class="badge">需补全</span>'}
      </div>`
      )
      .join('');
    dd.hidden = false;
    ddActive = -1;
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

// ---------------- 详情 ----------------
async function openDetail(g) {
  const modal = $('#modal');
  const content = $('#modalContent');
  openModalShell(`<div class="m-body" style="padding-top:26px"><h3>${esc(g.name)}</h3><p style="color:var(--text-4);margin-top:8px">载入中…</p></div>`);
  try {
    const data = await api(`/api/game/${g.id}`);
    const full = data.game ?? g;
    const rev = full.rev ?? { total: 0, pct: 0, label: '暂无评测' };
    content.innerHTML = `
      <div class="m-hero">${imgTag(full.header || CDN(full.id, 'header'), full.name, full.id)}</div>
      <div class="m-body">
        <h3>${esc(full.name)}</h3>
        <div class="hero-chips" style="margin-top:10px">
          ${full.year ? `<span class="chip">${full.year}</span>` : ''}
          ${full.price ? `<span class="chip">${esc(full.price)}</span>` : ''}
          <span class="chip ${pctClass(rev.pct)}">${rev.pct ? rev.pct + '% 好评' : '暂无评测'}</span>
        </div>
        <div class="m-stats">
          <div class="stat"><b>${(full.rev?.total || 0) >= 10000 ? 'HOT' : (full.gem ?? 0)}</b><span>${(full.rev?.total || 0) >= 10000 ? '热门' : '冷门指数'}</span></div>
          <div class="stat"><b>${rev.total.toLocaleString()}</b><span>评测数</span></div>
          <div class="stat"><b>${esc(rev.label ?? '—')}</b><span>总评</span></div>
          <div class="stat"><b>${(full.tags ?? []).length}</b><span>标签</span></div>
        </div>
        <div class="hero-chips">
          ${(full.tags ?? []).slice(0, 12).map((t) => `<span class="chip">${esc(t.zh)}</span>`).join('')}
        </div>
        <div class="m-section">
          <h4>你可能也想看看</h4>
          <div class="m-related">
            ${(data.related ?? [])
              .slice(0, 5)
              .map(
                (r) => `<span class="mini" data-rel="${r.id}">${imgTag(CDN(r.id, 'capsule'), r.name, r.id)}${esc(r.name)}</span>`
              )
              .join('') || '<span style="color:var(--text-4);font-size:12px">没有找到相近的作品</span>'}
          </div>
        </div>
        <div class="hero-actions" style="margin-top:22px">
          <a class="btn btn-primary" href="${STORE(full.id)}" target="_blank" rel="noreferrer">在 Steam 打开 ↗</a>
          <button class="btn" id="modalShare">分享给好友</button>
          <button class="btn" id="modalSeed">以此找相似</button>
        </div>
      </div>`;

    content.querySelectorAll('[data-rel]').forEach((el) =>
      el.addEventListener('click', () => {
        const rel = (data.related ?? []).find((r) => String(r.id) === el.dataset.rel);
        if (rel) openDetail(rel);
      })
    );
    $('#modalSeed', content)?.addEventListener('click', () => {
      addSeed({ id: full.id, name: full.name, img: full.header || CDN(full.id, 'header') });
      closeModal();
      switchView('similar');
      runSimilar();
    });
    $('#modalShare', content)?.addEventListener('click', async () => {
      try {
        const m = await import('./community.js?v=' + Date.now());
        m.shareGame(full);
      } catch (e) {
        toast('分享面板没加载出来：' + e.message);
      }
    });
  } catch (e) {
    content.innerHTML = `<div class="m-body" style="padding-top:26px"><h3>${esc(g.name)}</h3>
      <p style="color:var(--red);margin-top:10px">取详情失败：${esc(e.message)}</p>
      <a class="btn" style="margin-top:16px" href="${STORE(g.id)}" target="_blank" rel="noreferrer">直接在 Steam 打开 ↗</a></div>`;
  }
}

// ---------------- 更新日志 ----------------
function openModalShell(html) {
  const modal = $('#modal');
  const content = $('#modalContent');
  modal.hidden = false;
  content.innerHTML = html;
  // 三个弹窗共用同一个滚动容器，不重置就会沿用上一次的滚动位置（标题被顶飞）
  const body = modal.querySelector('.modal-body');
  if (body) body.scrollTop = 0;
}

async function openChangelog() {
  const modal = $('#modal');
  const content = $('#modalContent');
  openModalShell(`<div class="m-body" style="padding-top:24px"><h3>更新日志</h3><p style="color:var(--text-4);margin-top:8px">载入中…</p></div>`);

  let list = [];
  try {
    const res = await fetch(new URL('data/changelog.json', document.baseURI).href, { cache: 'no-store' });
    if (res.ok) list = await res.json();
  } catch {
    /* 本地服务没有这个文件 */
  }

  const rows = (list || []).slice(0, 40);
  openModalShell(`
    <div class="m-body" style="padding-top:24px">
      <h3>更新日志</h3>
      <p style="color:var(--text-4);font-size:12.5px;margin-top:6px">
        每天 11:10（北京时间）由 GitHub Actions 自动抓新游戏入库，抓到后立刻可搜、可当相似种子。
      </p>
      ${
        rows.length
          ? `<table class="log-table">
              <thead><tr><th>日期</th><th>新增</th><th>语料总量</th><th>标签</th></tr></thead>
              <tbody>${rows
                .map(
                  (e) =>
                    `<tr><td>${esc(e.date)}</td><td class="plus">${e.added > 0 ? '+' + e.added : '—'}</td><td>${Number(e.total).toLocaleString()}</td><td>${e.tags ?? '—'}</td></tr>`
                )
                .join('')}</tbody>
            </table>`
          : `<p style="color:var(--text-3);font-size:13px;margin-top:14px">暂无记录 —— 下一次自动更新后会出现在这里。</p>`
      }
    </div>`);
}

function closeModal() {
  $('#modal').hidden = true;
}

// ---------------- 游戏资料面板（SteamDB 风格）----------------
async function openInfo(g) {
  const modal = $('#modal');
  const content = $('#modalContent');
  openModalShell(`<div class="m-body" style="padding-top:26px"><h3>${esc(g.name)}</h3><p style="color:var(--text-4);margin-top:8px">载入资料…</p></div>`);

  let full = g;
  try {
    const data = await api(`/api/game/${g.id}`);
    full = data.game ?? g;
  } catch {
    /* 静态版没有该接口时用卡片数据兜底 */
  }

  const rev = full.rev ?? { total: 0, pct: 0, label: null };
  const tags = full.tags ?? [];
  const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${full.alt || full.name} gameplay`)}`;
  const shots = Array.isArray(full.shots) ? full.shots.filter(Boolean) : [];

  const reqHtml = full.req
    ? `<div class="info-req">${esc(full.req).replace(/\n/g, '<br>')}</div>`
    : `<div class="info-empty">系统需求尚未收录 · 每日自动补全中</div>`;

  content.innerHTML = `
    <div class="info-bar">
      <div class="info-tags">${tags.slice(0, 10).map((t) => `<span class="chip tag">${esc(t.zh)}</span>`).join('')}</div>
    </div>
    <div class="m-hero">${imgTag(full.header || CDN(full.id, 'header'), full.name, full.id)}</div>
    <div class="m-body">
      <div class="info-title-row">
        <h3>${esc(full.name)}</h3>
        ${(full.rev?.total || 0) >= 10000 ? `<span class="info-gem hot">HOT ${full.rev.total.toLocaleString()} 评测</span>` : full.gem ? `<span class="info-gem">冷门 ${full.gem}</span>` : ''}
      </div>
      ${full.alt ? `<div class="info-alt">${esc(full.alt)}</div>` : ''}

      <div class="info-stats">
        <div class="stat"><b class="${pctClass(rev.pct)}">${rev.total ? rev.pct + '%' : '—'}</b><span>好评率</span></div>
        <div class="stat"><b>${rev.total.toLocaleString()}</b><span>评测数</span></div>
        <div class="stat"><b>${full.year ?? '—'}</b><span>发售年</span></div>
        <div class="stat"><b>${esc(full.price ?? (full.free ? '免费' : '—'))}</b><span>价格</span></div>
      </div>

      ${full.desc ? `<div class="info-block"><h4>简介</h4><p>${esc(full.desc)}</p></div>` : ''}

      <div class="info-grid">
        <div class="info-block">
          <h4>开发商 / 发行商</h4>
          <p>${esc(full.dev || '—')}${full.pub && full.pub !== full.dev ? ` · ${esc(full.pub)}` : ''}</p>
        </div>
        <div class="info-block">
          <h4>标签</h4>
          <p>${tags.length ? tags.slice(0, 8).map((t) => esc(t.zh)).join(' / ') : '—'}</p>
        </div>
      </div>

      <div class="info-block">
        <h4>系统需求（最低配置）</h4>
        ${reqHtml}
      </div>

      ${
        shots.length
          ? `<div class="info-block">
        <h4>宣传图 <span class="shot-count" id="shotCount">1 / ${shots.length}</span></h4>
        <div class="shots">
          <button class="shot-nav prev" id="shotPrev" aria-label="上一张">‹</button>
          <img id="shotImg" src="${shots[0]}" alt="${esc(full.name)} 宣传图" loading="lazy">
          <button class="shot-nav next" id="shotNext" aria-label="下一张">›</button>
        </div>
        <div class="shot-dots" id="shotDots">
          ${shots.map((_, i) => `<button class="dot${i === 0 ? ' on' : ''}" data-dot="${i}" aria-label="第 ${i + 1} 张"></button>`).join('')}
        </div>
      </div>`
          : ''
      }

      <div class="hero-actions" style="margin-top:20px">
        <a class="btn btn-primary" href="${STORE(full.id)}" target="_blank" rel="noreferrer">Steam 商店 ↗</a>
        <a class="btn" href="${yt}" target="_blank" rel="noreferrer">YouTube ↗</a>
        <button class="btn" id="infoSeed">加为种子</button>
        <button class="btn" id="infoShareFriend">分享给好友</button>
        <button class="btn" id="infoShare">分享到社区</button>
      <button class="btn btn-quiet" id="infoDetail">完整详情</button>
      </div>
    </div>`;

  $('#infoSeed', content)?.addEventListener('click', () => {
    addSeed({ id: full.id, name: full.name, img: full.header || CDN(full.id, 'header') });
    closeModal();
    switchView('similar');
    runSimilar();
  });
  $('#infoShare', content)?.addEventListener('click', () => {
    import('./community.js?v=' + Date.now()).then((m) => m.openComposer(full));
  });
  $('#infoShareFriend', content)?.addEventListener('click', () => {
    import('./community.js?v=' + Date.now())
      .then((m) => m.shareGame(full))
      .catch((e) => toast('分享面板没加载出来：' + e.message));
  });

  $('#infoDetail', content)?.addEventListener('click', () => openDetail(full));

  // 宣传图翻页
  if (shots.length) {
    let idx = 0;
    const img = $('#shotImg', content);
    const counter = $('#shotCount', content);
    const go = (n) => {
      idx = (n + shots.length) % shots.length;
      if (img) img.src = shots[idx];
      if (counter) counter.textContent = `${idx + 1} / ${shots.length}`;
      $$('.dot', content).forEach((d, i) => d.classList.toggle('on', i === idx));
    };
    $('#shotPrev', content)?.addEventListener('click', () => go(idx - 1));
    $('#shotNext', content)?.addEventListener('click', () => go(idx + 1));
    $('#shotDots', content)?.addEventListener('click', (ev) => {
      const d = ev.target.closest('[data-dot]');
      if (d) go(Number(d.dataset.dot));
    });
  }
}

// ---------------- 视图 ----------------
function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-me')?.classList.toggle('hidden', view !== 'me');
  $('#view-random').classList.toggle('hidden', view !== 'random');
  $('#view-similar').classList.toggle('hidden', view !== 'similar');
  $('#view-events')?.classList.toggle('hidden', view !== 'events');
  $('#view-community')?.classList.toggle('hidden', view !== 'community');
  if (view === 'me') {
    const box = $('#meBody');
    import('./community.js?v=' + Date.now())
      .then((m) => m.renderMe(box))
      .catch((e) => {
        box.innerHTML = '<div class="empty-state">「我的信息」加载失败：' + e.message + '</div>';
      });
  }
  if (view === 'community') {
    import('./community.js?v=' + Date.now()).then((m) => m.renderCommunity($('#communityBody'))).catch((e) => {
      $('#communityBody').innerHTML = '<div class="empty-state">社区加载失败：' + e.message + '</div>';
    });
  }
  if (view === 'similar') setTimeout(() => $('#seedInput')?.focus(), 60);
  if (view === 'events' && !state.eventsLoaded) {
    state.eventsLoaded = true;
    renderEvents();
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
    const q = new URLSearchParams({ ids: ids.join(','), limit: '120' });
    if (weights.some((w) => Number.isFinite(w) && w > 0)) q.set('weights', weights.join(','));
    const data = await api(`/api/similar?${q}`);
    state.seeds = (data.seedCards ?? []).map((c, i) => ({
      id: c.id,
      name: c.name,
      img: c.header,
      weight: Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : 1,
    }));
    state.allResults = randomizeOrder(data.results ?? []);
    state.shown = Math.min(PER_PAGE, state.allResults.length);
    renderSeeds();
    renderExplain(data);
    renderResults();
    return true;
  } catch (e) {
    $('#results').innerHTML = `<div class="empty-state"><span class="big">⚠️</span>链接解析失败：${esc(e.message)}</div>`;
    return true;
  }
}

// ---------------- 悬停浮层 ----------------
const tipState = { timer: null, id: null };

function findGame(id) {
  return (
    (state.randomItems || []).find((g) => g.id === id) ||
    state.allResults.find((g) => g.id === id) ||
    state.recent.find((g) => g.id === id) ||
    null
  );
}

function tipHtml(g) {
  const rev = g.rev ?? { total: 0, pct: 0, label: null };
  const tags = (g.tags ?? []).slice(0, 6);
  const isSimilar = typeof g.score === 'number';
  const reason = g.shared?.length
    ? `因为你们都喜欢 <b>${esc(g.shared.slice(0, 3).join('、'))}</b>`
    : rev.total && rev.total < 500
      ? `只有 <b>${rev.total}</b> 条评测，却拿到 <b>${rev.pct}%</b> 好评`
      : rev.total
        ? `<b>${rev.pct}%</b> 好评 · ${rev.total.toLocaleString()} 条评测`
        : '还没有用户评测';

  return `
    <div class="tip-media">${imgTag(g.header || CDN(g.id, 'header'), g.name, g.id)}</div>
    <div class="tip-body">
      <div class="tip-title">${esc(g.name)}</div>
      ${g.alt ? `<div class="tip-line" style="color:var(--text-4);margin-top:-4px">${esc(g.alt)}</div>` : ''}
      <div class="tip-meta">
        ${g.year ? `<span class="chip">${g.year}</span>` : ''}
        ${g.price ? `<span class="chip">${esc(g.price)}</span>` : ''}
        ${rev.total ? `<span class="chip ${pctClass(rev.pct)}">${rev.pct}% 好评</span>` : '<span class="chip">无评测</span>'}
        ${rev.label ? `<span class="chip">${esc(rev.label)}</span>` : ''}
      </div>
      ${g.desc ? `<div class="tip-desc">${esc(g.desc)}</div>` : ''}
      <div class="tip-line">${reason}</div>
      <div class="tip-tags">${tags.map((t) => `<span>${esc(t.zh)}</span>`).join('')}</div>
      <div class="tip-foot">
        <span class="tip-score">${
          isSimilar
            ? `<b>${Math.min(99, Math.round(Math.pow(Math.max(0, g.score), 0.7) * 100))}</b> 相似度`
            : `<b>${g.gem ?? 0}</b> 冷门指数`
        }</span>
        <span class="tip-hint">点击看详情</span>
      </div>
    </div>`;
}

function showTip(card, g) {
  const el = $('#tip');
  el.innerHTML = tipHtml(g);
  el.hidden = false;

  const r = card.getBoundingClientRect();
  const w = 296;
  const h = el.offsetHeight || 260;
  const gap = 10;
  let left = r.right + gap;
  if (left + w > window.innerWidth - 8) left = r.left - w - gap;
  if (left < 8) left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.top - 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  clearTimeout(tipState.timer);
  tipState.timer = null;
  tipState.id = null;
  const el = $('#tip');
  if (el && !el.hidden) el.hidden = true;
}

function bindTip() {
  document.addEventListener('pointerover', (ev) => {
    const card = ev.target.closest?.('.card');
    if (!card) return;
    const id = Number(card.dataset.id);
    if (tipState.id === id) return;
    // 触屏设备不弹
    if (window.matchMedia('(hover: none)').matches) return;
    hideTip();
    tipState.id = id;
    tipState.timer = setTimeout(() => {
      const g = findGame(id);
      if (g && card.isConnected) showTip(card, g);
    }, 260);
  });

  document.addEventListener('pointerout', (ev) => {
    const card = ev.target.closest?.('.card');
    if (!card) return;
    // 移出到卡片外才隐藏
    const to = ev.relatedTarget;
    if (to && card.contains(to)) return;
    if (tipState.id === Number(card.dataset.id)) hideTip();
  });

  window.addEventListener('scroll', hideTip, { passive: true });
  window.addEventListener('resize', hideTip);
}

// ---------------- Steam 现场 ----------------
let eventIndex = new Map();

function eventCard(g, deal) {
  const rev = g.rev ?? { total: 0, pct: 0 };
  const price = deal?.final != null ? `¥${(deal.final / 100).toFixed(0)}` : g.price || null;
  return `<article class="card" data-eid="${g.id}" tabindex="0">
    <div class="card-media">
      ${imgTag(g.cover || CDN(g.id, 'cover'), g.name, g.id)}
      ${deal?.discount ? `<span class="card-pill deal">-${deal.discount}%</span>` : ''}
      ${rev.total ? `<span class="card-pill left ${pctClass(rev.pct)}">${rev.pct}%</span>` : '<span class="card-pill left">无评测</span>'}
      <span class="card-pill right${(g.rev?.total || 0) >= 10000 ? ' hot' : ''}">${(g.rev?.total || 0) >= 10000 ? 'HOT' : '冷门 ' + (g.gem ?? 0)}</span>
      ${favBtnHtml(g.id)}
      <div class="card-foot">
        <div class="card-title">${esc(g.name)}</div>
        <div class="card-sub">${[g.year, price, rev.total ? `${shortNum(rev.total)} 评` : null].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  </article>`;
}

async function renderEvents() {
  const box = $('#eventsBody');
  box.innerHTML = `<div class="empty-state"><span class="big">📡</span>正在读取 Steam 现场…</div>`;

  let ev = null;
  try {
    const res = await fetch(new URL('data/events.json', document.baseURI).href, { cache: 'no-store' });
    if (res.ok) ev = await res.json();
  } catch {
    /* 本地开发没有这个文件 */
  }

  if (!ev?.sections) {
    box.innerHTML = `<div class="empty-state"><span class="big">📭</span>还没有现场数据 —— 云端每天抓一次，明天再看；<br>
      <span style="font-size:12px;color:var(--text-4)">本地开发时这里为空是正常的</span></div>`;
    return;
  }

  const allIds = new Set();
  for (const list of Object.values(ev.sections)) for (const it of list || []) allIds.add(it.id);
  for (const it of ev.sales || []) allIds.add(it.id);

  let lib = [];
  try {
    const data = await api(`/api/byids?ids=${[...allIds].join(',')}`);
    lib = data.items ?? [];
  } catch {}
  eventIndex = new Map(lib.map((g) => [g.id, g]));

  const deals = new Map();
  for (const it of ev.sections.specials || []) deals.set(it.id, it);
  for (const it of ev.sections.newReleases || []) deals.set(it.id, it);

  const hideHot = state.hideHot;
  const section = (title, desc, items, opts = {}) => {
    const rows = items
      .map((it) => {
        const g = eventIndex.get(it.id);
        if (!g) return null;
        return { g, deal: deals.get(it.id) || it };
      })
      .filter(Boolean)
      .filter((r) => !hideHot || (r.g.rev?.total || 0) < 10000);
    if (!rows.length) return '';
    if (opts.sortByGem) rows.sort((a, b) => (b.g.gem ?? 0) - (a.g.gem ?? 0));
    return `<div class="section-bar"><h3>${title}</h3><span class="hint">${desc}</span></div>
      <div class="grid">${rows.slice(0, opts.limit || 24).map((r) => eventCard(r.g, r.deal)).join('')}</div>`;
  };

  const built = ev.built ? new Date(ev.built) : null;
  $('#eventsHint').textContent = `数据来自 Steam 商店接口${built ? ` · 更新于 ${built.getMonth() + 1}-${String(built.getDate()).padStart(2, '0')} ${String(built.getHours()).padStart(2, '0')}:${String(built.getMinutes()).padStart(2, '0')}` : ''} · 每天自动刷新`;

  box.innerHTML = `<label class="chk" style="display:inline-flex;margin:2px 0 10px"><input type="checkbox" id="hideHotEv" ${state.hideHot ? 'checked' : ''}> 不看热门（评测 &gt; 1 万）</label>` + [
    section('💸 打折中的好价', '冷门佳作优先 —— 便宜、好评、还没人发现', ev.sections.specials || [], { sortByGem: true, limit: 24 }),
    section('🆕 刚上架', '最近发售的新作，先替你看看口碑', ev.sections.newReleases || [], { limit: 24 }),
    section('🧪 即将发售', '上架前先加进观察名单，Demo 见下方筛选', ev.sections.comingSoon || [], { limit: 18 }),
    section('🔥 当前热销', '大盘在买什么，对照着看更清楚', ev.sections.topSellers || [], { limit: 18 }),
  ]
    .filter(Boolean)
    .join('') || `<div class="empty-state"><span class="big">🕳️</span>现场数据里没有与语料重合的游戏</div>`;
}

function bindEvents() {
  $('#eventsBody')?.addEventListener('click', (ev) => {
    const card = ev.target.closest('[data-eid]');
    if (!card) return;
    const g = eventIndex.get(Number(card.dataset.eid));
    if (g) openInfo(g);
  });
}

// ---------------- 启动 ----------------
function boot() {
  loadStatus();
  loadTags();

  // 卡片事件委托
  bindGrid($('#randomGrid'), (id) => (state.randomItems || []).find((x) => x.id === id) || null);
  bindGrid($('#results'), (id) => state.allResults.find((x) => x.id === id) || null);

  // 恢复状态
  try {
    state.recent = JSON.parse(localStorage.getItem('lighthouse.recent') || '[]').slice(0, 14);
    renderRecent();
    const seeds = JSON.parse(localStorage.getItem('lighthouse.seeds') || '[]');
    if (Array.isArray(seeds) && seeds.length) {
      state.seeds = seeds.slice(0, 6);
      renderSeeds();
    }
  } catch {}

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  bindTip();
  bindEvents();

  // #me / #community 之类的深链：直接开对应视图
  const bootView = (location.hash || '').replace(/^#/, '');
  if (['me', 'random', 'similar', 'events', 'community'].includes(bootView)) switchView(bootView);

  // 「我的信息」里点收藏卡 / 点帖子 → 由这里跳转，别让两个页面互相 import
  document.addEventListener('lh:gotoCommunity', () => switchView('community'));
  document.addEventListener('lh:openGame', async (ev) => {
    const id = Number(ev.detail && ev.detail.id);
    if (!id) return;
    try {
      const data = await api('/api/game/' + id);
      if (data.game) openDetail(data.game);
    } catch (e) {
      toast('打不开这款游戏：' + e.message);
    }
  });

  // 只绑定模式分段控件，别把「卡片尺寸」那组按钮一起卷进来
  $$('#modeSeg .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      $$('#modeSeg .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      state.mode = b.dataset.mode;
      roll();
    })
  );

  // ---- 多选标签 ----
  const tagBtn = $('#tagBtn');
  tagBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const panel = $('#tagPanel');
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    tagBtn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      renderTagList($('#tagSearch').value);
      setTimeout(() => $('#tagSearch').focus(), 50);
    }
  });
  $('#tagSearch')?.addEventListener('input', (e) => renderTagList(e.target.value));
  $('#tagPanel')?.addEventListener('click', (ev) => ev.stopPropagation());
  $('#tagList')?.addEventListener('click', (ev) => {
    const item = ev.target.closest('[data-tag]');
    if (item) toggleTag(Number(item.dataset.tag));
  });
  $('#tagChips')?.addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-rmtag]');
    if (!rm) return;
    toggleTag(Number(rm.dataset.rmtag));
    roll();
  });
  $('#tagClear')?.addEventListener('click', () => {
    state.tagIds = [];
    updateTagButton();
    renderTagChips();
    renderTagList($('#tagSearch').value);
    roll();
  });
  $('#tagDone')?.addEventListener('click', () => {
    closeTagPanel();
    roll();
  });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#tagFilter')) closeTagPanel();
  });
  $('#rollBtn').addEventListener('click', roll);
  $('#shuffleGrid').addEventListener('click', rollGrid);
  $('#clearRecent').addEventListener('click', () => {
    state.recent = [];
    renderRecent();
    localStorage.removeItem('lighthouse.recent');
  });

  // 最近条点击
  $('#recentList').addEventListener('click', (ev) => {
    const item = ev.target.closest('.recent-item');
    if (!item) return;
    const g = state.recent.find((x) => x.id === Number(item.dataset.id));
    if (g) openDetail(g);
  });

  // 搜索
  const input = $('#seedInput');
  input.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(e.target.value), 170);
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
      if (ddActive >= 0 && items[ddActive]) pickSeed(Number(items[ddActive].dataset.id), items[ddActive].dataset.name);
      else if (items.length === 1) pickSeed(Number(items[0].dataset.id), items[0].dataset.name);
      else if (state.seeds.length) runSimilar();
    } else if (e.key === 'Escape') closeDropdown();
  });
  input.addEventListener('blur', () => setTimeout(closeDropdown, 140));
  $('#dropdown').addEventListener('mousedown', (ev) => {
    const item = ev.target.closest('.dd-item');
    if (!item) return;
    ev.preventDefault();
    pickSeed(Number(item.dataset.id), item.dataset.name);
  });

  $('#findBtn').addEventListener('click', runSimilar);
  $('#hideHot')?.addEventListener('change', (e) => {
    state.hideHot = e.target.checked;
    try { localStorage.setItem('lh.hideHot', state.hideHot ? '1' : '0'); } catch {}
    roll();
    if (state.view === 'events') renderEvents();
  });
  try { state.hideHot = localStorage.getItem('lh.hideHot') === '1'; } catch {}
  const hhEl = $('#hideHot');
  if (hhEl) hhEl.checked = Boolean(state.hideHot);

  $('#eventsBody')?.addEventListener('change', (e) => {
    if (e.target.id !== 'hideHotEv') return;
    state.hideHot = e.target.checked;
    try { localStorage.setItem('lh.hideHot', state.hideHot ? '1' : '0'); } catch {}
    renderEvents();
  });

  $('#loadMore').addEventListener('click', () => {
    state.shown = Math.min(state.shown + ui.perPage, state.allResults.length);
    renderResults();
  });

  // ---- 显示设置（每屏款数 / 每页款数 / 卡片尺寸）----
  applyUi();
  const uiBtn = $('#uiBtn');
  uiBtn?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const panel = $('#uiPanel');
    const open = panel.hidden;
    panel.hidden = !open;
    uiBtn.setAttribute('aria-expanded', String(open));
  });
  $('#uiPanel')?.addEventListener('click', (ev) => ev.stopPropagation());
  document.addEventListener('click', () => {
    const panel = $('#uiPanel');
    if (panel && !panel.hidden) {
      panel.hidden = true;
      uiBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  $('#perScreen')?.addEventListener('input', (e) => {
    ui.perScreen = Number(e.target.value);
    $('#perScreenOut').textContent = String(ui.perScreen);
    saveUi();
    roll();
  });
  $('#perPage')?.addEventListener('input', (e) => {
    ui.perPage = Number(e.target.value);
    $('#perPageOut').textContent = String(ui.perPage);
    saveUi();
    if (state.allResults.length) {
      state.shown = Math.min(ui.perPage, state.allResults.length);
      renderResults();
    }
  });
  $('#cardSizeSel')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    ui.cardMin = Number(b.dataset.min);
    saveUi();
    applyUi();
  });
  $('#minRev').addEventListener('input', (e) => {
    $('#minRevOut').textContent = Number(e.target.value).toLocaleString();
    scheduleSimilar();
  });
  $('#simPct')?.addEventListener('input', (e) => {
    $('#simPctOut').textContent = `${e.target.value}%`;
    scheduleSimilar();
  });

  // 随机页：Demo 处理 + 好评率下限
  $('#demoSel')?.addEventListener('change', (e) => {
    state.demoMode = e.target.value;
    roll();
  });
  let pctTimer = null;
  $('#minPct')?.addEventListener('input', (e) => {
    state.minPct = Number(e.target.value);
    $('#minPctOut').textContent = `${e.target.value}%`;
    clearTimeout(pctTimer);
    pctTimer = setTimeout(roll, 350);
  });
  ['relFrom', 'relTo'].forEach((id) => {
    $('#' + id)?.addEventListener('change', roll);
  });
  $('#onlyHidden')?.addEventListener('change', scheduleSimilar);
  const maxRevEl = $('#maxRev');
  maxRevEl?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#maxRevOut').textContent = v ? v.toLocaleString() : '不限';
    scheduleSimilar();
  });

  // 种子面板事件
  $('#seedChips').addEventListener('input', (ev) => {
    const el = ev.target.closest('input[data-weight]');
    if (!el) return;
    const i = Number(el.dataset.weight);
    state.seeds[i].weight = Number(el.value);
    el.parentElement.querySelector('.seed-w').textContent =
      Number(el.value) === 0 ? '忽略' : `${Number(el.value).toFixed(1)}×`;
    scheduleSimilar();
  });
  $('#seedChips').addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-rm]');
    if (!rm) return;
    state.seeds.splice(Number(rm.dataset.rm), 1);
    renderSeeds();
    if (state.seeds.length) runSimilar();
    else {
      $('#results').innerHTML = '';
      $('#explain').hidden = true;
      $('#loadMore').hidden = true;
      syncUrl();
    }
  });

  // 空格抽卡
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.view === 'random') roll();
    }
  });

  $$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  $('#changelogBtn')?.addEventListener('click', openChangelog);

  // 登录 / 社区
  window.LH_TOAST = toast;
  window.LH_COMMUNITY_REFRESH = () => {
    if (state.view === 'community') {
      import('./community.js?v=' + Date.now()).then((m) => m.renderCommunity($('#communityBody')));
    }
  };
  import('./community.js?v=' + Date.now()).then((m) => {
    const btn = $('#authBtn');
    if (btn) {
      m.refreshAuthButton();
      btn.addEventListener('click', () => m.openLogin());
    }
  });

  // 画风特征后台就绪 -> 自动重算当前结果
  window.addEventListener('lighthouse:vision', () => {
    if (state.view === 'similar' && state.seeds.length && (state.visualW ?? 20) > 0) {
      toast('画风特征已就绪，正在按新权重重排…', 2600);
      runSimilar();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  });

  (async () => {
    const gameParam = Number(new URLSearchParams(location.search).get('game'));
  if (Number.isFinite(gameParam) && gameParam > 0) { try { setTimeout(() => history.replaceState(null, '', location.pathname), 400); } catch {} }
    const fromLink = await applyDeepLink();
    if (!fromLink) roll();
    if (Number.isFinite(gameParam) && gameParam > 0) openDetail({ id: gameParam, name: '载入中…' });
    const infoParam = Number(new URLSearchParams(location.search).get('info'));
    if (Number.isFinite(infoParam) && infoParam > 0) {
    const key = 'lh.infoOpened.' + infoParam;
    try { history.replaceState(null, '', location.pathname); } catch {}
    if (!sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      openInfo({ id: infoParam, name: '载入中…' });
    }
  }
  })();
}

boot();
