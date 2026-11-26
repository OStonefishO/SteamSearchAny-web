// 静态版引擎：把服务端的相似度算法整体搬到浏览器
// 由 scripts/build-static.mjs 一起打包进 dist/，通过接管 fetch('/api/*') 提供服务
// 这样同一个前端（app.js）在「本地 Node 服务」和「纯静态托管」两种环境下都能跑
(() => {
  if (!window.LIGHTHOUSE_STATIC) return;

  const CDN = (id, kind) =>
    `https://cdn.akamai.steamstatic.com/steam/apps/${id}/${
      kind === 'cover' ? 'library_600x900.jpg' : 'header.jpg'
    }`;

  const S = {
    ready: false,
    loading: null,
    games: [], // 规范化后的游戏对象
    byId: new Map(),
    postings: new Map(), // tagId -> [idx, val, idx, val, ...]
    norms: null, // Float64Array
    idf: new Map(),
    tagDict: {},
    built: null,
  };

  const nowYear = new Date().getFullYear();

  function dataUrl(name) {
    // 用当前页面地址解析，兼容 GitHub Pages 的子路径部署
    return new URL(`data/${name}`, document.baseURI).href;
  }

  /** 只读版本清单（很小），用于语料未就绪时先给出总数 */
  async function peekVersion() {
    try {
      const r = await fetch(dataUrl('version.json'), { cache: 'no-store' });
      if (r.ok) {
        const v = await r.json();
        S.version = S.version || v;
        return v;
      }
    } catch {}
    return null;
  }

  async function load() {
    if (S.ready) return S;
    if (S.loading) return S.loading;
    S.loading = (async () => {
      // 先取版本指纹（强制校验），再按版本拉语料，保证"新游戏出来就能搜到"
      let version = null;
      try {
        const vres = await fetch(new URL('data/version.json', document.baseURI).href, { cache: 'no-store' });
        if (vres.ok) version = await vres.json();
      } catch {
        /* 老构建没有 version.json，退回无指纹 */
      }
      S.version = version;

      const url = dataUrl('games.json') + (version?.v ? `?v=${encodeURIComponent(version.v)}` : '');
      const res = await fetch(url, { cache: version?.v ? 'default' : 'no-cache' });
      if (!res.ok) throw new Error(`语料加载失败 HTTP ${res.status}`);
      const raw = await res.json();
      S.built = raw.built;
      S.tagDict = raw.tagDict || {};
      const labels = raw.labels || [];
      const games = new Array(raw.games.length);
      const byId = new Map();

      for (let i = 0; i < raw.games.length; i += 1) {
        const [id, name, tags, total, pct, labelIdx, year, price, free, alt, desc, extra] = raw.games[i];
        const g = {
          id,
          name,
          alt: alt || null,
          desc: desc || null,
          dev: extra?.[0] || null,
          pub: extra?.[1] || null,
          req: extra?.[2] || null,
          tags, // [[tagId, weight], ...]
          rev: total ? { total, pct, label: labels[labelIdx] || null } : null,
          year: year || null,
          price: price || null,
          free: Boolean(free),
          header: CDN(id, 'header'),
          cover: CDN(id, 'cover'),
        };
        games[i] = g;
        byId.set(id, g);
      }

      // 文档频率 + 向量值 + 倒排索引
      const df = new Map();
      for (const g of games) {
        const seen = new Set();
        for (const [tid] of g.tags) {
          if (seen.has(tid)) continue;
          seen.add(tid);
          df.set(tid, (df.get(tid) || 0) + 1);
        }
      }
      const N = Math.max(1, games.length);
      for (const [tid, freq] of df) S.idf.set(tid, Math.log(1 + N / Math.max(1, freq)));
      S.df = df; // 供「万金油标签」判定使用
      S.gameCount = N;

      const postings = new Map();
      const norms = new Float64Array(games.length);
      for (let i = 0; i < games.length; i += 1) {
        const g = games[i];
        let sum = 0;
        const seen = new Set();
        for (const [tid, w] of g.tags) {
          if (seen.has(tid)) continue;
          seen.add(tid);
          const idf = S.idf.get(tid) || 1;
          const val = idf * (0.25 + 0.75 * Math.min(1, Math.max(0, (w || 500) / 1000)));
          sum += val * val;
          let arr = postings.get(tid);
          if (!arr) postings.set(tid, (arr = []));
          arr.push(i, val);
        }
        norms[i] = Math.sqrt(sum) || 1;
      }

      Object.assign(S, { ready: true, games, byId, postings, norms });
      // 视觉特征放到后台加载，绝不阻塞搜索/推荐
      kickVision();
      return S;
    })();
    return S.loading;
  }

  /** 封面特征：后台加载 + 超时放弃，到达后广播事件让界面自动刷新 */
  function kickVision() {
    if (S.vision || S.visionLoading || S.visionFailed) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    S.visionLoading = fetch(dataUrl('vision.json'), { cache: 'default', signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((vj) => {
        if (!vj?.data) return;
        const vec = new Map();
        const dim = vj.dim || 108;
        for (const [id, b64] of Object.entries(vj.data)) {
          const bin = atob(b64);
          const arr = new Float32Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i) / 255;
          let n = 0;
          for (let i = 0; i < arr.length; i += 1) n += arr[i] * arr[i];
          n = Math.sqrt(n) || 1;
          for (let i = 0; i < arr.length; i += 1) arr[i] /= n;
          vec.set(Number(id), { a: arr, d: dim });
        }
        S.vision = vec;
        try {
          window.dispatchEvent(new CustomEvent('lighthouse:vision', { detail: { count: vec.size } }));
        } catch {}
      })
      .catch(() => {
        S.visionFailed = true; // 本站还没生成特征库，静默降级
      })
      .finally(() => {
        clearTimeout(timer);
        S.visionLoading = null;
      });
  }

  // ---------- 算法（与服务端 similar.mjs 对齐）----------
  const tagZh = (id) => S.tagDict[String(id)] || `标签${id}`;

  function unitVector(g, userWeight = 1) {
    const total = S.gameCount || S.games.length || 1;
    const build = (skipCommon) => {
      const map = new Map();
      for (const [tid, w] of g.tags) {
        const idf = S.idf.get(tid);
        if (!idf) continue;
        // 出现率 > 22% 的标签（单人/独立/动作…）只是"万金油"，会把个性标签淹掉
        if (skipCommon && (S.df?.get(tid) || 0) / total > 0.22) continue;
        map.set(tid, idf * (0.25 + 0.75 * Math.min(1, Math.max(0, (w || 500) / 1000))));
      }
      return map;
    };
    let map = build(true);
    if (!map.size) map = build(false); // 极端情况（种子全是通用标签）回退
    let norm = 0;
    for (const v of map.values()) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    const out = new Map();
    for (const [k, v] of map) out.set(k, (v / norm) * userWeight);
    return out;
  }

  function centroidOf(units) {
    const sum = new Map();
    for (const unit of units) for (const [t, v] of unit) sum.set(t, (sum.get(t) || 0) + v);
    let norm = 0;
    for (const v of sum.values()) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    const out = new Map();
    for (const [t, v] of sum) out.set(t, v / norm);
    return out;
  }

  function scoreAgainst(unit) {
    const acc = new Float64Array(S.games.length);
    for (const [tid, q] of unit) {
      if (!q) continue;
      const arr = S.postings.get(tid);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k += 2) acc[arr[k]] += q * arr[k + 1];
    }
    const cos = new Float64Array(S.games.length);
    for (let i = 0; i < acc.length; i += 1) if (acc[i]) cos[i] = acc[i] / S.norms[i];
    return cos;
  }

  function percentileOf(cos) {
    const idx = [];
    for (let i = 0; i < cos.length; i += 1) if (cos[i] > 0) idx.push(i);
    idx.sort((a, b) => cos[b] - cos[a]);
    const total = Math.max(1, idx.length);
    const pct = new Float64Array(cos.length);
    for (let i = 0; i < idx.length; i += 1) pct[idx[i]] = 1 - i / total;
    return pct;
  }

  function findSimilar(seeds, opts) {
    const { limit = 24, tagIds = [], minReviews = 0, maxReviews = 0, minPct = 0, demoMode = 'exclude', visualWeight = 0.2 } = opts || {};
    const t0 = performance.now();
    const seedIds = new Set(seeds.map((s) => s.g.id));
    const units = seeds.map((s) => unitVector(s.g, Math.max(0.05, s.weight || 1)));
    const centroid = centroidOf(units);
    const single = seeds.length === 1;

    const fusionCos = scoreAgainst(centroid);
    const perSeedCos = units.map((u) => scoreAgainst(u));
    const perSeedPct = perSeedCos.map((c) => percentileOf(c));
    const norm = (c) => Math.max(0, Math.min(1, (c - 0.18) / 0.62));

    // 种子封面平均向量（用于「画风相似」的隐性加权）
    let seedVec = null;
    if (S.vision?.size) {
      const acc = new Float32Array(S.vision.values().next().value.a.length);
      let n = 0;
      for (const s of seeds) {
        const v = S.vision.get(s.g.id);
        if (!v) continue;
        for (let i = 0; i < acc.length; i += 1) acc[i] += v.a[i];
        n += 1;
      }
      if (n) {
        let len = 0;
        for (let i = 0; i < acc.length; i += 1) len += acc[i] * acc[i];
        len = Math.sqrt(len) || 1;
        for (let i = 0; i < acc.length; i += 1) acc[i] /= len;
        seedVec = acc;
      }
    }

    const scored = [];
    for (let i = 0; i < S.games.length; i += 1) {
      const fusion = fusionCos[i];
      if (!fusion) continue;
      const g = S.games[i];
      if (seedIds.has(g.id)) continue;
      if (tagIds.length) {
        const set = new Set(g.tags.map((t) => t[0]));
        if (!tagIds.every((id) => set.has(id))) continue;
      }
      const total = g.rev?.total || 0;
      if (minReviews && total < minReviews) continue;
      if (maxReviews && total > maxReviews) continue;
      if (minPct && (g.rev?.pct ?? 0) < minPct) continue;
      if (!passDemo(g, demoMode)) continue;

      const fusionNorm = norm(fusion);
      let score;
      let fit;
      if (single) {
        score = fusionNorm;
        fit = perSeedPct[0][i];
      } else {
        let sum = 0;
        let min = Infinity;
        for (const c of perSeedCos) {
          const v = c[i];
          sum += v;
          if (v < min) min = v;
        }
        const meanN = norm(sum / perSeedCos.length);
        const minN = norm(min);
        score = 0.46 * fusionNorm + 0.3 * meanN + 0.24 * minN;
        fit = 0.5 * meanN + 0.5 * minN;
      }

      const shared = [];
      for (const [tid] of g.tags) {
        const c = centroid.get(tid);
        if (c) shared.push({ id: tid, v: c, zh: tagZh(tid) });
      }
      shared.sort((a, b) => b.v - a.v);

      // 画风相似度（封面灰度高维余弦）
      let vsim = 0;
      if (seedVec) {
        const v = S.vision.get(g.id);
        if (v) {
          for (let k = 0; k < seedVec.length; k += 1) vsim += seedVec[k] * v.a[k];
        }
      }

      scored.push({
        i,
        score,
        fusion: fusionNorm,
        fit,
        vsim,
        perSeed: perSeedPct.map((p) => p[i] * 100),
        shared: shared.slice(0, 5).map((s) => s.zh),
      });
    }

    // 好评率轻加权：同等相似度下口碑好的优先（不是硬过滤，低分作品仍会出现）
    for (const x of scored) {
      const pct = S.games[x.i].rev?.pct ?? 0;
      if (pct > 0) x.score *= 0.88 + 0.12 * (pct / 100);
    }

    scored.sort((a, b) => b.score - a.score || (S.games[b.i].rev?.total || 0) - (S.games[a.i].rev?.total || 0));

    // MMR 去重：避免前十款全是同一个模板换皮，保证列表里有不同风味
    const picked = [];
    let skipped = 0;
    for (const r of scored) {
      if (picked.length >= limit) break;
      if (picked.length && skipped < 40) {
        const rt = new Set(S.games[r.i].tags.slice(0, 3).map((t) => t[0]));
        let dup = false;
        for (const p of picked) {
          const pt = new Set(S.games[p.i].tags.slice(0, 3).map((t) => t[0]));
          let inter = 0;
          for (const t of rt) if (pt.has(t)) inter += 1;
          if (inter >= 2) { dup = true; break; }
        }
        if (dup) { skipped += 1; continue; }
      }
      picked.push(r);
    }
    if (picked.length < limit) {
      const used = new Set(picked.map((p) => p.i));
      for (const r of scored) {
        if (used.has(r.i)) continue;
        picked.push(r);
        if (picked.length >= limit) break;
      }
    }

    return {
      ok: true,
      poolMatched: scored.length,
      seeds: seeds.map((s) => ({
        id: s.g.id,
        name: s.g.name,
        weight: s.weight,
        tags: s.g.tags.slice(0, 8).map((t) => tagZh(t[0])),
      })),
      results: picked.map((r) => ({
        ...S.games[r.i],
        url: `https://store.steampowered.com/app/${S.games[r.i].id}/`,
        score: r.score,
        fusion: r.fusion,
        fit: r.fit,
        perSeed: r.perSeed,
        shared: r.shared,
      })),
      unresolved: [],
      tookMs: Math.round(performance.now() - t0),
      indexSize: S.games.length,
      seedCards: seeds.map((s) => decorate(s.g)),
    };
  }

  function gemScore(g) {
    const total = g.rev?.total || 0;
    const pct = g.rev?.pct || 0;
    if (total < 12 || pct <= 0) return 0;
    const quality = Math.max(0, Math.min(1, (pct - 70) / 30));
    let obscurity;
    if (total <= 120) obscurity = 1;
    else if (total <= 1000) obscurity = 1 - ((total - 120) / 880) * 0.35;
    else if (total <= 10000) obscurity = 0.65 - ((total - 1000) / 9000) * 0.35;
    else if (total <= 60000) obscurity = 0.3 - ((total - 10000) / 50000) * 0.2;
    else obscurity = 0.05;
    const year = g.year || 0;
    const fresh = year >= nowYear - 2 ? 0.08 : year >= nowYear - 5 ? 0.04 : 0;
    return Math.round(Math.max(0, Math.min(1, 0.55 * quality + 0.45 * obscurity + fresh)) * 100);
  }

  const isGem = (g, { minPct = 78, maxReviews = 60000, minReviews = 12 } = {}) => {
    const total = g.rev?.total || 0;
    const pct = g.rev?.pct || 0;
    return total >= minReviews && total <= maxReviews && pct >= minPct;
  };

  function decorate(g) {
    return {
      ...g,
      url: `https://store.steampowered.com/app/${g.id}/`,
      gem: gemScore(g),
      tags: g.tags.slice(0, 12).map(([id, w]) => ({ id, zh: tagZh(id), w })),
    };
  }

  const DEMO_RE = /(^|[\s:：\-–\[(])demo\b|试玩|序章|prologue|playtest/i;
  const isDemo = (g) => DEMO_RE.test(g.name || '') || DEMO_RE.test(g.alt || '');
  const passDemo = (g, demoMode) => {
    if (demoMode === 'only') return isDemo(g);
    if (demoMode === 'all') return true;
    return !isDemo(g); // 默认排除 demo
  };

  function randomPool({ mode, tagIds, minYear, minPct = 0, demoMode = 'exclude' }) {
    const out = [];
    for (const g of S.games) {
      if (tagIds?.length) {
        const set = new Set(g.tags.map((t) => t[0]));
        if (!tagIds.every((id) => set.has(id))) continue;
      }
      if (minYear && (g.year || 0) < minYear) continue;
      if (!passDemo(g, demoMode)) continue;
      if (minPct && ((g.rev?.pct ?? 0) < minPct || !g.rev?.total)) continue;
      if (mode === 'gem') {
        if (!isGem(g)) continue;
      } else if (mode === 'hidden') {
        if (!isGem(g, { minPct: 80, maxReviews: 3000 })) continue;
      } else if (mode === 'fresh') {
        if ((g.year || 0) < nowYear - 2 || !isGem(g, { minPct: 70, maxReviews: 200000 })) continue;
      }
      out.push(g);
    }
    return out;
  }

  function pickRandom(list, count, exclude) {
    const ex = new Set((exclude || []).map(Number));
    let pool = list.filter((g) => !ex.has(g.id));
    if (!pool.length) pool = list;
    const copy = pool.slice();
    const picked = [];
    for (let i = 0; i < count && copy.length; i += 1) {
      const idx = Math.floor(Math.random() * copy.length);
      picked.push(copy.splice(idx, 1)[0]);
    }
    return picked;
  }

  function searchGames(q, limit) {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return [];
    const hits = [];
    for (const g of S.games) {
      for (const name of [g.name, g.alt]) {
        if (!name) continue;
        const lower = name.toLowerCase();
        let rank = -1;
        if (lower === query) rank = 0;
        else if (lower.startsWith(query)) rank = 1;
        else if (lower.includes(query)) rank = 2;
        if (rank >= 0) {
          hits.push({ id: g.id, name: g.name, inCorpus: true, rank, len: g.name.length });
          break;
        }
      }
    }
    return hits.sort((a, b) => a.rank - b.rank || a.len - b.len).slice(0, limit);
  }

  function topTags(limit) {
    const counts = new Map();
    for (const g of S.games) for (const [tid] of g.tags) counts.set(tid, (counts.get(tid) || 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, count]) => ({ id, zh: tagZh(id), en: '', count }));
  }

  // ---------- fetch 接管 ----------
  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  async function handle(u) {
    const parts = u.pathname.split('/').filter(Boolean); // [...prefix, 'api', ...]
    const apiIdx = parts.indexOf('api');
    const path = parts.slice(apiIdx + 1); // ['random'] 等
    const tail = path[0] || '';
    const q = u.searchParams;

    // 状态：语料还没读完也能先报个大概（用 version.json 的计数）
    if (tail === 'status' && !S.ready) {
      const v = S.version || (await peekVersion());
      if (v) {
        return jsonResponse({
          ok: true,
          index: { ready: false, games: v.count, tags: v.tags, loadedAt: v.built },
          build: { inProcess: true, planned: v.count, fetched: 0, finished: false, startedAt: v.built },
          static: true,
          loading: true,
        });
      }
    }

    await load();
    if (tail === 'status') {
      return jsonResponse({
        ok: true,
        index: { ready: true, games: S.games.length, tags: Object.keys(S.tagDict).length, loadedAt: S.built },
        build: { inProcess: false, planned: S.games.length, fetched: S.games.length, finished: true, startedAt: S.built },
        static: true,
      });
    }
    if (tail === 'tags') {
      return jsonResponse({ ok: true, tags: topTags(Math.min(400, Number(q.get('limit')) || 80)) });
    }
    if (tail === 'search') {
      return jsonResponse({ ok: true, items: searchGames(q.get('q'), Math.min(30, Number(q.get('limit')) || 12)) });
    }
    if (tail === 'random') {
      const mode = q.get('mode') || 'gem';
      const tagIds = (q.get('tags') || q.get('tag') || '')
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0);
      const count = Math.min(48, Number(q.get('count')) || 1);
      const exclude = (q.get('exclude') || '').split(',').map(Number).filter(Boolean);
      const minYear = Number(q.get('minYear')) || null;
      const minPct = Number(q.get('minPct')) || 0;
      const demoMode = q.get('demo') || 'exclude';
      const pool = randomPool({ mode, tagIds, minYear, minPct, demoMode });
      if (!pool.length) return jsonResponse({ ok: true, poolSize: 0, items: [] });
      return jsonResponse({
        ok: true,
        poolSize: pool.length,
        mode,
        tags: tagIds.map((id) => ({ id, zh: tagZh(id) })),
        items: pickRandom(pool, count, exclude).map(decorate),
      });
    }
    if (tail === 'similar') {
      const ids = (q.get('ids') || '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 8);
      if (!ids.length) return jsonResponse({ ok: false, error: 'NO_IDS' }, 400);
      const weights = (q.get('weights') || '').split(',').map(Number);
      const resolved = [];
      const unresolved = [];
      for (const id of ids) {
        const g = S.byId.get(id);
        if (g) resolved.push(g);
        else unresolved.push(id);
      }
      if (!resolved.length) {
        return jsonResponse(
          { ok: false, error: 'SEEDS_UNRESOLVED', unresolved, hint: '静态版的语料只含常见作品，这款不在库里' },
          503
        );
      }
      const seeds = resolved.map((g) => {
        const w = weights[ids.indexOf(g.id)];
        return { g, weight: Number.isFinite(w) && w > 0 ? w : 1 };
      });
      const out = findSimilar(seeds, {
        limit: Math.min(120, Number(q.get('limit')) || 24),
        tagIds: (q.get('tags') || q.get('tag') || '')
          .split(',')
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0),
        minReviews: Number(q.get('minReviews')) || 0,
        maxReviews: Number(q.get('maxReviews')) || 0,
        minPct: Number(q.get('minPct')) || 0,
        demoMode: q.get('demo') || 'exclude',
        visualWeight: q.get('vw') != null ? Number(q.get('vw')) / 100 : 0.2,
      });
      return jsonResponse({ ...out, unresolved });
    }
    if (tail === 'game') {
      const id = Number(path[1]);
      const g = S.byId.get(id);
      if (!g) return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404);
      const related = findSimilar([{ g, weight: 1 }], { limit: 6 }).results;
      return jsonResponse({ ok: true, game: decorate(g), related });
    }
    return jsonResponse({ ok: false, error: 'UNKNOWN_ENDPOINT' }, 404);
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? new URL(input, document.baseURI) : input instanceof URL ? input : new URL(input.url, document.baseURI);
    if (/\/api\//.test(url.pathname)) {
      try {
        return await handle(url);
      } catch (err) {
        return jsonResponse({ ok: false, error: 'LOCAL_ENGINE_FAILED', message: String(err.message || err) }, 500);
      }
    }
    return origFetch(input, init);
  };

  // 预加载，缩短首次交互等待
  setTimeout(() => load().catch(() => {}), 50);
})();
