// Steam 灯塔 · 前端 v2（更密的网格 / 更大的字 / 一次多给几款）
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PER_PAGE = 45; // 相似结果一页显示多少

const state = {
  view: 'random',
  mode: 'hidden',
  tagId: '',
  seeds: [],
  allResults: [],
  shown: 0,
  recent: [],
  heroId: null,
  revealStep: 12,
};

const CDN = (id, kind) => {
  const file = kind === 'cover' ? 'library_600x900.jpg' : kind === 'capsule' ? 'capsule_231x87.jpg' : 'header.jpg';
  return `https://cdn.akamai.steamstatic.com/steam/apps/${id}/${file}`;
};
const STORE = (id) => `https://store.steampowered.com/app/${id}/`;

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
    $('#corpusText').textContent = `${data.index.games.toLocaleString()} 款 · ${data.index.tags} 标签`;
    $('#corpusPill').title = `本地语料：${data.index.games} 款游戏，${data.index.tags} 个 Valve 官方标签`;
  } catch {
    $('#corpusText').textContent = '语料未就绪';
  }
}

async function loadTags() {
  try {
    const data = await api('/api/tags?limit=80');
    const sel = $('#tagSelect');
    for (const t of data.tags) {
      const opt = document.createElement('option');
      opt.value = String(t.id);
      opt.textContent = `${t.zh} · ${t.count}`;
      sel.appendChild(opt);
    }
  } catch {
    /* 忽略 */
  }
}

// ---------------- 卡片 ----------------
function cardHtml(g, index, { score = false } = {}) {
  const rev = g.rev ?? { total: 0, pct: 0 };
  const ratingPill = rev.total
    ? `<span class="card-pill left ${pctClass(rev.pct)}">${rev.pct}%</span>`
    : `<span class="card-pill left">无评测</span>`;
  const right = score
    ? `<span class="card-pill score">${Math.min(99, Math.round(Math.pow(Math.max(0, g.score ?? 0), 0.7) * 100))}</span>`
    : `<span class="card-pill right">冷门 ${g.gem ?? 0}</span>`;
  // 相似视图里好评率下移到副标题，避免两个角标抢戏
  const sub = score
    ? [g.year ?? null, rev.total ? `${rev.pct}%` : null, rev.total ? `${shortNum(rev.total)} 评测` : null]
        .filter(Boolean)
        .join(' · ')
    : [g.year ?? null, rev.total ? `${shortNum(rev.total)} 评测` : null, g.price && g.price !== '¥0.00' ? g.price : null]
        .filter(Boolean)
        .join(' · ');

  return `<article class="card" data-id="${g.id}" tabindex="0" style="animation-delay:${Math.min(index * 16, 420)}ms"
    title="${esc(g.name)}${g.shared?.length ? ` · 因为 ${esc(g.shared.slice(0, 3).join('、'))}` : ''}">
    <div class="card-media">
      ${imgTag(g.cover || CDN(g.id, 'cover'), g.name, g.id)}
      ${score ? '' : ratingPill}
      ${right}
      <button class="card-seed" data-seed="${g.id}" title="加为相似种子">＋</button>
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
      <div class="hero-eyebrow"><span class="spark"></span>今日捞到 · 冷门指数 ${gem}</div>
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
        <button class="btn btn-primary" id="rollAgain">换一批 <kbd>空格</kbd></button>
        <button class="btn" id="heroDetail">看看详情</button>
        <button class="btn" id="heroSimilar">以此找相似</button>
        <a class="btn btn-quiet" href="${STORE(g.id)}" target="_blank" rel="noreferrer">Steam ↗</a>
      </div>
    </div>
    <div class="hero-stats">
      <div class="stat hot"><b>${gem}</b><span>冷门指数</span></div>
      <div class="stat"><b>${rev.total ? shortNum(rev.total) : '0'}</b><span>评测数</span></div>
      <div class="stat"><b>${g.year ?? '—'}</b><span>发售</span></div>
    </div>`;

  $('#heroCard').onclick = (ev) => {
    const tag = ev.target.closest('[data-tag]');
    if (tag) {
      state.tagId = tag.dataset.tag;
      $('#tagSelect').value = state.tagId;
      roll();
      return;
    }
    if (ev.target.closest('#rollAgain')) roll();
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
  const params = new URLSearchParams({ mode: state.mode, count: String(count) });
  if (state.tagId) params.set('tag', state.tagId);
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
    const data = await draw(33);
    if (!data.items?.length) {
      toast('这个筛选下没货了，换个标签试试');
      return;
    }
    const [hero, ...rest] = data.items;
    state.heroId = hero.id;
    renderHero(hero);
    pushRecent(hero);
    state.randomItems = rest.slice(0, 32);
    renderGrid($('#randomGrid'), state.randomItems);
    $('#gridCount').textContent = String(Math.min(32, rest.length));
    $('#poolInfo').textContent = `候选池 ${data.poolSize.toLocaleString()} 款${data.tag ? ' · ' + data.tag.zh : ''}`;
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
    const data = await draw(32);
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
        <input type="range" min="0.2" max="2" step="0.1" value="${s.weight}" data-weight="${i}">
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
    if ($('#onlyHidden')?.checked) q.set('maxReviews', '5000');

    const data = await api(`/api/similar?${q}`);
    state.allResults = data.results ?? [];
    state.shown = Math.min(PER_PAGE, state.allResults.length);
    renderExplain(data);
    renderResults();
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
  modal.hidden = false;
  content.innerHTML = `<div class="m-body" style="padding-top:26px"><h3>${esc(g.name)}</h3><p style="color:var(--text-4);margin-top:8px">载入中…</p></div>`;
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
          <div class="stat"><b>${full.gem ?? 0}</b><span>冷门指数</span></div>
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
  } catch (e) {
    content.innerHTML = `<div class="m-body" style="padding-top:26px"><h3>${esc(g.name)}</h3>
      <p style="color:var(--red);margin-top:10px">取详情失败：${esc(e.message)}</p>
      <a class="btn" style="margin-top:16px" href="${STORE(g.id)}" target="_blank" rel="noreferrer">直接在 Steam 打开 ↗</a></div>`;
  }
}

function closeModal() {
  $('#modal').hidden = true;
}

// ---------------- 视图 ----------------
function switchView(view) {
  state.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#view-random').classList.toggle('hidden', view !== 'random');
  $('#view-similar').classList.toggle('hidden', view !== 'similar');
  if (view === 'similar') setTimeout(() => $('#seedInput')?.focus(), 60);
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
    state.allResults = data.results ?? [];
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
  $('#loadMore').addEventListener('click', () => {
    state.shown = Math.min(state.shown + PER_PAGE, state.allResults.length);
    renderResults();
  });
  $('#minRev').addEventListener('input', (e) => {
    $('#minRevOut').textContent = Number(e.target.value).toLocaleString();
    scheduleSimilar();
  });
  $('#onlyHidden')?.addEventListener('change', scheduleSimilar);

  // 种子面板事件
  $('#seedChips').addEventListener('input', (ev) => {
    const el = ev.target.closest('input[data-weight]');
    if (!el) return;
    const i = Number(el.dataset.weight);
    state.seeds[i].weight = Number(el.value);
    el.parentElement.querySelector('.seed-w').textContent = `${Number(el.value).toFixed(1)}×`;
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').hidden) closeModal();
  });

  (async () => {
    const gameParam = Number(new URLSearchParams(location.search).get('game'));
    const fromLink = await applyDeepLink();
    if (!fromLink) roll();
    if (Number.isFinite(gameParam) && gameParam > 0) openDetail({ id: gameParam, name: '载入中…' });
  })();
}

boot();
