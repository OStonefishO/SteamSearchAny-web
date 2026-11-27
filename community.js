// 社区 v3：图片(≤9)、帖子详情页、分页(可配置)、点赞、删评论
import { isConfigured, sendCode, verifyCode, logout, currentEmail, session, captureHashSession, fillEmailFromUser, setPassword, signInWithPassword } from './supabase-lite.js';

try {
  const rawUrl = location.href;
  const claimed = captureHashSession();
  if (claimed) window.__LH_LOGIN_URL = rawUrl;
  Promise.resolve(claimed ? fillEmailFromUser() : null).then(() => syncProfile()).then(() => refreshAuthButton()).catch(() => {});
} catch {}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeAgo = (iso) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
};

/* ---------- 资料 ---------- */
const PK = 'lh.profile';
export function profile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PK) || '{}'); } catch {}
  const email = currentEmail() || '';
  let id = p.id;
  if (!id) {
    id = 1000000000 + Math.floor(Math.random() * 9000000000);
    try { p.id = id; localStorage.setItem(PK, JSON.stringify(p)); } catch {}
  }
  return { id, name: p.name || (email ? email.split('@')[0] : ''), avatar: p.avatar || '🎮', img: p.img || '', color: p.color || '#45bdf7' };
}
function saveProfile(p) { try { localStorage.setItem(PK, JSON.stringify(p)); } catch {} }

const AVATARS = ['🎮', '🕹️', '👾', '🚀', '🌌', '🐱', '🦊', '🐳', '🌙', '⭐', '🔥', '🎧'];
const COLORS = ['#45bdf7', '#b6e04a', '#ffb04d', '#f4736f', '#a78bfa', '#34d399', '#f472b6'];
let DRAFT = null;

function avatarHtml(p, size = 40) {
  const base = `width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;display:grid;place-items:center;overflow:hidden;border:1px solid ${p.color || '#45bdf7'}55;background:${p.color || '#45bdf7'}1f;flex:none;`;
  if (p.img) return `<span style="${base}"><img src="${p.img}" style="width:100%;height:100%;object-fit:cover"></span>`;
  return `<span style="${base}font-size:${Math.round(size * 0.5)}px">${esc(p.avatar || '🎮')}</span>`;
}

/* ---------- REST ---------- */
const AUTH_KEY = 'lh.auth';

async function tryRefreshToken() {
  let sess = null;
  try { sess = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch {}
  if (!sess || !sess.refresh_token) return false;
  const cfg = window.LIGHTHOUSE_SUPABASE || {};
  try {
    const r = await fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: sess.refresh_token }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    const next = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (d.expires_in || 3600) * 1000,
      email: (d.user && d.user.email) || sess.email,
      uid: d.user && d.user.id,
    };
    localStorage.setItem(AUTH_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

async function rest(path, opts = {}, retried = false) {
  const cfg = window.LIGHTHOUSE_SUPABASE || {};
  const s = session();
  const res = await fetch(cfg.url + path, {
    method: opts.method || 'GET',
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${s?.access_token || cfg.anonKey}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const txt = await res.text();
  const data = txt ? JSON.parse(txt) : null;
  if (res.status === 401 && !retried) {
    const ok = await tryRefreshToken();
    if (ok) return rest(path, opts, true);
    localStorage.removeItem(AUTH_KEY);
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) throw new Error((data && data.message) || 'HTTP ' + res.status);
  return data;
}

/* ---------- 远端资料 ---------- */
async function apiGetProfile(email) {
  const rows = await rest('/rest/v1/profiles?select=user_email,uid,name,avatar,color&user_email=eq.' + encodeURIComponent(email) + '&limit=1');
  return rows && rows[0];
}
async function apiUpsertProfile(p) {
  const email = currentEmail();
  if (!email) return;
  await rest('/rest/v1/profiles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: [{ user_email: email, uid: p.id, name: p.name, avatar: p.img || p.avatar, color: p.color, updated_at: new Date().toISOString() }],
  });
}
export async function syncProfile() {
  const email = currentEmail();
  if (!email || !isConfigured()) return profile();
  try {
    const remote = await apiGetProfile(email);
    if (remote) {
      const local = profile();
      const merged = {
        id: Number(remote.uid),
        name: remote.name || local.name,
        avatar: (remote.avatar || '').startsWith('data:') ? local.avatar : (remote.avatar || local.avatar),
        img: (remote.avatar || '').startsWith('data:') ? remote.avatar : (local.img || ''),
        color: remote.color || local.color,
      };
      saveProfile(merged);
      return merged;
    }
    const local = profile();
    await apiUpsertProfile(local);
    return local;
  } catch {
    return profile();
  }
}
async function refreshOwnPosts(p) {
  const email = currentEmail();
  if (!email) return;
  try {
    await rest('/rest/v1/posts?author_email=eq.' + encodeURIComponent(email), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: { author_name: p.name, author_avatar: p.img || p.avatar, author_id: p.id },
    });
  } catch {}
}

/* ---------- 图片压缩 ---------- */
function compressImage(file, max = 1000, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        let { width: w, height: h } = im;
        const scale = Math.min(1, max / Math.max(w, h));
        const cv = document.createElement('canvas');
        cv.width = Math.round(w * scale);
        cv.height = Math.round(h * scale);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      im.onerror = reject;
      im.src = String(fr.result);
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/* ---------- 头像裁剪 ---------- */
function openAvatarEditor(file, onDone) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  const reader = new FileReader();
  reader.onload = () => {
    m.hidden = false;
    box.innerHTML = `<div class="m-body">
      <h3>调整头像</h3>
      <div class="crop-wrap"><canvas id="cropCv" width="260" height="260"></canvas></div>
      <label class="field-label">缩放</label>
      <input type="range" id="zoom" min="100" max="260" value="140" style="width:100%">
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-primary" id="cropOk" style="flex:1">用这张</button>
        <button class="btn" id="cropCancel">取消</button>
      </div></div>`;
    const cv = box.querySelector('#cropCv');
    const ctx = cv.getContext('2d');
    const im = new Image();
    im.onload = () => {
      const draw = (zoom) => {
        const scale = zoom / 100;
        const side = Math.min(im.width, im.height) / scale;
        ctx.clearRect(0, 0, 260, 260);
        ctx.drawImage(im, (im.width - side) / 2, (im.height - side) / 2, side, side, 0, 0, 260, 260);
      };
      draw(140);
      box.querySelector('#zoom').oninput = (e) => draw(Number(e.target.value));
      box.querySelector('#cropOk').onclick = () => {
        const out = document.createElement('canvas');
        out.width = 96; out.height = 96;
        out.getContext('2d').drawImage(cv, 0, 0, 96, 96);
        onDone(out.toDataURL('image/jpeg', 0.82));
        m.hidden = true;
        openLogin();
      };
      box.querySelector('#cropCancel').onclick = () => (m.hidden = true);
    };
    im.src = String(reader.result);
  };
  reader.readAsDataURL(file);
}

/* ---------- 账号面板 ---------- */
export function openLogin() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  const email = currentEmail();

  if (!isConfigured()) {
    box.innerHTML = `<div class="m-body"><h3>还没有接后端</h3></div>`;
    return;
  }
  if (!email) {
    box.innerHTML = `<div class="m-body"><h3>登录</h3>
      <div class="segs" style="display:flex;gap:8px;margin:6px 0 14px">
        <button class="btn btn-sm" id="tabMail" style="flex:1">邮件链接</button>
        <button class="btn btn-sm" id="tabPw" style="flex:1">账号密码</button>
      </div>
      <div id="mailPane">
      <p style="color:var(--text-3);font-size:13px;margin:8px 0 14px">输入邮箱，会收到一封带登录链接的邮件。</p>
      <input class="input" id="authEmail" type="email" placeholder="you@example.com">
      <button class="btn btn-primary btn-block" id="sendCode" style="margin-top:10px">发送邮件</button>
      <div id="codeBox" class="hidden" style="margin-top:14px">
        <input class="input" id="authCode" inputmode="numeric" placeholder="6 位验证码（可选）" maxlength="8">
        <button class="btn btn-block" id="doVerify" style="margin-top:10px">用验证码登录</button>
      </div>
      <p id="authMsg" style="font-size:12px;color:var(--text-4);margin-top:10px"></p>
      </div>
      <div id="pwPane" class="hidden">
        <input class="input" id="pwEmail" type="email" placeholder="邮箱" autocomplete="username">
        <input class="input" id="pwPass" type="password" placeholder="密码" style="margin-top:8px" autocomplete="current-password">
        <button class="btn btn-primary btn-block" id="pwLogin" style="margin-top:10px">登录</button>
        <p id="pwMsg" style="font-size:12px;color:var(--text-4);margin-top:10px"></p>
      </div></div>`;
    const msg = box.querySelector('#authMsg');
    const mailPane = box.querySelector('#mailPane');
    const pwPane = box.querySelector('#pwPane');
    box.querySelector('#tabMail').onclick = () => { mailPane.classList.remove('hidden'); pwPane.classList.add('hidden'); };
    box.querySelector('#tabPw').onclick = () => { pwPane.classList.remove('hidden'); mailPane.classList.add('hidden'); };

    const pwMsg = box.querySelector('#pwMsg');
    box.querySelector('#pwLogin').onclick = async () => {
      const em = box.querySelector('#pwEmail').value.trim();
      const pw = box.querySelector('#pwPass').value;
      if (!em || !pw) return (pwMsg.textContent = '邮箱和密码都要填');
      pwMsg.textContent = '登录中…';
      try { await signInWithPassword(em, pw); m.hidden = true; location.reload(); }
      catch (e) { pwMsg.textContent = '登录失败：' + e.message; }
    };

    box.querySelector('#sendCode').onclick = async () => {
      const em = box.querySelector('#authEmail').value.trim();
      if (!em) return (msg.textContent = '请填邮箱');
      msg.textContent = '发送中…';
      try { await sendCode(em); box.querySelector('#codeBox').classList.remove('hidden'); msg.textContent = '邮件已发送'; }
      catch (e) { msg.textContent = '失败：' + e.message; }
    };
    box.querySelector('#doVerify').onclick = async () => {
      const code = box.querySelector('#authCode').value.trim();
      if (!code) return (msg.textContent = '请填验证码');
      try { await verifyCode(box.querySelector('#authEmail').value.trim(), code); m.hidden = true; location.reload(); }
      catch (e) { msg.textContent = '失败：' + e.message; }
    };
    return;
  }

  DRAFT = DRAFT || { ...profile() };
  const p = DRAFT;
  box.innerHTML = `<div class="m-body">
    <h3>我的账号</h3>
    <div class="profile-head"><span id="avatarPreview">${avatarHtml(p, 56)}</span>
      <div><div class="profile-name">${esc(p.name)}</div>
      <div class="profile-mail">${esc(email)} · UID #${p.id}</div></div></div>
    <label class="field-label">昵称</label>
    <input class="input" id="pName" maxlength="16" value="${esc(p.name)}">
    <label class="field-label">上传头像（可缩放）</label>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn" id="uploadBtn">选择图片</button>
      <button class="btn" id="clearImg">用 emoji</button>
      <input type="file" id="fileIn" accept="image/*" class="hidden">
    </div>
    <label class="field-label">或选一个 emoji</label>
    <div class="picker" id="pAvatars">${AVATARS.map((a) => `<button class="pick ${a === p.avatar && !p.img ? 'on' : ''}" data-av="${a}">${a}</button>`).join('')}</div>
    <label class="field-label">主题色</label>
    <div class="picker" id="pColors">${COLORS.map((c) => `<button class="pick-dot ${c === p.color ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
    <label class="field-label">登录密码（设置后可在任意设备用邮箱+密码登录）</label>
    <div style="display:flex;gap:8px">
      <input class="input" id="newPw" type="password" placeholder="至少 6 位" autocomplete="new-password">
      <button class="btn" id="setPwBtn">设置</button>
    </div>
    <p id="pwInfo" style="font-size:11.5px;color:var(--text-4);margin-top:6px"></p>

    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="pSave" style="flex:1">保存资料</button>
      <button class="btn" id="doLogout">退出登录</button>
    </div></div>`;

  const draft = DRAFT;
  const preview = () => { const el = box.querySelector('#avatarPreview'); if (el) el.innerHTML = avatarHtml(draft, 56); };
  box.querySelector('#uploadBtn').onclick = () => box.querySelector('#fileIn').click();
  box.querySelector('#fileIn').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) openAvatarEditor(f, (dataUrl) => { DRAFT = { ...(DRAFT || profile()), img: dataUrl }; saveProfile(DRAFT); refreshAuthButton(); refreshOwnPosts(DRAFT).catch(() => {}); toast('头像已保存'); });
  };
  box.querySelector('#clearImg').onclick = () => { draft.img = ''; preview(); };
  box.querySelector('#pAvatars').onclick = (e) => {
    const b = e.target.closest('[data-av]');
    if (!b) return;
    draft.avatar = b.dataset.av; draft.img = '';
    box.querySelectorAll('#pAvatars .pick').forEach((x) => x.classList.toggle('on', x.dataset.av === draft.avatar));
    preview();
  };
  box.querySelector('#pColors').onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    draft.color = b.dataset.c;
    box.querySelectorAll('#pColors .pick-dot').forEach((x) => x.classList.toggle('on', x.dataset.c === draft.color));
    preview();
  };
  box.querySelector('#pSave').onclick = () => {
    draft.name = (box.querySelector('#pName').value || '').trim().slice(0, 16) || email.split('@')[0];
    saveProfile(draft);
    apiUpsertProfile(draft).catch(() => {});
    refreshOwnPosts(draft).catch(() => {});
    DRAFT = null;
    m.hidden = true;
    refreshAuthButton();
    toast('资料已保存');
  };
  const setPwBtn = box.querySelector('#setPwBtn');
  if (setPwBtn) setPwBtn.onclick = async () => {
    const pw = box.querySelector('#newPw').value;
    const info = box.querySelector('#pwInfo');
    if (!pw || pw.length < 6) return (info.textContent = '密码至少 6 位');
    info.textContent = '设置中…';
    try { await setPassword(pw); info.textContent = '✓ 密码已设置，可在其他设备用邮箱+密码登录'; box.querySelector('#newPw').value = ''; }
    catch (e) { info.textContent = '失败：' + e.message; }
  };

  box.querySelector('#doLogout').onclick = () => { DRAFT = null; logout(); m.hidden = true; location.reload(); };
}

export function refreshAuthButton() {
  const btn = document.getElementById('authBtn');
  if (!btn) return;
  const email = currentEmail();
  if (!email) { btn.innerHTML = '登录'; btn.title = '登录'; return; }
  const p = profile();
  btn.innerHTML = avatarHtml(p, 30);
  btn.title = p.name || email;
  btn.style.cssText += ';padding:0;border:0;background:transparent;';
}

/* ---------- 发帖 ---------- */
export async function openComposer(game) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  if (!currentEmail()) return openLogin();
  m.hidden = false;
  const p = profile();
  box.innerHTML = `<div class="m-body">
    <h3>发帖</h3>
    <div class="profile-head" style="margin-bottom:12px">${avatarHtml(p, 40)}
      <div><div class="profile-name">${esc(p.name || '我')}</div>
      <div class="profile-mail">${game ? esc(game.name) : '自由分享'}</div></div></div>
    <input class="input" id="postTitle" maxlength="40" placeholder="标题（一句话说明你想聊什么）">
    ${game ? '' : '<div style="position:relative;margin-top:8px"><input class="input" id="postGame" placeholder="关联游戏（输入名字搜索）" autocomplete="off"><div id="gameSug" class="sugbox hidden"></div></div><div id="gamePicked" class="pickedwrap"></div>'}
    <textarea class="input" id="postBody" rows="5" placeholder="正文：说说这游戏怎么样？值得入吗？" style="margin-top:8px"></textarea>
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
      <button class="btn" id="pickImgs">＋ 图片（最多 9 张）</button>
      <span id="imgCount" style="font-size:12px;color:var(--text-4)">0/9</span>
      <input type="file" id="imgIn" accept="image/*" multiple class="hidden">
    </div>
    <div id="imgPreview" class="imgprev"></div>
    <button class="btn btn-primary btn-block" id="doPost" style="margin-top:10px">发布</button>
    <p id="postMsg" style="font-size:12px;color:var(--text-4);margin-top:8px"></p></div>`;

  const msg = box.querySelector('#postMsg');
  let picked = game ? { id: game.id, name: game.name } : null;
  let images = [];

  const gi = box.querySelector('#postGame');
  const sug = box.querySelector('#gameSug');
  const pickedBox = box.querySelector('#gamePicked');
  const renderPicked = () => {
    if (!pickedBox) return;
    pickedBox.innerHTML = picked ? '<span class="picked">已关联：' + esc(picked.name) + ' <b data-clear="1">×</b></span>' : '';
    const clr = pickedBox.querySelector('[data-clear]');
    if (clr) clr.onclick = () => { picked = null; renderPicked(); };
  };
  renderPicked();

  if (gi) {
    let timer = null;
    gi.oninput = () => {
      const q = gi.value.trim();
      clearTimeout(timer);
      if (!q) { sug.classList.add('hidden'); return; }
      timer = setTimeout(async () => {
        try {
          const res = await fetch(new URL('api/search?q=' + encodeURIComponent(q), document.baseURI).href);
          const data = await res.json();
          const items = (data.items || []).slice(0, 6);
          sug.innerHTML = items.length
            ? items.map((g) => '<div data-gid="' + g.id + '" data-gname="' + esc(g.name) + '">' + esc(g.name) + '<small>' + (g.year || '') + '</small></div>').join('')
            : '<div class="sug-empty">没找到</div>';
          sug.classList.remove('hidden');
        } catch { sug.classList.add('hidden'); }
      }, 180);
    };
    sug.onclick = (e) => {
      const d = e.target.closest('[data-gid]');
      if (!d) return;
      picked = { id: Number(d.dataset.gid), name: d.dataset.gname };
      gi.value = '';
      sug.classList.add('hidden');
      renderPicked();
    };
  }

  const renderImgs = () => {
    box.querySelector('#imgCount').textContent = images.length + '/9';
    box.querySelector('#imgPreview').innerHTML = images
      .map((src, i) => `<span class="thumb"><img src="${src}"><b data-rm="${i}">×</b></span>`)
      .join('');
    box.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => { images.splice(Number(b.dataset.rm), 1); renderImgs(); };
    });
  };
  box.querySelector('#pickImgs').onclick = () => box.querySelector('#imgIn').click();
  box.querySelector('#imgIn').onchange = async (e) => {
    const files = [...(e.target.files || [])].slice(0, 9 - images.length);
    for (const f of files) {
      try { images.push(await compressImage(f)); } catch {}
    }
    renderImgs();
    e.target.value = '';
  };

  box.querySelector('#doPost').onclick = async () => {
    const body = box.querySelector('#postBody').value.trim();
    const title = (box.querySelector('#postTitle').value || '').trim().slice(0, 40);
    if (!title) return (msg.textContent = '给帖子起个标题吧');
    if (!body) return (msg.textContent = '写点正文吧');
    msg.textContent = '发布中…';
    try {
      await rest('/rest/v1/posts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          title, game_id: picked ? picked.id : 0, game_name: picked ? picked.name : '闲聊', body,
          images, author_name: p.name, author_id: p.id, author_avatar: p.img || p.avatar, author_email: currentEmail(),
        }],
      });
      m.hidden = true;
      toast('已发布');
      if (window.LH_COMMUNITY_REFRESH) window.LH_COMMUNITY_REFRESH();
    } catch (e) {
      msg.textContent = '发布失败：' + e.message;
    }
  };
}

/* ---------- 作者主页 ---------- */
export async function openAuthor(name, uid) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  box.innerHTML = `<div class="m-body"><h3>${esc(name)}</h3><p style="color:var(--text-4);font-size:12px">读取中…</p></div>`;
  try {
    const filter = uid ? `author_id=eq.${uid}` : `author_name=eq.${encodeURIComponent(name)}`;
    const rows = await rest(`/rest/v1/posts?select=id,title,game_name,body,author_avatar,author_id,created_at&` + filter + `&order=created_at.desc&limit=20`);
    const av = rows[0]?.author_avatar || '🎮';
    box.innerHTML = `<div class="m-body">
      <div class="profile-head">${avatarHtml({ avatar: av.startsWith('data:') ? '🎮' : av, img: av.startsWith('data:') ? av : '' }, 56)}
        <div><div class="profile-name">${esc(name)}<span class="post-uid">#${uid || (rows[0] && rows[0].author_id) || '----'}</span></div>
        <div class="profile-mail">${rows.length} 篇帖子</div></div></div>
      ${rows.map((x) => `<div class="author-post"><b>${esc(x.title || '无标题')}</b>
        <div class="post-meta">${esc(x.game_name)} · ${timeAgo(x.created_at)}</div>
        <p class="post-body" style="margin:6px 0 0">${esc(x.body)}</p></div>`).join('')}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="m-body"><h3>${esc(name)}</h3><p style="color:var(--text-3)">读取失败：${esc(e.message)}</p></div>`;
  }
}

function toast(t) { if (window.LH_TOAST) return window.LH_TOAST(t); }

/* ---------- 社区 ---------- */
const PAGE_KEY = 'lh.pageSize';
function pageSize() { return Number(localStorage.getItem(PAGE_KEY) || 10); }
let PAGE = 0;
let VIEW = 'list';
let CUR = null;

export async function renderCommunity(root) {
  if (!isConfigured()) {
    root.innerHTML = `<div class="empty-state"><span class="big">🧩</span>社区还没接后端。</div>`;
    return;
  }
  if (VIEW === 'detail' && CUR) return renderDetail(root);
  await renderList(root);
}

async function renderList(root) {
  const size = pageSize();
  const loginHint = window.__LH_LOGIN_URL
    ? '<div class="login-sync"><span>✓ 已登录。想在电脑上也登录？</span><button class="btn btn-sm" id="copyLoginUrl">复制登录链接</button><b data-hide-hint="1">×</b></div>'
    : '';

  root.innerHTML = loginHint + `<div class="cmt-bar">
      <button class="btn btn-primary" id="newPost">＋ 发帖</button>
      <button class="btn" id="myProfile">我的资料</button>
      <span class="cmt-hint">点帖子进入详情，可看图与评论</span>
      <span class="page-set">每页
        <select id="pageSizeSel" class="input sm" style="width:auto;display:inline-block">
          ${[10, 20, 30, 50].map((n) => `<option value="${n}" ${n === size ? 'selected' : ''}>${n}</option>`).join('')}
        </select> 条
      </span>
    </div><div id="postList"><div class="empty-state"><span class="spin"></span></div></div>
    <div class="pager"><button class="btn btn-sm" id="prevPage">上一页</button><span id="pageInfo"></span><button class="btn btn-sm" id="nextPage">下一页</button></div>`;

  const cp = root.querySelector('#copyLoginUrl');
  if (cp) {
    cp.onclick = async () => {
      try {
        await navigator.clipboard.writeText(window.__LH_LOGIN_URL);
        cp.textContent = '已复制';
      } catch {
        prompt('手动复制这个链接到电脑打开：', window.__LH_LOGIN_URL);
      }
    };
  }
  const hideHint = root.querySelector('[data-hide-hint]');
  if (hideHint) hideHint.onclick = () => { const el = hideHint.parentElement; if (el) el.remove(); };

  root.querySelector('#newPost').onclick = () => (currentEmail() ? openComposer(null) : openLogin());
  root.querySelector('#myProfile').onclick = () => openLogin();
  root.querySelector('#pageSizeSel').onchange = (e) => {
    localStorage.setItem(PAGE_KEY, e.target.value);
    PAGE = 0;
    renderList(root);
  };

  const list = root.querySelector('#postList');
  let posts = [];
  try {
    posts = await rest(`/rest/v1/posts?select=id,title,game_id,game_name,body,images,author_name,author_id,author_avatar,author_email,created_at&order=created_at.desc&limit=${size}&offset=${PAGE * size}`) || [];
  } catch (e) {
    const msg = String(e.message || e);
    if (/JWT|expired|401/i.test(msg)) {
      try { localStorage.removeItem('lh.auth'); } catch {}
      list.innerHTML = '<div class="empty-state">登录已过期<br><span style="font-size:12px;color:var(--text-4)">重新登录后即可恢复</span><br><br>' +
        '<button class="btn btn-primary" id="relogin">重新登录</button></div>';
      const b = list.querySelector('#relogin');
      if (b) b.onclick = () => openLogin();
      return;
    }
    list.innerHTML = '<div class="empty-state">读取失败：' + esc(msg) + '</div>';
    return;
  }

  const email = currentEmail();
  if (email && !window.__uidBackfilled) {
    const p = profile();
    const need = posts.filter((x) => ((x.author_email === email) || (!x.author_email && x.author_name === p.name)) && (!x.author_id || Number(x.author_id) !== p.id));
    if (need.length) {
      window.__uidBackfilled = true;
      await Promise.all(need.map((x) => rest('/rest/v1/posts?id=eq.' + x.id, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { author_id: p.id, author_name: p.name, author_email: email, author_avatar: p.img || p.avatar } }).catch(() => {})));
      return renderList(root);
    }
  }

  const pager = root.querySelector('.pager');
  const showPager = posts.length === size || PAGE > 0;
  if (pager) pager.style.display = showPager ? 'flex' : 'none';
  root.querySelector('#pageInfo').textContent = '第 ' + (PAGE + 1) + ' 页';
  root.querySelector('#prevPage').disabled = PAGE === 0;
  root.querySelector('#prevPage').onclick = () => { if (PAGE > 0) { PAGE -= 1; renderList(root); } };
  root.querySelector('#nextPage').disabled = posts.length < size;
  root.querySelector('#nextPage').onclick = () => { if (posts.length === size) { PAGE += 1; renderList(root); } };

  if (!posts.length) {
    list.innerHTML = `<div class="empty-state"><span class="big">🌱</span>${PAGE === 0 ? '还没有人发帖。点「＋ 发帖」写第一条' : '这一页没有内容了'}</div>`;
    return;
  }

  const ids = posts.map((x) => x.id).join(',');
  const likes = await rest(`/rest/v1/post_likes?select=post_id,user_email&post_id=in.(${ids})`).catch(() => []);
  const likeCount = new Map();
  const mine = new Set();
  for (const l of likes || []) {
    likeCount.set(l.post_id, (likeCount.get(l.post_id) || 0) + 1);
    if (email && l.user_email === email) mine.add(l.post_id);
  }

  list.innerHTML = posts.map((x) => {
    const av = avatarOf(x);
    const n = likeCount.get(x.id) || 0;
    const liked = mine.has(x.id);
    const imgs = Array.isArray(x.images) ? x.images : [];
    return `<article class="post post-clickable" data-open="${x.id}">
      <header>${avatarHtml(av, 26)}
        ${x.game_id ? `<a class="post-game" href="?info=${x.game_id}" data-noclick="1">${esc(x.game_name)}</a>` : `<span class="post-game plain">${esc(x.game_name)}</span>`}
        <span class="post-meta">${esc(x.author_name)} · ${timeAgo(x.created_at)}</span>
      </header>
      ${x.title ? `<h4 class="post-title">${esc(x.title)}</h4>` : ''}
      <p class="post-body">${esc(x.body).slice(0, 160)}${x.body.length > 160 ? '…' : ''}</p>
      ${imgs.length ? `<div class="imgs">${imgs.slice(0, 4).map((src) => `<img src="${src}">`).join('')}${imgs.length > 4 ? `<span class="more-img">+${imgs.length - 4}</span>` : ''}</div>` : ''}
      <div class="post-foot">
        <button class="like ${liked ? 'on' : ''}" data-like="${x.id}">${liked ? '♥' : '♡'} ${n || ''}</button>
        <span class="cmt-n">评论</span>
      </div>
    </article>`;
  }).join('');

  list.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('[data-noclick]')) return;
      if (ev.target.closest('[data-like]')) return;
      const id = Number(el.dataset.open);
      CUR = posts.find((p) => p.id === id);
      VIEW = 'detail';
      renderCommunity(root);
    };
  });

  list.querySelectorAll('[data-like]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!currentEmail()) return openLogin();
      const id = Number(btn.dataset.like);
      const wasOn = btn.classList.contains('on');
      const cur = Number((btn.textContent.match(/\d+/) || [0])[0]) || 0;
      const next = wasOn ? Math.max(0, cur - 1) : cur + 1;
      btn.classList.toggle('on', !wasOn);
      btn.innerHTML = (wasOn ? '♡' : '♥') + (next ? ' ' + next : '');
      try {
        if (wasOn) await rest(`/rest/v1/post_likes?post_id=eq.${id}&user_email=eq.${encodeURIComponent(currentEmail())}`, { method: 'DELETE' });
        else await rest('/rest/v1/post_likes', { method: 'POST', body: [{ post_id: id, user_email: currentEmail() }] });
      } catch (e) {
        btn.classList.toggle('on', wasOn);
        btn.innerHTML = (wasOn ? '♥' : '♡') + (cur ? ' ' + cur : '');
        toast('操作失败：' + e.message);
      }
    };
  });
}

function avatarOf(x) {
  const a = x.author_avatar || '';
  return a.startsWith('data:') ? { avatar: '🎮', img: a } : { avatar: a || '🎮', img: '' };
}

async function renderDetail(root) {
  const x = CUR;
  if (!x) { VIEW = 'list'; return renderList(root); }
  const av = avatarOf(x);
  const imgs = Array.isArray(x.images) ? x.images : [];
  root.innerHTML = `<div class="cmt-bar">
      <button class="btn" id="backBtn">← 返回社区</button>
      <span style="flex:1"></span>
      <button class="btn btn-sm" id="delPost" style="display:none">删除帖子</button>
    </div>
    <article class="post">
      <header>${avatarHtml(av, 34)}
        <a class="post-author" data-author="${esc(x.author_name)}" data-aid="${x.author_id || ''}">${esc(x.author_name)}<span class="post-uid">#${x.author_id || '----'}</span></a>
        ${x.game_id ? `<a class="post-game" href="?info=${x.game_id}">${esc(x.game_name)}</a>` : `<span class="post-game plain">${esc(x.game_name)}</span>`}
        <span class="post-meta">${timeAgo(x.created_at)}</span>
      </header>
      ${x.title ? `<h4 class="post-title" style="font-size:18px">${esc(x.title)}</h4>` : ''}
      <p class="post-body" style="font-size:14px">${esc(x.body)}</p>
      ${imgs.length ? `<div class="detail-imgs">${imgs.map((s) => `<img src="${s}" loading="lazy">`).join('')}</div>` : ''}
      <div class="post-foot"><span class="cmt-n">加载评论中…</span><span id="likeSlot"></span></div>
      <div id="cmtList" class="post-comments"></div>
      <div class="cmt-add">
        <input class="input sm" id="cmtInput" placeholder="评论两句…">
        <button class="btn btn-sm" id="cmtSend">发送</button>
      </div>
    </article>`;

  root.querySelector('#backBtn').onclick = () => { VIEW = 'list'; CUR = null; renderCommunity(root); };

  const delBtn = root.querySelector('#delPost');
  const emailNow = currentEmail();
  const canDel = emailNow && (x.author_email === emailNow || (!x.author_email && x.author_name === profile().name));
  if (delBtn && canDel) {
    delBtn.style.display = '';
    delBtn.onclick = async () => {
      if (!confirm('删除这条帖子？')) return;
      delBtn.disabled = true;
      try {
        await rest('/rest/v1/posts?id=eq.' + x.id, { method: 'DELETE' });
        toast('已删除');
        VIEW = 'list';
        CUR = null;
        renderCommunity(root);
      } catch (e) {
        toast('删除失败：' + e.message);
        delBtn.disabled = false;
      }
    };
  }
  root.querySelector('[data-author]').onclick = () => openAuthor(x.author_name, x.author_id);

  // 点赞
  try {
    const ls = await rest(`/rest/v1/post_likes?select=user_email&post_id=eq.${x.id}`) || [];
    const email = currentEmail();
    const liked = email && ls.some((l) => l.user_email === email);
    root.querySelector('#likeSlot').innerHTML = `<button class="like ${liked ? 'on' : ''}" id="detailLike">${liked ? '♥' : '♡'} ${ls.length || ''}</button>`;
    root.querySelector('#detailLike').onclick = async (ev) => {
      if (!email) return openLogin();
      const btn = ev.currentTarget;
      btn.disabled = true;
      const next = liked ? Math.max(0, ls.length - 1) : ls.length + 1;
      btn.classList.toggle('on', !liked);
      btn.innerHTML = (liked ? '♡' : '♥') + (next ? ' ' + next : '');
      try {
        if (liked) await rest(`/rest/v1/post_likes?post_id=eq.${x.id}&user_email=eq.${encodeURIComponent(email)}`, { method: 'DELETE' });
        else await rest('/rest/v1/post_likes', { method: 'POST', body: [{ post_id: x.id, user_email: email }] });
      } catch (e) {
        btn.classList.toggle('on', liked);
        btn.innerHTML = (liked ? '♥' : '♡') + (ls.length ? ' ' + ls.length : '');
        toast('失败');
      }
    };
  } catch {}

  // 评论
  const cmtList = root.querySelector('#cmtList');
  try {
    const cs = await rest(`/rest/v1/comments?select=id,body,author_name,author_email,created_at&post_id=eq.${x.id}&order=created_at.asc`) || [];
    cmtList.innerHTML = cs.map((c) => {
      const canDel = currentEmail() && c.author_email === currentEmail();
      return `<div class="cmt">
        <b>${esc(c.author_name)}</b> ${esc(c.body)}
        <span class="cmt-time">${timeAgo(c.created_at)}</span>
        ${canDel ? `<button class="cmt-del" data-delc="${c.id}">删除</button>` : ''}
      </div>`;
    }).join('') || '<div class="cmt" style="color:var(--text-4)">还没有评论</div>';
    cmtList.querySelectorAll('[data-delc]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('删除这条评论？')) return;
        try { await rest(`/rest/v1/comments?id=eq.${b.dataset.delc}`, { method: 'DELETE' }); renderDetail(root); }
        catch (e) { toast('删除失败：' + e.message); }
      };
    });
    root.querySelector('#cmtSend').onclick = async () => {
      if (!currentEmail()) return openLogin();
      const v = root.querySelector('#cmtInput').value.trim();
      if (!v) return;
      try {
        await rest('/rest/v1/comments', { method: 'POST', body: [{ post_id: x.id, body: v, author_name: profile().name, author_email: currentEmail() }] });
        renderDetail(root);
      } catch (e) { toast('评论失败'); }
    };
  } catch (e) {
    cmtList.innerHTML = `<div class="cmt">评论读取失败：${esc(e.message)}</div>`;
  }
}
