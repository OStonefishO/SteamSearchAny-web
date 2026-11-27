// 社区/账号 v2：头像上传+缩放、作者主页、删帖子
import { isConfigured, sendCode, verifyCode, logout, currentEmail, session, captureHashSession, fillEmailFromUser } from './supabase-lite.js';

try {
  const claimed = captureHashSession();
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

/* ---------- 资料（本地保存，随帖子上传快照） ---------- */
const PK = 'lh.profile';
export function profile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PK) || '{}'); } catch {}
  const email = currentEmail() || '';
  let id = p.id;
  // 支持用 ?uid=xxxx 认领一个固定 ID
  try {
    const q = new URLSearchParams(location.search).get('uid');
    if (!id && q && /^[0-9]{10}$/.test(q)) {
      id = Number(q);
      p.id = id;
      localStorage.setItem(PK, JSON.stringify(p));
      history.replaceState(null, '', location.pathname);
    }
  } catch {}
  if (!id) {
    id = 1000000000 + Math.floor(Math.random() * 9000000000);
    try { p.id = id; localStorage.setItem(PK, JSON.stringify(p)); } catch {}
  }
  return { id, name: p.name || (email ? email.split('@')[0] : ''), avatar: p.avatar || '🎮', img: p.img || '', color: p.color || '#45bdf7' };
}
function saveProfile(p) { try { localStorage.setItem(PK, JSON.stringify(p)); } catch {} }

let DRAFT = null;   // 账号面板的临时编辑状态，跨弹窗保留

const AVATARS = ['🎮', '🕹️', '👾', '🚀', '🌌', '🐱', '🦊', '🐳', '🌙', '⭐', '🔥', '🎧'];
const COLORS = ['#45bdf7', '#b6e04a', '#ffb04d', '#f4736f', '#a78bfa', '#34d399', '#f472b6'];

function avatarHtml(p, size = 40) {
  const base = `width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;display:grid;place-items:center;overflow:hidden;border:1px solid ${p.color}55;background:${p.color}1f;`;
  if (p.img) return `<span style="${base}"><img src="${p.img}" style="width:100%;height:100%;object-fit:cover"></span>`;
  return `<span style="${base}font-size:${Math.round(size * 0.5)}px">${esc(p.avatar)}</span>`;
}

/* ---------- REST ---------- */
async function rest(path, opts = {}) {
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
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

/* ---------- 远端资料（跨设备同一 UID） ---------- */
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

/** 登录后同步：远端有就用远端，没有就把本地（或新生成）写上去 */
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

/* ---------- 把自己的历史帖子统一成最新资料 ---------- */
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

/* ---------- 头像上传（居中裁剪 + 缩放） ---------- */
function openAvatarEditor(file, onDone) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  const reader = new FileReader();
  reader.onload = () => {
    const src = String(reader.result);
    m.hidden = false;
    box.innerHTML = `<div class="m-body">
      <h3>调整头像</h3>
      <div class="crop-wrap"><canvas id="cropCv" width="260" height="260"></canvas></div>
      <label class="field-label">缩放</label>
      <input type="range" id="zoom" min="100" max="260" value="140" style="width:100%">
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-primary" id="cropOk" style="flex:1">用这张</button>
        <button class="btn" id="cropCancel">取消</button>
      </div>
    </div>`;
    const cv = box.querySelector('#cropCv');
    const ctx = cv.getContext('2d');
    const im = new Image();
    im.onload = () => {
      const draw = (zoom) => {
        const scale = zoom / 100;
        const side = Math.min(im.width, im.height) / scale;
        const sx = (im.width - side) / 2;
        const sy = (im.height - side) / 2;
        ctx.clearRect(0, 0, 260, 260);
        ctx.drawImage(im, sx, sy, side, side, 0, 0, 260, 260);
      };
      draw(140);
      box.querySelector('#zoom').oninput = (e) => draw(Number(e.target.value));
      box.querySelector('#cropOk').onclick = () => {
        const out = document.createElement('canvas');
        out.width = 96;
        out.height = 96;
        out.getContext('2d').drawImage(cv, 0, 0, 96, 96);
        onDone(out.toDataURL('image/jpeg', 0.82));
        m.hidden = true;
        openLogin();
      };
      box.querySelector('#cropCancel').onclick = () => (m.hidden = true);
    };
    im.src = src;
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
    box.innerHTML = `<div class="m-body"><h3>还没有接后端</h3><p style="color:var(--text-3);font-size:13px;margin-top:8px">填好 public/config.js 即可启用。</p></div>`;
    return;
  }

  if (!email) {
    box.innerHTML = `<div class="m-body"><h3>邮箱登录</h3>
      <p style="color:var(--text-3);font-size:13px;margin:8px 0 14px">输入邮箱，会收到一封带登录链接的邮件。</p>
      <input class="input" id="authEmail" type="email" placeholder="you@example.com">
      <button class="btn btn-primary btn-block" id="sendCode" style="margin-top:10px">发送邮件</button>
      <div id="codeBox" class="hidden" style="margin-top:14px">
        <input class="input" id="authCode" inputmode="numeric" placeholder="6 位验证码（可选）" maxlength="8">
        <button class="btn btn-block" id="doVerify" style="margin-top:10px">用验证码登录</button>
      </div>
      <p id="authMsg" style="font-size:12px;color:var(--text-4);margin-top:10px"></p></div>`;
    const msg = box.querySelector('#authMsg');
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
      msg.textContent = '验证中…';
      try { await verifyCode(box.querySelector('#authEmail').value.trim(), code); m.hidden = true; location.reload(); }
      catch (e) { msg.textContent = '失败：' + e.message; }
    };
    return;
  }

  DRAFT = DRAFT || { ...profile() };
  const p = DRAFT;
  if (!window.__profileSynced) {
    window.__profileSynced = true;
    syncProfile().then(() => { DRAFT = null; refreshAuthButton(); }).catch(() => {});
  }
  box.innerHTML = `<div class="m-body">
    <h3>我的账号</h3>
    <div class="profile-head">
      <span id="avatarPreview">${avatarHtml(p, 56)}</span>
      <div>
        <div class="profile-name">${esc(p.name)}</div>
        <div class="profile-mail">${esc(email)} · UID #${p.id}</div>
      </div>
    </div>

    <label class="field-label">昵称</label>
    <input class="input" id="pName" maxlength="16" value="${esc(p.name)}">

    <label class="field-label">上传头像（可缩放）</label>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn" id="uploadBtn">选择图片</button>
      <button class="btn" id="clearImg">用 emoji</button>
      <input type="file" id="fileIn" accept="image/*" class="hidden">
    </div>

    <label class="field-label">或选一个 emoji</label>
    <div class="picker" id="pAvatars">
      ${AVATARS.map((a) => `<button class="pick ${a === p.avatar && !p.img ? 'on' : ''}" data-av="${a}">${a}</button>`).join('')}
    </div>

    <label class="field-label">主题色</label>
    <div class="picker" id="pColors">
      ${COLORS.map((c) => `<button class="pick-dot ${c === p.color ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}
    </div>

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
    draft.avatar = b.dataset.av;
    draft.img = '';
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
    if (window.LH_COMMUNITY_REFRESH) window.LH_COMMUNITY_REFRESH();
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
    <div class="profile-head" style="margin-bottom:12px">
      ${avatarHtml(p, 40)}
      <div><div class="profile-name">${esc(p.name || '我')}</div>
      <div class="profile-mail">${game ? esc(game.name) : '自由分享'}</div></div>
    </div>
    <input class="input" id="postTitle" maxlength="40" placeholder="标题（一句话说明你想聊什么）">
    ${game ? '' : '<input class="input" id="postGame" placeholder="关联的游戏名（可留空）" style="margin-top:8px">'}
    <textarea class="input" id="postBody" rows="5" placeholder="正文：说说这游戏怎么样？值得入吗？" style="margin-top:8px"></textarea>
    <button class="btn btn-primary btn-block" id="doPost" style="margin-top:10px">发布</button>
    <p id="postMsg" style="font-size:12px;color:var(--text-4);margin-top:8px"></p></div>`;
  const msg = box.querySelector('#postMsg');
  box.querySelector('#doPost').onclick = async () => {
    const body = box.querySelector('#postBody').value.trim();
    const title = (box.querySelector('#postTitle').value || '').trim().slice(0, 40);
    if (!title) return (msg.textContent = '给帖子起个标题吧');
    if (!body) return (msg.textContent = '写点正文吧');
    const gname = game ? game.name : (box.querySelector('#postGame').value.trim() || '闲聊');
    msg.textContent = '发布中…';
    try {
      await rest('/rest/v1/posts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          title, game_id: game ? game.id : 0, game_name: gname, body,
          author_name: p.name, author_id: p.id, author_avatar: p.img || p.avatar, author_email: currentEmail(),
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

/* ---------- 某位用户的资料页 ---------- */
export async function openAuthor(name, uid) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  box.innerHTML = `<div class="m-body"><h3>${esc(name)}</h3><p style="color:var(--text-4);font-size:12px">读取中…</p></div>`;
  try {
    const filter = uid ? `author_id=eq.${uid}` : `author_name=eq.${encodeURIComponent(name)}`;
    const rows = await rest(`/rest/v1/posts?select=id,title,game_name,body,author_avatar,author_id,created_at&` + filter + `&order=created_at.desc&limit=20`);
    const p0 = { name, avatar: rows[0]?.author_avatar || '🎮', img: (rows[0]?.author_avatar || '').startsWith('data:') ? rows[0].author_avatar : '', color: '#45bdf7' };
    box.innerHTML = `<div class="m-body">
      <div class="profile-head">${avatarHtml(p0, 56)}
        <div><div class="profile-name">${esc(name)}<span class="post-uid">#${uid || (rows[0] && rows[0].author_id) || '----'}</span></div>
        <div class="profile-mail">${rows.length} 篇帖子</div></div>
      </div>
      ${rows.map((x) => `<div class="author-post"><b>${esc(x.title || '无标题')}</b>
        <div class="post-meta">${esc(x.game_name)} · ${timeAgo(x.created_at)}</div>
        <p class="post-body" style="margin:6px 0 0">${esc(x.body)}</p></div>`).join('')}
    </div>`;
  } catch (e) {
    box.innerHTML = `<div class="m-body"><h3>${esc(name)}</h3><p style="color:var(--text-3)">读取失败：${esc(e.message)}</p></div>`;
  }
}

function toast(t) { if (window.LH_TOAST) return window.LH_TOAST(t); }

/* ---------- 社区列表 ---------- */
export async function renderCommunity(root) {
  if (!isConfigured()) {
    root.innerHTML = `<div class="empty-state"><span class="big">🧩</span>社区还没接后端。</div>`;
    return;
  }
  const me = profile();
  root.innerHTML = `<div class="cmt-bar">
      <button class="btn btn-primary" id="newPost">＋ 发帖</button>
      <button class="btn" id="myProfile">我的资料</button>
      <span class="cmt-hint">${currentEmail() ? '点作者名字可看他的主页' : '登录后可发帖、评论、删自己的帖'}</span>
    </div><div id="postList"><div class="empty-state"><span class="spin"></span></div></div>`;
  root.querySelector('#newPost').onclick = () => (currentEmail() ? openComposer(null) : openLogin());
  root.querySelector('#myProfile').onclick = () => openLogin();

  const list = root.querySelector('#postList');
  let posts = [];
  try {
    posts = await rest('/rest/v1/posts?select=id,title,game_id,game_name,body,author_name,author_id,author_avatar,author_email,created_at&order=created_at.desc&limit=30') || [];
  } catch (e) {
    list.innerHTML = `<div class="empty-state">读取失败：${esc(e.message)}</div>`;
    return;
  }
  // 自愈：把属于自己但缺 author_id 的老帖补齐（只跑一次）
  const email = currentEmail();
  if (email && !window.__uidBackfilled) {
    const p = profile();
    const need = posts.filter((x) => x.author_email === email && (!x.author_id || Number(x.author_id) !== p.id));
    if (need.length) {
      window.__uidBackfilled = true;
      await Promise.all(
        need.map((x) =>
          rest('/rest/v1/posts?id=eq.' + x.id, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: { author_id: p.id, author_name: p.name, author_avatar: p.img || p.avatar },
          }).catch(() => {})
        )
      );
      return renderCommunity(root);
    }
  }

  if (!posts.length) {
    list.innerHTML = `<div class="empty-state"><span class="big">🌱</span>还没有人发帖。<br><span style="font-size:12px;color:var(--text-4)">点「＋ 发帖」写第一条</span></div>`;
    return;
  }

  const cRows = await rest(`/rest/v1/comments?select=id,post_id,body,author_name,created_at&post_id=in.(${posts.map((x) => x.id).join(',')})&order=created_at.asc`).catch(() => []);
  const byPost = new Map();
  for (const c of cRows || []) {
    if (!byPost.has(c.post_id)) byPost.set(c.post_id, []);
    byPost.get(c.post_id).push(c);
  }

  list.innerHTML = posts.map((x) => {
    const mine = currentEmail() && (x.author_email === currentEmail() || (!x.author_email && x.author_name === profile().name));
    const av = { name: x.author_name, avatar: (x.author_avatar || '').startsWith('data:') ? '' : (x.author_avatar || '🎮'), img: (x.author_avatar || '').startsWith('data:') ? x.author_avatar : '', color: '#45bdf7' };
    const cs = byPost.get(x.id) || [];
    return `<article class="post">
      <header>
        ${avatarHtml(av, 26)}
        <a class="post-author" data-author="${esc(x.author_name)}" data-aid="${x.author_id || ''}">${esc(x.author_name)}<span class="post-uid">#${x.author_id || '----'}</span></a>
        ${x.game_id ? `<a class="post-game" href="?info=${x.game_id}">${esc(x.game_name)}</a>` : `<span class="post-game">${esc(x.game_name)}</span>`}
        <span class="post-meta">${timeAgo(x.created_at)}</span>
        ${mine ? `<button class="post-del" data-del="${x.id}">删除</button>` : ''}
      </header>
      ${x.title ? `<h4 class="post-title">${esc(x.title)}</h4>` : ''}
      <p class="post-body">${esc(x.body)}</p>
      <div class="post-comments">
        ${cs.map((c) => `<div class="cmt"><b>${esc(c.author_name)}</b> ${esc(c.body)}</div>`).join('')}
        <div class="cmt-add">
          <input class="input sm" data-cmt-input="${x.id}" placeholder="评论两句…">
          <button class="btn btn-sm" data-cmt-send="${x.id}">发送</button>
        </div>
      </div>
    </article>`;
  }).join('');

  list.querySelectorAll('[data-author]').forEach((a) => { a.onclick = () => openAuthor(a.dataset.author, a.dataset.aid); });
  list.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('删除这条帖子？')) return;
      try {
        await rest(`/rest/v1/posts?id=eq.${b.dataset.del}`, { method: 'DELETE' });
        toast('已删除');
        renderCommunity(root);
      } catch (e) { toast('删除失败：' + e.message); }
    };
  });
  list.querySelectorAll('[data-cmt-send]').forEach((btn) => {
    btn.onclick = async () => {
      if (!currentEmail()) return openLogin();
      const id = Number(btn.dataset.cmtSend);
      const input = list.querySelector(`[data-cmt-input="${id}"]`);
      const body = input.value.trim();
      if (!body) return;
      btn.disabled = true;
      try {
        await rest('/rest/v1/comments', { method: 'POST', body: [{ post_id: id, body, author_name: me.name, author_email: currentEmail() }] });
        renderCommunity(root);
      } catch (e) { toast('评论失败'); btn.disabled = false; }
    };
  });
}
