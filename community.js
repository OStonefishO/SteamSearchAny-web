// 社区 v3：图片(≤9)、帖子详情页、分页(可配置)、点赞、删评论
import { isConfigured, sendCode, verifyCode, logout, currentEmail, session, captureHashSession, fillEmailFromUser, setPassword, signInWithPassword } from './supabase-lite.js?v=2';

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
    body: [{ user_email: email, uid: p.id, name: p.name, avatar: p.img || p.avatar, color: p.color, bio: p.bio || '', updated_at: new Date().toISOString() }],
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
        bio: remote.bio || local.bio || '',
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

    const relayBtn = document.createElement('button');
    relayBtn.className = 'btn btn-block';
    relayBtn.style.marginTop = '16px';
    relayBtn.textContent = '手机已登录？同步到这台电脑';
    relayBtn.onclick = () => openRelayReceive();
    pwPane.parentElement.appendChild(relayBtn);

    const forgot = document.createElement('p');
    forgot.style.cssText = 'font-size:12px;color:var(--text-4);margin-top:10px;cursor:pointer;text-align:right';
    forgot.textContent = '忘记密码？';
    forgot.onclick = () => openRecover();
    pwPane.appendChild(forgot);

    const pwMsg = box.querySelector('#pwMsg');
    box.querySelector('#pwLogin').onclick = async () => {
      const em = box.querySelector('#pwEmail').value.trim();
      const pw = box.querySelector('#pwPass').value;
      if (!em || !pw) { pwMsg.className = 'form-msg form-err'; return (pwMsg.textContent = '✕ 邮箱和密码都要填'); }
      pwMsg.textContent = '登录中…';
      try { await signInWithPassword(em, pw); localStorage.setItem('lh.hasPw', '1'); m.hidden = true; location.reload(); }
      catch (e) { pwMsg.className = 'form-msg form-err'; pwMsg.textContent = '✕ 登录失败：' + e.message; }
    };

    box.querySelector('#sendCode').onclick = async () => {
      const em = box.querySelector('#authEmail').value.trim();
      if (!em) { msg.className = 'form-msg form-err'; return (msg.textContent = '✕ 请填邮箱'); }
      msg.textContent = '发送中…';
      try { await sendCode(em); box.querySelector('#codeBox').classList.remove('hidden'); msg.textContent = '邮件已发送'; }
      catch (e) { msg.className = 'form-msg form-err'; msg.textContent = '✕ 发送失败：' + e.message; }
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
    <label class="field-label">个人简介（别人点进你的主页能看到）</label>
    <textarea class="input" id="pBio" rows="2" maxlength="120" placeholder="一句话介绍自己，留空会显示「这个人懒得写简介」"></textarea>

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
    <div id="pwWarn" class="pw-warn hidden">⚠ 你还没设置登录密码<br><span>不设密码的话，换设备只能用邮件链接登录，很不方便。</span></div>
    <label class="field-label">登录密码（设置后可在任意设备用邮箱+密码登录）</label>
    <div style="display:flex;flex-direction:column;gap:8px">
      <input class="input" id="newPw" type="password" placeholder="设置密码（至少 6 位）" autocomplete="new-password">
      <input class="input" id="newPw2" type="password" placeholder="再输一次确认" autocomplete="new-password">
      <button class="btn" id="setPwBtn" style="align-self:flex-start">设置密码</button>
    </div>
    <p id="pwInfo" style="font-size:11.5px;color:var(--text-4);margin-top:6px"></p>

    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="pSave" style="flex:1">保存资料</button>
      <button class="btn" id="doLogout">退出登录</button>
    </div></div>`;

  const draft = DRAFT;
  const bioEl = box.querySelector('#pBio');
  if (bioEl) bioEl.value = DRAFT.bio || '';
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
    draft.bio = (box.querySelector('#pBio').value || '').trim().slice(0, 120);
    saveProfile(draft);
    apiUpsertProfile(draft).catch(() => {});
    refreshOwnPosts(draft).catch(() => {});
    DRAFT = null;
    m.hidden = true;
    refreshAuthButton();
    toast('资料已保存');
  };
  const pwWarn = box.querySelector('#pwWarn');
  if (pwWarn && !localStorage.getItem('lh.hasPw')) pwWarn.classList.remove('hidden');

  const setPwBtn = box.querySelector('#setPwBtn');
  if (setPwBtn) {
    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn-block';
    sendBtn.style.marginTop = '14px';
    sendBtn.textContent = '把这台设备的登录状态同步到另一台设备';
    sendBtn.onclick = () => openRelaySend();
    setPwBtn.parentElement.insertAdjacentElement('afterend', sendBtn);
  }
  if (setPwBtn) setPwBtn.onclick = async () => {
    const a = box.querySelector('#newPw').value;
    const b = box.querySelector('#newPw2').value;
    const info = box.querySelector('#pwInfo');
    const show = (txt, kind) => { info.className = 'form-msg ' + (kind || ''); info.textContent = txt; };
    if (!a || a.length < 6) return show('✕ 密码至少 6 位', 'form-err');
    if (a !== b) return show('✕ 两次输入的密码不一致，请重新确认', 'form-err');
    show('设置中…', 'form-dim');
    try {
      await setPassword(a);
      localStorage.setItem('lh.hasPw', '1');
      const warnEl = box.querySelector('#pwWarn');
      if (warnEl) warnEl.classList.add('hidden');
      show('✓ 密码已设置，可在任意设备用邮箱+密码登录', 'form-ok');
      box.querySelector('#newPw').value = '';
      box.querySelector('#newPw2').value = '';
    } catch (e) {
      show('✕ 设置失败：' + e.message, 'form-err');
    }
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

    let prof = null;
    try {
      const q = uid ? `uid=eq.${uid}` : `name=eq.${encodeURIComponent(name)}`;
      const ps = await rest('/rest/v1/profiles?select=user_email,uid,name,bio,avatar&' + q + '&limit=1');
      prof = ps && ps[0];
    } catch (e) {}
    const bioText = (prof && prof.bio) ? prof.bio : '这个人懒得写简介';
    const av = (prof && prof.avatar) || (rows[0] && rows[0].author_avatar) || '🎮';
    box.innerHTML = `<div class="m-body">
      <div class="profile-head">${avatarHtml({ avatar: av.startsWith('data:') ? '🎮' : av, img: av.startsWith('data:') ? av : '' }, 56)}
        <div><div class="profile-name">${esc(name)}<span class="post-uid">#${uid || (rows[0] && rows[0].author_id) || '----'}</span></div>
        <div class="profile-mail">${rows.length} 篇帖子</div></div></div>
      <p class="author-bio">${esc(bioText)}</p>
      <div id="friendSlot"></div>
      ${rows.map((x) => `<div class="author-post"><b>${esc(x.title || '无标题')}</b>
        <div class="post-meta">${esc(x.game_name)} · ${timeAgo(x.created_at)}</div>
        <p class="post-body" style="margin:6px 0 0">${esc(x.body)}</p></div>`).join('')}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="m-body"><h3>${esc(name)}</h3><p style="color:var(--text-3)">读取失败：${esc(e.message)}</p></div>`;
    return;
  }

  // 好友按钮
  const slot = box.querySelector('#friendSlot');
  const me = currentEmail();
  const target = prof && prof.user_email;
  if (!slot || !me || !target || target === me) return;
  try {
    const rel = await rest('/rest/v1/friends?select=a_email&a_email=eq.' + encodeURIComponent(me) + '&b_email=eq.' + encodeURIComponent(target));
    const isFriend = rel && rel.length > 0;
    slot.innerHTML = '<button class="btn ' + (isFriend ? '' : 'btn-primary') + '" id="friendBtn">' + (isFriend ? '✓ 已是好友' : '＋ 加为好友') + '</button>';
    const btn = slot.querySelector('#friendBtn');
    if (isFriend) {
      btn.onclick = async () => {
        if (!confirm('解除好友关系？')) return;
        try {
          await rest('/rest/v1/friends?a_email=eq.' + encodeURIComponent(me) + '&b_email=eq.' + encodeURIComponent(target), { method: 'DELETE' });
          await rest('/rest/v1/friends?a_email=eq.' + encodeURIComponent(target) + '&b_email=eq.' + encodeURIComponent(me), { method: 'DELETE' });
          toast('已解除');
          openAuthor(name, uid);
        } catch (e) { toast('失败'); }
      };
    } else {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await sendFriendRequest(target, name);
          toast('已发送好友申请');
          openAuthor(name, uid);
        } catch (e) { toast('失败：' + e.message); btn.disabled = false; }
      };
    }
  } catch (e) {}
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

const REACT = [
  { k: 'like', e: '👍', t: '赞' },
  { k: 'dislike', e: '👎', t: '踩' },
  { k: 'laugh', e: '😂', t: '笑死' },
  { k: 'shock', e: '🤯', t: '震惊' },
  { k: 'cry', e: '😭', t: '感动' },
  { k: 'curious', e: '🤔', t: '想玩' },
  { k: 'mystic', e: '🔮', t: '神秘' },
  { k: 'weird', e: '🃏', t: '搞怪' },
  { k: 'angry', e: '😡', t: '生气' },
  { k: 'speechless', e: '😑', t: '无语' },
  { k: 'drool', e: '🤤', t: '馋了' },
  { k: 'skull', e: '💀', t: '劝退' },
  { k: 'sleep', e: '🥱', t: '无聊' },
  { k: 'love', e: '😍', t: '真爱' },
];

function reactionHtml(postId, counts, mine, big) {
  const cls = big ? 'react-lg' : '';
  const btn = (r, extra) => {
    const n = counts[r.k] || 0;
    const on = mine.has(r.k) ? 'on' : '';
    const ex = extra ? ' react-extra-item' : '';
    return '<button class="react ' + cls + ex + ' ' + on + '" data-react="' + r.k + '" title="' + r.t + '">' +
      '<span class="emo">' + r.e + '</span>' + (n ? '<b>' + n + '</b>' : '') + '</button>';
  };
  const base = REACT.slice(0, 2);
  const rest = REACT.slice(2);
  // 常驻：赞/踩 + 已经有人用过的表情
  const persistent = base.concat(rest.filter((r) => (counts[r.k] || 0) > 0 || mine.has(r.k)));
  // 扩展：还没人用过的表情
  const extras = rest.filter((r) => !((counts[r.k] || 0) > 0 || mine.has(r.k)));

  return '<div class="react-row" data-pid="' + postId + '">' +
    persistent.map((r) => btn(r, false)).join('') +
    extras.map((r) => btn(r, true)).join('') +
    '<button class="react-plus ' + cls + '" data-more="1" title="更多心情">＋</button>' +
    '</div>';
}

function bindReactions(scope, root) {
  scope.querySelectorAll('.react[data-react]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!currentEmail()) return openLogin();
      const wrap = btn.closest('.react-row');
      const postId = Number(wrap.dataset.pid);
      const kind = btn.dataset.react;
      const wasOn = btn.classList.contains('on');
      const cntEl = btn.querySelector('b');
      const cur = cntEl ? Number(cntEl.textContent) || 0 : 0;
      const next = wasOn ? Math.max(0, cur - 1) : cur + 1;

      btn.classList.toggle('on', !wasOn);
      if (cntEl) cntEl.textContent = next || '';
      else if (next) btn.insertAdjacentHTML('beforeend', '<b>' + next + '</b>');
      popEmoji(btn, btn.querySelector('.emo').textContent);

      const wasExtra = btn.classList.contains('react-extra-item');
      try {
        const email = currentEmail();
        if (wasOn) {
          await rest('/rest/v1/post_likes?post_id=eq.' + postId + '&user_email=eq.' + encodeURIComponent(email) + '&kind=eq.' + kind, { method: 'DELETE' });
        } else {
          await rest('/rest/v1/post_likes', { method: 'POST', body: [{ post_id: postId, user_email: email, kind }] });
        }
        // 成功：如果是新用过的表情，留在点踩后面并收起扩展区
        if (wasExtra) {
          btn.classList.remove('react-extra-item');
          const row = btn.closest('.react-row');
          const plus = row.querySelector('[data-more]');
          if (plus) row.insertBefore(btn, plus);
          if (row) {
            row.classList.remove('expanded');
            if (plus) plus.textContent = '＋';
          }
        }
      } catch (e) {
        btn.classList.toggle('on', wasOn);
        if (cntEl) cntEl.textContent = cur || '';
        toast('操作失败：' + e.message);
      }
    };
  });

  scope.querySelectorAll('[data-more]').forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const row = btn.closest('.react-row');
      const open = row.classList.toggle('expanded');
      btn.textContent = open ? '－' : '＋';
    };
  });
  if (!scope.__reactOutsideBound) {
    scope.__reactOutsideBound = true;
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.react-row')) {
        scope.querySelectorAll('.react-pop').forEach((p) => p.classList.add('hidden'));
      }
    });
  }
}

function popEmoji(anchor, emoji) {
  const r = anchor.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = 'float-emoji';
  el.textContent = emoji;
  el.style.left = r.left + r.width / 2 + 'px';
  el.style.top = r.top + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
  anchor.classList.add('pop');
  setTimeout(() => anchor.classList.remove('pop'), 260);
}

async function loadReactions(ids) {
  const rows = await rest('/rest/v1/post_likes?select=post_id,user_email,kind&post_id=in.(' + ids + ')').catch(() => []);
  const counts = new Map();
  const mine = new Map();
  const email = currentEmail();
  for (const r of rows || []) {
    if (!counts.has(r.post_id)) counts.set(r.post_id, {});
    const c = counts.get(r.post_id);
    c[r.kind || 'like'] = (c[r.kind || 'like'] || 0) + 1;
    if (email && r.user_email === email) {
      if (!mine.has(r.post_id)) mine.set(r.post_id, new Set());
      mine.get(r.post_id).add(r.kind || 'like');
    }
  }
  return { counts, mine };
}

async function renderList(root) {
  const size = pageSize();
  root.innerHTML = '<div class="cmt-bar">' +
    '<button class="btn btn-primary" id="newPost">＋ 发帖</button>' +
    '<button class="btn" id="myProfile">我的资料</button>' +
    '<span class="cmt-hint">点帖子进入详情，可看图与评论</span>' +
    '<span class="page-set">每页 <select id="pageSizeSel" class="input sm" style="width:auto;display:inline-block">' +
    [10, 20, 30, 50].map((n) => '<option value="' + n + '"' + (n === size ? ' selected' : '') + '>' + n + '</option>').join('') +
    '</select> 条</span></div>' +
    '<div id="postList"><div class="empty-state"><span class="spin"></span></div></div>' +
    '<div class="pager"><button class="btn btn-sm" id="prevPage">上一页</button><span id="pageInfo"></span><button class="btn btn-sm" id="nextPage">下一页</button></div>';

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
    posts = await rest('/rest/v1/posts?select=id,title,game_id,game_name,body,images,author_name,author_id,author_avatar,author_email,created_at&order=created_at.desc&limit=' + size + '&offset=' + PAGE * size) || [];
  } catch (e) {
    const msg = String(e.message || e);
    if (/JWT|expired|401/i.test(msg)) {
      try { localStorage.removeItem('lh.auth'); } catch {}
      list.innerHTML = '<div class="empty-state">登录已过期<br><span style="font-size:12px;color:var(--text-4)">重新登录后即可恢复</span><br><br><button class="btn btn-primary" id="relogin">重新登录</button></div>';
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
    list.innerHTML = '<div class="empty-state"><span class="big">🌱</span>' + (PAGE === 0 ? '还没有人发帖。点「＋ 发帖」写第一条' : '这一页没有内容了') + '</div>';
    return;
  }

  const { counts, mine } = await loadReactions(posts.map((x) => x.id).join(','));

  const cRows = await rest('/rest/v1/comments?select=id,post_id,body,author_name,created_at&post_id=in.(' + posts.map((x) => x.id).join(',') + ')&order=created_at.asc').catch(() => []);
  const cmtMap = new Map();
  for (const cm of cRows || []) {
    if (!cmtMap.has(cm.post_id)) cmtMap.set(cm.post_id, []);
    cmtMap.get(cm.post_id).push(cm);
  }
  const cmtPreview = (pid) => {
    const all = cmtMap.get(pid) || [];
    if (!all.length) return '';
    const shown = all.slice(0, 3);
    return '<div class="cmt-preview">' +
      shown.map((cm) => '<div class="cmt-line"><b>' + esc(cm.author_name) + '</b> ' + esc(cm.body) + '</div>').join('') +
      (all.length > 3 ? '<div class="cmt-more">还有 ' + (all.length - 3) + ' 条评论 · 点击帖子查看全部</div>' : '') +
      '</div>';
  };

  list.innerHTML = posts.map((x) => {
    const av = avatarOf(x);
    const c = counts.get(x.id) || {};
    const my = mine.get(x.id) || new Set();
    const imgs = Array.isArray(x.images) ? x.images : [];
    return '<article class="post post-clickable" data-open="' + x.id + '">' +
      '<header>' + avatarHtml(av, 26) +
      (x.game_id ? '<a class="post-game" href="?info=' + x.game_id + '" data-noclick="1">' + esc(x.game_name) + '</a>' : '<span class="post-game plain">' + esc(x.game_name) + '</span>') +
      '<span class="post-meta">' + esc(x.author_name) + ' · ' + timeAgo(x.created_at) + '</span></header>' +
      (x.title ? '<h4 class="post-title">' + esc(x.title) + '</h4>' : '') +
      '<p class="post-body">' + (x.body.length > 180 ? esc(x.body).slice(0, 180) + '…' : esc(x.body)) + '</p>' +
      (imgs.length ? '<div class="imgs">' + imgs.slice(0, 4).map((src) => '<img src="' + src + '">').join('') + (imgs.length > 4 ? '<span class="more-img">+' + (imgs.length - 4) + '</span>' : '') + '</div>' : '') +
      cmtPreview(x.id) +
      '<div class="post-foot">' + reactionHtml(x.id, c, my, false) +
      '<span class="open-hint" data-noclick="1">点击帖子查看完整内容与评论 →</span></div>' +
      '</article>';
  }).join('');

  list.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('[data-noclick]') || ev.target.closest('.react')) return;
      CUR = posts.find((p) => p.id === Number(el.dataset.open));
      VIEW = 'detail';
      renderCommunity(root);
    };
  });
  bindReactions(list, root);
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
  root.innerHTML = '<div class="cmt-bar"><button class="btn" id="backBtn">← 返回社区</button>' +
    '<span style="flex:1"></span><button class="btn btn-sm" id="delPost" style="display:none">删除帖子</button></div>' +
    '<article class="post">' +
    '<header>' + avatarHtml(av, 34) +
    '<a class="post-author" data-author="' + esc(x.author_name) + '" data-aid="' + (x.author_id || '') + '">' + esc(x.author_name) + '<span class="post-uid">#' + (x.author_id || '----') + '</span></a>' +
    (x.game_id ? '<a class="post-game" href="?info=' + x.game_id + '">' + esc(x.game_name) + '</a>' : '<span class="post-game plain">' + esc(x.game_name) + '</span>') +
    '<span class="post-meta">' + timeAgo(x.created_at) + '</span></header>' +
    (x.title ? '<h4 class="post-title" style="font-size:18px">' + esc(x.title) + '</h4>' : '') +
    '<p class="post-body" style="font-size:14px">' + esc(x.body) + '</p>' +
    (imgs.length ? '<div class="detail-imgs">' + imgs.map((src) => '<img src="' + src + '" loading="lazy">').join('') + '</div>' : '') +
    '<div class="post-foot" id="reactSlot"></div>' +
    '<div id="cmtList" class="post-comments"></div>' +
    '<div class="cmt-add"><input class="input sm" id="cmtInput" placeholder="评论两句…"><button class="btn btn-sm" id="cmtSend">发送</button></div>' +
    '</article>';

  root.querySelector('#backBtn').onclick = () => { VIEW = 'list'; CUR = null; renderCommunity(root); };
  root.querySelector('[data-author]').onclick = () => openAuthor(x.author_name, x.author_id);

  const delBtn = root.querySelector('#delPost');
  const emailNow = currentEmail();
  const meNow = profile();
  const canDel = emailNow && (x.author_email === emailNow || Number(x.author_id) === meNow.id || (!x.author_email && x.author_name === meNow.name));
  if (delBtn && canDel) {
    delBtn.style.display = '';
    delBtn.onclick = async () => {
      if (!confirm('删除这条帖子？')) return;
      delBtn.disabled = true;
      try {
        await rest('/rest/v1/posts?id=eq.' + x.id, { method: 'DELETE' });
        toast('已删除');
        VIEW = 'list'; CUR = null; renderCommunity(root);
      } catch (e) {
        toast('删除失败：' + e.message);
        delBtn.disabled = false;
      }
    };
  }

  const { counts, mine } = await loadReactions(String(x.id));
  const slot = root.querySelector('#reactSlot');
  slot.innerHTML = reactionHtml(x.id, counts.get(x.id) || {}, mine.get(x.id) || new Set(), true);
  bindReactions(slot, root);

  const cmtList = root.querySelector('#cmtList');
  try {
    const cs = await rest('/rest/v1/comments?select=id,body,author_name,author_email,created_at&post_id=eq.' + x.id + '&order=created_at.asc') || [];

    // 补 UID：老评论没有 author_id 时，按邮箱从 profiles 里查
    try {
      const all = await rest('/rest/v1/profiles?select=name&limit=500');
      window.__lhNames = new Set((all || []).map((p) => p.name).filter(Boolean));
    } catch (e) { window.__lhNames = new Set(); }

    const emailSet = Array.from(new Set((cs || []).map((c) => c.author_email).filter(Boolean)));
    const uidByEmail = {};
    if (emailSet.length) {
      try {
        const ps = await rest('/rest/v1/profiles?select=user_email,uid&user_email=in.(' + emailSet.map((e) => '"' + e + '"').join(',') + ')');
        for (const p of ps || []) uidByEmail[p.user_email] = p.uid;
      } catch (e) {}
    }
    cmtList.innerHTML = cs.map((cm) => {
      const canDelC = currentEmail() && cm.author_email === currentEmail();
      return '<div class="cmt" data-cid="' + cm.id + '"' + (canDelC ? ' data-mine="1"' : '') + '>' +
        '<b class="cmt-author" data-name="' + esc(cm.author_name) + '" data-uid="' + (cm.author_id || uidByEmail[cm.author_email] || '') + '">' + esc(cm.author_name) +
        (cm.author_id || uidByEmail[cm.author_email] ? '<span class="post-uid">#' + (cm.author_id || uidByEmail[cm.author_email]) + '</span>' : '') + '</b> ' +
        linkifyMentions(cm.body) +
        '<span class="cmt-time">' + timeAgo(cm.created_at) + '</span>' +
        '</div>';
    }).join('') || '<div class="cmt" style="color:var(--text-4)">还没有评论</div>';
    cmtList.querySelectorAll('.cmt-author').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        openCmtMenu(ev, el.dataset.name, root, cmtList.querySelector('#cmtInput'), el.dataset.uid);
      };
    });

    const delCmt = async (cid) => {
      if (!confirm('删除这条评论？')) return;
      try { await rest('/rest/v1/comments?id=eq.' + cid, { method: 'DELETE' }); renderDetail(root); }
      catch (e) { toast('删除失败：' + e.message); }
    };
    cmtList.querySelectorAll('.cmt[data-mine]').forEach((el) => {
      const cid = el.dataset.cid;
      el.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); delCmt(cid); };
      let timer = null;
      const start = () => { timer = setTimeout(() => { delCmt(cid); }, 650); };
      const cancel = () => { if (timer) clearTimeout(timer); };
      el.addEventListener('touchstart', start, { passive: true });
      el.addEventListener('touchend', cancel);
      el.addEventListener('touchmove', cancel);
      el.addEventListener('touchcancel', cancel);
    });
    if (!cmtList.querySelector('#replyHint') && false) {}
    root.querySelector('#cmtSend').onclick = async () => {
      if (!currentEmail()) return openLogin();
      const v = root.querySelector('#cmtInput').value.trim();
      if (!v) return;
      try {
        try {
          await rest('/rest/v1/comments', { method: 'POST', body: [{ post_id: x.id, body: v, author_name: profile().name, author_id: profile().id, author_email: currentEmail() }] });
        } catch (err1) {
          await rest('/rest/v1/comments', { method: 'POST', body: [{ post_id: x.id, body: v, author_name: profile().name, author_email: currentEmail() }] });
        }
        notifyComment(x, v).catch(() => {});
        renderDetail(root);
      } catch (e) { toast('评论失败'); }
    };
  } catch (e) {
    cmtList.innerHTML = '<div class="cmt">评论读取失败：' + esc(e.message) + '</div>';
  }
}


/* ================= 设备配对中转 ================= */
const AUTH_SAVE = 'lh.auth';

function randCode(n) {
  const A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  for (let i = 0; i < n; i += 1) out += A[buf[i] % A.length];
  return out;
}
function randSecret() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function deriveKey(code) {
  const raw = new TextEncoder().encode('lh-relay|' + code);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (ch) => ch.charCodeAt(0));

async function encryptPayload(code, obj) {
  const key = await deriveKey(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return b64(iv) + '.' + b64(ct);
}
async function decryptPayload(code, payload) {
  const parts = String(payload).split('.');
  const key = await deriveKey(code);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(parts[0]) }, key, unb64(parts[1]));
  return JSON.parse(new TextDecoder().decode(plain));
}

export function openRelayReceive() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  const code = randCode(6);
  const secret = randSecret();
  const expires = new Date(Date.now() + 120000).toISOString();

  box.innerHTML = '<div class="m-body"><h3>手机 → 电脑</h3>' +
    '<p style="color:var(--text-3);font-size:13px;margin:8px 0 12px">在已登录的手机上打开「我的账号」，点同步按钮，输入下面的配对码。</p>' +
    '<div class="relay-code">' + code + '</div>' +
    '<p id="relayMsg" style="font-size:12px;color:var(--text-4);margin-top:10px">等待中…（120 秒内有效）</p></div>';

  const msg = box.querySelector('#relayMsg');
  rest('/rest/v1/login_relay', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: [{ code, secret, expires_at: expires }],
  }).catch(() => { msg.textContent = '创建失败：请先在 Supabase 建 login_relay 表'; });

  let stopped = false;
  const t0 = Date.now();
  const tick = async () => {
    if (stopped) return;
    if (Date.now() - t0 > 125000) { msg.textContent = '已超时，重新打开再来一次'; return; }
    try {
      const res = await rest('/rest/v1/rpc/relay_claim', { method: 'POST', body: { p_secret: secret } });
      const payload = typeof res === 'string' ? res : (res && res.value);
      if (payload) {
        const sess = await decryptPayload(code, payload);
        localStorage.setItem(AUTH_SAVE, JSON.stringify(sess));
        stopped = true;
        msg.textContent = '✓ 已接收，正在登录…';
        setTimeout(() => location.reload(), 600);
        return;
      }
    } catch (e) {}
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 1500);
}

export function openRelaySend() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  const sess = session();
  if (!sess || !sess.access_token) return openLogin();
  m.hidden = false;
  box.innerHTML = '<div class="m-body"><h3>同步到另一台设备</h3>' +
    '<p style="color:var(--text-3);font-size:13px;margin:8px 0 12px">输入另一台设备上显示的 6 位配对码。</p>' +
    '<input class="input" id="relayInput" maxlength="6" placeholder="A7K2M9" style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-size:20px">' +
    '<button class="btn btn-primary btn-block" id="relayGo" style="margin-top:10px">发送会话</button>' +
    '<p id="relaySendMsg" class="form-msg form-dim"></p></div>';

  const msg = box.querySelector('#relaySendMsg');
  box.querySelector('#relayGo').onclick = async () => {
    const code = (box.querySelector('#relayInput').value || '').trim().toUpperCase();
    if (code.length !== 6) { msg.className = 'form-msg form-err'; return (msg.textContent = '✕ 配对码是 6 位'); }
    msg.className = 'form-msg form-dim';
    msg.textContent = '发送中…';
    try {
      const payload = await encryptPayload(code, sess);
      await rest('/rest/v1/rpc/relay_post', { method: 'POST', body: { p_code: code, p_payload: payload } });
      msg.className = 'form-msg form-ok';
      msg.textContent = '✓ 已发送，回另一台设备上看';
    } catch (e) {
      msg.className = 'form-msg form-err';
      msg.textContent = '✕ 失败：' + e.message;
    }
  };
}

/* ================= 找回密码 ================= */
export async function recoverPassword(email) {
  const cfg = window.LIGHTHOUSE_SUPABASE || {};
  const back = encodeURIComponent('https://ostonefisho.github.io/SteamSearchAny-auth/');
  const res = await fetch(cfg.url + '/auth/v1/recover?redirect_to=' + back, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message || '发送失败');
  }
  return true;
}

export function openRecover() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  box.innerHTML = '<div class="m-body">' +
    '<h3>找回密码</h3>' +
    '<p style="color:var(--text-3);font-size:13px;margin:8px 0 14px">输入注册邮箱，我们会发一封重置邮件。点邮件里的链接即可重设密码。</p>' +
    '<input class="input" id="rcEmail" type="email" placeholder="you@example.com" autocomplete="email">' +
    '<button class="btn btn-primary btn-block" id="rcSend" style="margin-top:10px">发送重置邮件</button>' +
    '<p id="rcMsg" class="form-msg"></p>' +
    '<button class="btn btn-block" id="rcBack" style="margin-top:14px">返回登录</button>' +
    '</div>';
  const msg = box.querySelector('#rcMsg');
  box.querySelector('#rcBack').onclick = () => openLogin();
  box.querySelector('#rcSend').onclick = async () => {
    const em = box.querySelector('#rcEmail').value.trim();
    if (!em) { msg.className = 'form-msg form-err'; return (msg.textContent = '✕ 请填邮箱'); }
    msg.className = 'form-msg form-dim';
    msg.textContent = '发送中…';
    try {
      await recoverPassword(em);
      msg.className = 'form-msg form-ok';
      msg.textContent = '✓ 已发送。到邮箱点开链接后会跳回账号中心，然后设置新密码。';
    } catch (e) {
      msg.className = 'form-msg form-err';
      msg.textContent = '✕ 失败：' + e.message;
    }
  };
}

export function openResetPassword() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  if (!currentEmail()) return openRecover();
  m.hidden = false;
  box.innerHTML = '<div class="m-body">' +
    '<h3>设置新密码</h3>' +
    '<p style="color:var(--text-3);font-size:13px;margin:8px 0 14px">为 ' + esc(currentEmail()) + ' 设置一个新密码。</p>' +
    '<input class="input" id="np1" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password">' +
    '<input class="input" id="np2" type="password" placeholder="再输一次确认" style="margin-top:8px" autocomplete="new-password">' +
    '<button class="btn btn-primary btn-block" id="npGo" style="margin-top:10px">保存新密码</button>' +
    '<p id="npMsg" class="form-msg"></p>' +
    '</div>';
  const msg = box.querySelector('#npMsg');
  box.querySelector('#npGo').onclick = async () => {
    const a = box.querySelector('#np1').value;
    const b = box.querySelector('#np2').value;
    if (!a || a.length < 6) { msg.className = 'form-msg form-err'; return (msg.textContent = '✕ 密码至少 6 位'); }
    if (a !== b) { msg.className = 'form-msg form-err'; return (msg.textContent = '✕ 两次输入的密码不一致，请重新确认'); }
    msg.className = 'form-msg form-dim';
    msg.textContent = '保存中…';
    try {
      await setPassword(a);
      localStorage.setItem('lh.hasPw', '1');
      msg.className = 'form-msg form-ok';
      msg.textContent = '✓ 已保存，以后用邮箱+新密码登录';
    } catch (e) {
      msg.className = 'form-msg form-err';
      msg.textContent = '✕ 失败：' + e.message;
    }
  };
}

/* 从重置邮件点回来时自动弹出重设界面 */
try {
  const hash = decodeURIComponent(location.hash || '');
  if (hash.includes('type=recovery') || hash.includes('type%3Drecovery')) {
    setTimeout(() => { try { openResetPassword(); } catch (e) {} }, 900);
  }
} catch (e) {}


/* ================= 评论作者菜单 ================= */
function openCmtMenu(ev, name, root, inputEl, uid) {
  document.querySelectorAll('.cmt-menu').forEach((n) => n.remove());
  const menu = document.createElement('div');
  menu.className = 'cmt-menu';
  const isSelf = currentEmail() && profile().name === name;
  menu.innerHTML = '<button data-act="home">' + (isSelf ? '我的主页' : '他的主页') + '</button>' +
    '<button data-act="reply">回复评论</button>' +
    (isSelf ? '' : '<button data-act="friend">加为好友</button>');
  document.body.appendChild(menu);

  const x = Math.min(ev.clientX, window.innerWidth - 160);
  const y = Math.min(ev.clientY, window.innerHeight - 100);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';

  const close = () => menu.remove();
  setTimeout(() => document.addEventListener('click', close, { once: true }), 0);

  menu.onclick = (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    if (act.dataset.act === 'home') {
      openAuthor(name, uid || null);
    } else if (act.dataset.act === 'friend') {
      addFriendByName(name).catch(() => toast('加好友失败'));
    } else {
      const input = document.querySelector('#cmtInput');
      if (input) {
        const prefix = '@' + name + ' ';
        if (!input.value.startsWith(prefix)) input.value = prefix + input.value;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
    close();
  };
}


/* ================= 通知 ================= */
let NOTIFS = [];
let notifOpen = false;

async function loadNotifs() {
  if (!currentEmail()) return [];
  try {
    NOTIFS = await rest('/rest/v1/notifications?select=id,kind,post_id,post_title,from_name,body,read,created_at&user_email=eq.' + encodeURIComponent(currentEmail()) + '&order=created_at.desc&limit=30') || [];
  } catch (e) {
    NOTIFS = [];
  }
  return NOTIFS;
}

function floatBadge(anchorId, count, cls) {
  const anchor = document.getElementById(anchorId);
  if (!anchor) return;
  const id = 'floatBadge-' + anchorId;
  let el = document.getElementById(id);
  const show = count > 0;
  if (!show) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('span');
    el.id = id;
    el.className = 'float-badge ' + (cls || '');
    document.body.appendChild(el);
  }
  const r = anchor.getBoundingClientRect();
  el.textContent = count > 9 ? '9+' : String(count);
  el.style.left = (r.right - 6) + 'px';
  el.style.top = (r.top - 4) + 'px';
}

function paintDot() {
  const unread = NOTIFS.filter((n) => !n.read).length;
  floatBadge('notifBtn', unread);
  // 旧的内嵌 dot 一律隐藏，避免重复
  const dot = document.getElementById('notifDot');
  if (dot) { dot.classList.add('hidden'); dot.textContent = ''; }
}

window.addEventListener('resize', () => { try { paintDot(); } catch (e) {} });
window.addEventListener('scroll', () => { try { paintDot(); } catch (e) {} }, true);

export async function refreshNotifs() {
  await loadNotifs();
  paintDot();
  if (notifOpen) renderNotifs();
}

function notifLine(n) {
  const icon = n.kind === 'reply' ? '↩' : (n.kind === 'like' ? '👍' : '💬');
  const unread = n.read ? '' : ' unread';
  return '<div class="notif-item' + unread + '" data-nid="' + n.id + '" data-pid="' + (n.post_id || '') + '">' +
    '<span class="notif-ic">' + icon + '</span>' +
    '<div><div class="notif-t">' + esc(n.from_name || '有人') + ' ' + (n.kind === 'reply' ? '回复了你' : (n.kind === 'like' ? '赞了你的帖子' : '评论了你的帖子')) + '</div>' +
    '<div class="notif-b">' + esc((n.body || '').slice(0, 46)) + '</div>' +
    '<div class="notif-m">' + esc(n.post_title || '') + ' · ' + timeAgo(n.created_at) + '</div></div>' +
    '</div>';
}

function renderNotifs() {
  let panel = document.getElementById('notifPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'notifPanel';
    panel.className = 'notif-panel';
    document.body.appendChild(panel);
  }
  const unread = NOTIFS.filter((n) => !n.read).length;
  panel.innerHTML = '<div class="notif-head"><b>通知</b>' +
    '<span class="notif-actions">' + (unread ? '<button id="notifAll">全部已读</button>' : '') +
    '<button id="notifClose">关闭</button></span></div>' +
    '<div class="notif-list">' + (NOTIFS.length ? NOTIFS.map(notifLine).join('') : '<div class="notif-empty">还没有通知</div>') + '</div>';

  const close = () => { notifOpen = false; panel.remove(); };
  panel.querySelector('#notifClose').onclick = close;
  const all = panel.querySelector('#notifAll');
  if (all) all.onclick = async () => {
    try {
      await rest('/rest/v1/notifications?user_email=eq.' + encodeURIComponent(currentEmail()) + '&read=eq.false', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { read: true } });
      await refreshNotifs();
    } catch (e) { toast('操作失败'); }
  };

  panel.querySelectorAll('.notif-item').forEach((el) => {
    el.onclick = async () => {
      const nid = el.dataset.nid;
      const pid = el.dataset.pid;
      try {
        await rest('/rest/v1/notifications?id=eq.' + nid, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { read: true } });
        const item = NOTIFS.find((n) => String(n.id) === String(nid));
        if (item) item.read = true;
        el.classList.remove('unread');
        paintDot();
      } catch (e) {}
      close();
      if (pid) openPostById(pid);
      setTimeout(() => refreshNotifs().catch(() => {}), 400);
    };
  });
}

function toggleNotifPanel() {
  if (notifOpen) {
    const p = document.getElementById('notifPanel');
    if (p) p.remove();
    notifOpen = false;
    return;
  }
  notifOpen = true;
  renderNotifs();
  refreshNotifs();
}

/** 打开某条帖子详情（自动切到社区 tab） */
async function openPostById(pid) {
  const tab = document.querySelector('.tab[data-view="community"]');
  if (tab) tab.click();
  await new Promise((r) => setTimeout(r, 180));
  let root = document.getElementById('view-community');
  if (!root) {
    const all = Array.from(document.querySelectorAll('[id^="view-"]'));
    root = all.find((el) => /community/.test(el.id)) || null;
  }
  try {
    const rows = await rest('/rest/v1/posts?select=id,title,game_id,game_name,body,images,author_name,author_id,author_avatar,author_email,created_at&id=eq.' + pid);
    if (rows && rows[0] && root) {
      CUR = rows[0];
      VIEW = 'detail';
      renderCommunity(root);
    } else {
      toast('帖子可能已被删除');
    }
  } catch (e) { toast('打开失败：' + e.message); }
}

/** 评论/回复时给相关人发通知 */
async function notifyComment(post, body) {
  const me = currentEmail();
  if (!me) return;
  const rows = [];
  const seen = new Set([me]);
  const push = (email, kind, text) => {
    if (!email || seen.has(email)) return;
    seen.add(email);
    rows.push({ user_email: email, kind, post_id: post.id, post_title: post.title || '无标题', from_name: profile().name, body: text });
  };

  // 帖子作者收到「评论」
  if (post.author_email && post.author_email !== me) push(post.author_email, 'comment', body);

  // 正文里所有 @某人 都通知（不限开头）
  const names = Array.from(new Set((body.match(/@([A-Za-z0-9_\u4e00-\u9fa5\-]{1,16})/g) || []).map((x) => x.slice(1))));
  for (const nm of names) {
    try {
      const ps = await rest('/rest/v1/profiles?select=user_email&name=eq.' + encodeURIComponent(nm) + '&limit=1');
      const em = ps && ps[0] && ps[0].user_email;
      push(em, 'reply', body);
    } catch (e) {}
  }

  if (!rows.length) return;
  try {
    await rest('/rest/v1/notifications', { method: 'POST', body: rows });
  } catch (e) {}
}

/* 启动时绑定邮件按钮 + 首次拉取 */
try {
  const bindBtn = () => {
    const b = document.getElementById('notifBtn');
    if (!b) return false;
    b.onclick = (ev) => { ev.stopPropagation(); toggleNotifPanel(); };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#notifPanel') && !e.target.closest('#notifBtn')) {
        const p = document.getElementById('notifPanel');
        if (p) { p.remove(); notifOpen = false; }
      }
    });
    return true;
  };
  if (!bindBtn()) setTimeout(bindBtn, 600);
  setTimeout(() => { refreshNotifs().catch(() => {}); }, 1200);
  setTimeout(() => { syncProfile().then(() => refreshAuthButton()).catch(() => {}); }, 600);
  setTimeout(() => {
    const em = currentEmail();
    if (em) rest('/rest/v1/profiles?user_email=eq.' + encodeURIComponent(em), { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { last_seen: new Date().toISOString() } }).catch(() => {});
  }, 1500);
} catch (e) {}


/** 把 @某人 渲染成高亮的 span（先转义，避免注入） */
function linkifyMentions(text) {
  const safe = esc(text);
  const known = window.__lhNames || null;
  return safe.replace(/@([A-Za-z0-9_\u4e00-\u9fa5\-]{1,16})/g, (all, nm) => {
    if (known && known.size && !known.has(nm)) return all;
    return '<span class="mention">@' + nm + '</span>';
  });
}


/** 按昵称找邮箱并互加好友 */
export async function addFriendByName(name) {
  const me = currentEmail();
  if (!me) return openLogin();
  if (profile().name === name) return toast('不能加自己');
  try {
    const ps = await rest('/rest/v1/profiles?select=user_email&name=eq.' + encodeURIComponent(name) + '&limit=1');
    const target = ps && ps[0] && ps[0].user_email;
    if (!target) return toast('找不到这个用户');
    await sendFriendRequest(target, name);
    toast('已向 ' + name + ' 发送好友申请');
  } catch (e) {
    toast('加好友失败：' + e.message);
  }
}


/* ================= 好友系统（申请制） ================= */
const FR = 'friendships';

async function findFriendship(me, other) {
  const rows = await rest('/rest/v1/' + FR + '?select=id,requester,target,status&or=(and(requester.eq.' + encodeURIComponent(me) + ',target.eq.' + encodeURIComponent(other) + '),and(requester.eq.' + encodeURIComponent(other) + ',target.eq.' + encodeURIComponent(me) + '))&limit=1');
  return rows && rows[0];
}

export async function sendFriendRequest(targetEmail, targetName) {
  const me = currentEmail();
  if (!me) return openLogin();
  if (!targetEmail || targetEmail === me) throw new Error('目标无效');
  const exist = await findFriendship(me, targetEmail);
  if (exist) {
    if (exist.status === 'accepted') throw new Error('已经是好友了');
    throw new Error('已有待处理的申请');
  }
  await rest('/rest/v1/' + FR, { method: 'POST', body: [{ requester: me, target: targetEmail, status: 'pending' }] });
  await rest('/rest/v1/notifications', {
    method: 'POST',
    body: [{ user_email: targetEmail, kind: 'friend', post_id: null, post_title: '好友申请', from_name: profile().name, body: '请求加你为好友' }],
  }).catch(() => {});
  paintFriendDot();
}

async function friendCount() {
  const me = currentEmail();
  if (!me) return { pending: 0, friends: 0 };
  try {
    const inc = await rest('/rest/v1/' + FR + '?select=id,status&target=eq.' + encodeURIComponent(me) + '&status=eq.pending');
    const acc = await rest('/rest/v1/' + FR + '?select=id,status&status=eq.accepted&or=(requester.eq.' + encodeURIComponent(me) + ',target.eq.' + encodeURIComponent(me) + ')');
    return { pending: (inc || []).length, friends: (acc || []).length };
  } catch (e) {
    return { pending: 0, friends: 0 };
  }
}

async function paintFriendDot() {
  const c = await friendCount();
  floatBadge('friendsBtn', c.pending);
  const dot = document.getElementById('friendDot');
  if (dot) { dot.classList.add('hidden'); dot.textContent = ''; }
}

export async function openFriends() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  if (!currentEmail()) return openLogin();
  m.hidden = false;
  box.innerHTML = '<div class="m-body"><h3>好友</h3><div id="friendBody"><div class="empty-state"><span class="spin"></span></div></div></div>';
  const body = box.querySelector('#friendBody');
  const me = currentEmail();

  let incoming = [], outgoing = [], accepted = [];
  try {
    incoming = await rest('/rest/v1/' + FR + '?select=id,requester,created_at&target=eq.' + encodeURIComponent(me) + '&status=eq.pending') || [];
    const acc0 = await rest('/rest/v1/' + FR + '?select=target&status=eq.accepted&requester=eq.' + encodeURIComponent(me)) || [];
    const accSet = new Set((acc0 || []).map((r) => r.target));
    outgoing = (await rest('/rest/v1/' + FR + '?select=id,target,created_at&requester=eq.' + encodeURIComponent(me) + '&status=eq.pending') || []).filter((r) => !accSet.has(r.target));
    accepted = await rest('/rest/v1/' + FR + '?select=id,requester,target,status,remark,starred&status=eq.accepted&or=(requester.eq.' + encodeURIComponent(me) + ',target.eq.' + encodeURIComponent(me) + ')') || [];
    accepted.sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0));
  } catch (e) {
    body.innerHTML = '<div class="empty-state">读取失败：' + esc(e.message) + '<br><span style="font-size:12px;color:var(--text-4)">多半是 friendships 表还没建</span></div>';
    return;
  }

  const emails = Array.from(new Set([].concat(
    incoming.map((x) => x.requester),
    outgoing.map((x) => x.target),
    accepted.map((x) => (x.requester === me ? x.target : x.requester))
  )));
  const profMap = {};
  if (emails.length) {
    try {
      const ps = await rest('/rest/v1/profiles?select=user_email,name,avatar,uid,bio&user_email=in.(' + emails.map((e) => '"' + e + '"').join(',') + ')');
      for (const p of ps || []) profMap[p.user_email] = p;
    } catch (e) {}
  }
  const av = (email) => {
    const p = profMap[email];
    const img = p && p.avatar && p.avatar.startsWith('data:') ? p.avatar : '';
    return avatarHtml({ avatar: (p && p.avatar && !img) ? p.avatar : '🎮', img }, 38);
  };
  const nm = (email) => (profMap[email] && profMap[email].name) || email.split('@')[0];
  const uidOf = (email) => (profMap[email] && profMap[email].uid) || '';

  let html = '';
  html += '<div class="fr-sec"><div class="fr-t">收到的申请 ' + (incoming.length ? '(' + incoming.length + ')' : '') + '</div>';
  html += incoming.length
    ? incoming.map((x) => '<div class="fr-row" data-rq="' + x.id + '" data-em="' + esc(x.requester) + '">' + av(x.requester) +
        '<div class="fr-info"><b>' + esc(nm(x.requester)) + '<span class="post-uid">#' + esc(uidOf(x.requester) || '----') + '</span></b>' +
        '<span class="fr-sub">' + timeAgo(x.created_at) + '</span></div>' +
        '<button class="btn btn-sm btn-primary" data-accept="1">接受</button>' +
        '<button class="btn btn-sm" data-reject="1">拒绝</button></div>').join('')
    : '<div class="fr-empty">暂时没有人申请加你好友</div>';
  html += '</div>';

  html += '<div class="fr-sec"><div class="fr-t">我的好友 ' + (accepted.length ? '(' + accepted.length + ')' : '') + '</div>';
  html += accepted.length
    ? accepted.map((x) => {
        const other = x.requester === me ? x.target : x.requester;
        return '<div class="fr-row">' + av(other) +
          '<div class="fr-info"><b>' + (x.starred ? '<span class="star">★</span>' : '') + esc(x.remark || nm(other)) +
          '<span class="post-uid">#' + esc(uidOf(other) || '----') + '</span></b>' +
          '<span class="fr-sub">' + esc((profMap[other] && profMap[other].bio) || '这个人懒得写简介') + '</span></div>' +
          '<button class="btn btn-sm btn-primary" data-chat="' + esc(other) + '" data-cname="' + esc(nm(other)) + '">聊天</button>' +
          '<button class="btn btn-sm" data-view="' + esc(other) + '">主页</button>' +
          '<button class="btn btn-sm" data-manage="' + x.id + '" data-em="' + esc(other) + '" data-nm="' + esc(nm(other)) + '" data-rm="' + esc(x.remark || '') + '" data-star="' + (x.starred ? '1' : '') + '">管理</button></div>';
      }).join('')
    : '<div class="fr-empty">还没有好友，去帖子或主页里点「加为好友」</div>';
  html += '</div>';

  if (outgoing.length) {
    html += '<div class="fr-sec"><div class="fr-t">发出的申请 (' + outgoing.length + ')</div>' +
      outgoing.map((x) => '<div class="fr-row">' + av(x.target) +
        '<div class="fr-info"><b>' + esc(nm(x.target)) + '</b><span class="fr-sub">等待对方同意</span></div>' +
        '<button class="btn btn-sm" data-cancel="' + x.id + '">撤回</button></div>').join('') +
      '</div>';
  }
  body.innerHTML = html;

  body.querySelectorAll('[data-accept]').forEach((b) => {
    b.onclick = async () => {
      const row = b.closest('[data-rq]');
      try {
        await rest('/rest/v1/' + FR + '?id=eq.' + row.dataset.rq, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: { status: 'accepted' } });
        await rest('/rest/v1/notifications', { method: 'POST', body: [{ user_email: row.dataset.em, kind: 'friend', post_title: '好友申请', from_name: profile().name, body: '同意了你的好友申请' }] }).catch(() => {});
        toast('已添加好友');
        paintFriendDot();
        openFriends();
      } catch (e) { toast('失败：' + e.message); }
    };
  });
  body.querySelectorAll('[data-reject]').forEach((b) => {
    b.onclick = async () => {
      const row = b.closest('[data-rq]');
      try {
        await rest('/rest/v1/' + FR + '?id=eq.' + row.dataset.rq, { method: 'DELETE' });
        openFriends();
      } catch (e) { toast('失败'); }
    };
  });
  body.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = async () => {
      try {
        await rest('/rest/v1/' + FR + '?id=eq.' + b.dataset.cancel, { method: 'DELETE' });
        openFriends();
      } catch (e) { toast('失败'); }
    };
  });
  body.querySelectorAll('[data-manage]').forEach((b) => {
    b.onclick = () => openFriendMenu(b, () => openFriends());
  });
  body.querySelectorAll('[data-chat]').forEach((b) => {
    b.onclick = () => openChat(b.dataset.chat, b.dataset.cname);
  });
  body.querySelectorAll('[data-view]').forEach((b) => {
    b.onclick = async () => {
      const em = b.dataset.view;
      const p = profMap[em];
      openAuthor((p && p.name) || em, (p && p.uid) || null);
    };
  });
}

/* 好友按钮绑定 */
try {
  const bindF = () => {
    const b = document.getElementById('friendsBtn');
    if (!b) return false;
    b.onclick = (ev) => { ev.stopPropagation(); openFriends(); };
    paintFriendDot();
    return true;
  };
  if (!bindF()) setTimeout(bindF, 700);
} catch (e) {}


/* ================= 好友私聊 ================= */
const CHAT_EMOJI = ['😀', '😂', '🥹', '😍', '🤔', '😎', '😭', '😡', '👍', '👎', '🎮', '🔥', '💡', '🎉', '❤️', '🌙'];

export function openChat(peerEmail, peerName) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  const me = currentEmail();
  if (!m) return;
  if (!me) return openLogin();
  if (peerEmail === me) return;
  m.hidden = false;
  box.classList.add('chat-mode');

  let peerProf = null;
  let closed = false;
  let timer = null;
  let lastCount = -1;
  let pending = [];

  box.innerHTML = '<div class="chat-body">' +
    '<div class="chat-head">' +
      '<button class="chat-back" id="chatBack" title="返回好友列表">←</button>' +
      '<span class="chat-av-slot" id="chatPeerAv"></span>' +
      '<div class="chat-id"><b id="chatPeerName">' + esc(peerName || peerEmail) + '</b>' +
        '<span class="chat-state" id="chatState"><i class="dot off"></i>读取中…</span></div>' +
      '<button class="chat-x" id="chatClose" title="关闭">×</button>' +
    '</div>' +
    '<div class="chat-list" id="chatList"><div class="chat-loading">载入消息…</div></div>' +
    '<div class="chat-images" id="chatImgs"></div>' +
    '<div class="chat-compose">' +
      '<button class="chat-tool" id="chatEmoji" title="表情">🙂</button>' +
      '<button class="chat-tool" id="chatPic" title="图片">🖼</button>' +
      '<input type="file" id="chatFile" accept="image/*" multiple class="hidden">' +
      '<input class="chat-input" id="chatInput" placeholder="说点什么…">' +
      '<button class="chat-send" id="chatSend">发送</button>' +
    '</div>' +
    '<div class="chat-emoji hidden" id="chatEmojiBox">' +
      CHAT_EMOJI.map((e) => '<button data-em="' + e + '">' + e + '</button>').join('') +
    '</div>' +
    '</div>';

  const list = box.querySelector('#chatList');
  const imgsWrap = box.querySelector('#chatImgs');

  const renderImgs = () => {
    imgsWrap.innerHTML = pending.map((src, i) => '<span class="thumb"><img src="' + src + '"><b data-rm="' + i + '">×</b></span>').join('');
    imgsWrap.querySelectorAll('[data-rm]').forEach((btn) => {
      btn.onclick = () => { pending.splice(Number(btn.dataset.rm), 1); renderImgs(); };
    });
  };

  const paintPresence = async () => {
    const st = box.querySelector('#chatState');
    try {
      const ps = await rest('/rest/v1/profiles?select=name,avatar,last_seen&user_email=eq.' + encodeURIComponent(peerEmail) + '&limit=1');
      const p0 = ps && ps[0];
      peerProf = p0 || null;
      if (p0) {
        if (p0.name) box.querySelector('#chatPeerName').textContent = p0.name;
        const img = String(p0.avatar || '');
        box.querySelector('#chatPeerAv').innerHTML = avatarHtml({ avatar: img.startsWith('data:') ? '🎮' : (img || '🎮'), img: img.startsWith('data:') ? img : '' }, 32);
        const last = p0.last_seen ? new Date(p0.last_seen).getTime() : 0;
        const mins = last ? Math.floor((Date.now() - last) / 60000) : null;
        if (mins !== null && mins <= 3) st.innerHTML = '<i class="dot"></i>在线';
        else if (mins !== null) st.innerHTML = '<i class="dot off"></i>' + (mins < 60 ? mins + ' 分钟前在线' : Math.floor(mins / 60) + ' 小时前在线');
        else st.innerHTML = '<i class="dot off"></i>离线';
      } else {
        st.innerHTML = '<i class="dot off"></i>离线';
      }
    } catch (e) {
      st.innerHTML = '<i class="dot off"></i>离线';
    }
  };

  const load = async () => {
    try {
      const rows = await rest('/rest/v1/messages?select=id,sender,receiver,body,images,created_at&or=(and(sender.eq.' + encodeURIComponent(me) + ',receiver.eq.' + encodeURIComponent(peerEmail) + '),and(sender.eq.' + encodeURIComponent(peerEmail) + ',receiver.eq.' + encodeURIComponent(me) + '))&order=created_at.asc&limit=200') || [];
      if (rows.length === lastCount) return;
      lastCount = rows.length;
      const meP = profile();
      const meAv = avatarHtml({ avatar: meP.avatar, img: meP.img }, 30);
      const img = String((peerProf && peerProf.avatar) || '');
      const peerAv = avatarHtml({ avatar: img.startsWith('data:') ? '🎮' : (img || '🎮'), img: img.startsWith('data:') ? img : '' }, 30);
      const peerLabel = (peerProf && peerProf.name) || peerName || '对方';

      list.innerHTML = rows.length ? rows.map((r) => {
        const mine = r.sender === me;
        const imgs = Array.isArray(r.images) ? r.images : [];
        return '<div class="msg ' + (mine ? 'mine' : '') + '">' +
          '<div class="msg-av">' + (mine ? meAv : peerAv) + '</div>' +
          '<div class="msg-body">' +
            '<div class="msg-who">' + esc(mine ? (meP.name || '我') : peerLabel) + '</div>' +
            (r.body ? '<div class="msg-bubble">' + linkifyMentions(r.body) + '</div>' : '') +
            (imgs.length ? '<div class="msg-pics">' + imgs.map((src) => '<img src="' + src + '">').join('') + '</div>' : '') +
            '<div class="msg-time">' + timeAgo(r.created_at) + '</div>' +
          '</div></div>';
      }).join('') : '<div class="chat-empty">还没有消息，打个招呼吧 👋</div>';
      list.scrollTop = list.scrollHeight;
    } catch (e) {
      list.innerHTML = '<div class="chat-empty">读取失败：' + esc(e.message) + '<br><span style="font-size:12px;opacity:.7">多半是 messages 表还没建</span></div>';
    }
  };

  const send = async () => {
    const input = box.querySelector('#chatInput');
    const body = input.value.trim();
    if (!body && !pending.length) return;
    try {
      await rest('/rest/v1/messages', { method: 'POST', body: [{ sender: me, receiver: peerEmail, body: body || '', images: pending.slice() }] });
      input.value = '';
      pending = [];
      renderImgs();
      lastCount = -1;
      load();
    } catch (e) {
      toast('发送失败：' + e.message);
    }
  };

  const close = () => {
    closed = true;
    if (timer) clearInterval(timer);
    box.classList.remove('chat-mode');
    m.hidden = true;
  };

  box.querySelector('#chatSend').onclick = send;
  box.querySelector('#chatInput').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  box.querySelector('#chatEmoji').onclick = () => box.querySelector('#chatEmojiBox').classList.toggle('hidden');
  box.querySelector('#chatEmojiBox').onclick = (e) => {
    const btn = e.target.closest('[data-em]');
    if (!btn) return;
    const input = box.querySelector('#chatInput');
    input.value += btn.dataset.em;
    input.focus();
  };
  box.querySelector('#chatPic').onclick = () => box.querySelector('#chatFile').click();
  box.querySelector('#chatFile').onchange = async (e) => {
    const files = [...(e.target.files || [])].slice(0, 3 - pending.length);
    for (const f of files) {
      try { pending.push(await compressImage(f, 900, 0.72)); } catch (err) {}
    }
    renderImgs();
    e.target.value = '';
  };
  box.querySelector('#chatClose').onclick = close;
  box.querySelector('#chatBack').onclick = () => { close(); openFriends(); };

  paintPresence();
  load();
  timer = setInterval(() => { if (!closed) { load(); paintPresence(); } }, 5000);
}

/* ================= 图片灯箱 ================= */
function openLightbox(src) {
  let box = document.getElementById('lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lightbox';
    box.className = 'lightbox';
    box.innerHTML = '<img><span class="lb-close">×</span>';
    document.body.appendChild(box);
    box.onclick = () => box.remove();
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.remove(); });
  }
  box.querySelector('img').src = src;
}

document.addEventListener('dblclick', (e) => {
  const img = e.target.closest('.chat-pic img, .detail-imgs img, .post .imgs img');
  if (!img) return;
  e.preventDefault();
  openLightbox(img.src);
});
