// 绀惧尯 v3锛氬浘鐗?鈮?)銆佸笘瀛愯鎯呴〉銆佸垎椤?鍙厤缃?銆佺偣璧炪€佸垹璇勮
import { isConfigured, sendCode, verifyCode, logout, currentEmail, session, captureHashSession, fillEmailFromUser, setPassword, signInWithPassword } from './supabase-lite.js?v=20261128a';

try {
  const rawUrl = location.href;
  const claimed = captureHashSession();
  if (claimed) window.__LH_LOGIN_URL = rawUrl;
  Promise.resolve(claimed ? fillEmailFromUser() : null).then(() => syncProfile()).then(() => refreshAuthButton()).catch(() => {});
} catch {}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeAgo = (iso) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return '鍒氬垰';
  if (d < 3600) return `${Math.floor(d / 60)} 鍒嗛挓鍓峘;
  if (d < 86400) return `${Math.floor(d / 3600)} 灏忔椂鍓峘;
  return `${Math.floor(d / 86400)} 澶╁墠`;
};

/* ---------- 璧勬枡 ---------- */
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
  return { id, name: p.name || (email ? email.split('@')[0] : ''), avatar: p.avatar || '馃幃', img: p.img || '', color: p.color || '#45bdf7' };
}
function saveProfile(p) { try { localStorage.setItem(PK, JSON.stringify(p)); } catch {} }

const AVATARS = ['馃幃', '馃暪锔?, '馃懢', '馃殌', '馃寣', '馃惐', '馃', '馃惓', '馃寵', '猸?, '馃敟', '馃帶'];
const COLORS = ['#45bdf7', '#b6e04a', '#ffb04d', '#f4736f', '#a78bfa', '#34d399', '#f472b6'];
let DRAFT = null;

function avatarHtml(p, size = 40) {
  const base = `width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;display:grid;place-items:center;overflow:hidden;border:1px solid ${p.color || '#45bdf7'}55;background:${p.color || '#45bdf7'}1f;flex:none;`;
  if (p.img) return `<span style="${base}"><img src="${p.img}" style="width:100%;height:100%;object-fit:cover"></span>`;
  return `<span style="${base}font-size:${Math.round(size * 0.5)}px">${esc(p.avatar || '馃幃')}</span>`;
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
    throw new Error('鐧诲綍宸茶繃鏈燂紝璇烽噸鏂扮櫥褰?);
  }
  if (!res.ok) throw new Error((data && data.message) || 'HTTP ' + res.status);
  return data;
}

/* ---------- 杩滅璧勬枡 ---------- */
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

/* ---------- 鍥剧墖鍘嬬缉 ---------- */
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

/* ---------- 澶村儚瑁佸壀 ---------- */
function openAvatarEditor(file, onDone) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  const reader = new FileReader();
  reader.onload = () => {
    m.hidden = false;
    box.innerHTML = `<div class="m-body">
      <h3>璋冩暣澶村儚</h3>
      <div class="crop-wrap"><canvas id="cropCv" width="260" height="260"></canvas></div>
      <label class="field-label">缂╂斁</label>
      <input type="range" id="zoom" min="100" max="260" value="140" style="width:100%">
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn btn-primary" id="cropOk" style="flex:1">鐢ㄨ繖寮?/button>
        <button class="btn" id="cropCancel">鍙栨秷</button>
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

/* ---------- 璐﹀彿闈㈡澘 ---------- */
export function openLogin() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  const email = currentEmail();

  if (!isConfigured()) {
    box.innerHTML = `<div class="m-body"><h3>杩樻病鏈夋帴鍚庣</h3></div>`;
    return;
  }
  if (!email) {
    box.innerHTML = `<div class="m-body"><h3>鐧诲綍</h3>
      <div class="segs" style="display:flex;gap:8px;margin:6px 0 14px">
        <button class="btn btn-sm" id="tabMail" style="flex:1">閭欢閾炬帴</button>
        <button class="btn btn-sm" id="tabPw" style="flex:1">璐﹀彿瀵嗙爜</button>
      </div>
      <div id="mailPane">
      <p style="color:var(--text-3);font-size:13px;margin:8px 0 14px">杈撳叆閭锛屼細鏀跺埌涓€灏佸甫鐧诲綍閾炬帴鐨勯偖浠躲€?/p>
      <input class="input" id="authEmail" type="email" placeholder="you@example.com">
      <button class="btn btn-primary btn-block" id="sendCode" style="margin-top:10px">鍙戦€侀偖浠?/button>
      <div id="codeBox" class="hidden" style="margin-top:14px">
        <input class="input" id="authCode" inputmode="numeric" placeholder="6 浣嶉獙璇佺爜锛堝彲閫夛級" maxlength="8">
        <button class="btn btn-block" id="doVerify" style="margin-top:10px">鐢ㄩ獙璇佺爜鐧诲綍</button>
      </div>
      <p id="authMsg" style="font-size:12px;color:var(--text-4);margin-top:10px"></p>
      </div>
      <div id="pwPane" class="hidden">
        <input class="input" id="pwEmail" type="email" placeholder="閭" autocomplete="username">
        <input class="input" id="pwPass" type="password" placeholder="瀵嗙爜" style="margin-top:8px" autocomplete="current-password">
        <button class="btn btn-primary btn-block" id="pwLogin" style="margin-top:10px">鐧诲綍</button>
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
    relayBtn.textContent = '鎵嬫満宸茬櫥褰曪紵鍚屾鍒拌繖鍙扮數鑴?;
    relayBtn.onclick = () => openRelayReceive();
    pwPane.parentElement.appendChild(relayBtn);

    const forgot = document.createElement('p');
    forgot.style.cssText = 'font-size:12px;color:var(--text-4);margin-top:10px;cursor:pointer;text-align:right';
    forgot.textContent = '蹇樿瀵嗙爜锛?;
    forgot.onclick = async () => {
      const em = box.querySelector('#pwEmail').value.trim();
      if (!em) return (pwMsg.textContent = '鍏堝～閭');
      try { await recoverPassword(em); pwMsg.textContent = '鎭㈠閭欢宸插彂閫侊紝鐐归偖浠堕噷鐨勯摼鎺ョ櫥褰曞悗閲嶆柊璁剧疆瀵嗙爜'; }
      catch (e) { pwMsg.textContent = '澶辫触锛? + e.message; }
    };
    pwPane.appendChild(forgot);

    const pwMsg = box.querySelector('#pwMsg');
    box.querySelector('#pwLogin').onclick = async () => {
      const em = box.querySelector('#pwEmail').value.trim();
      const pw = box.querySelector('#pwPass').value;
      if (!em || !pw) return (pwMsg.textContent = '閭鍜屽瘑鐮侀兘瑕佸～');
      pwMsg.textContent = '鐧诲綍涓€?;
      try { await signInWithPassword(em, pw); m.hidden = true; location.reload(); }
      catch (e) { pwMsg.textContent = '鐧诲綍澶辫触锛? + e.message; }
    };

    box.querySelector('#sendCode').onclick = async () => {
      const em = box.querySelector('#authEmail').value.trim();
      if (!em) return (msg.textContent = '璇峰～閭');
      msg.textContent = '鍙戦€佷腑鈥?;
      try { await sendCode(em); box.querySelector('#codeBox').classList.remove('hidden'); msg.textContent = '閭欢宸插彂閫?; }
      catch (e) { msg.textContent = '澶辫触锛? + e.message; }
    };
    box.querySelector('#doVerify').onclick = async () => {
      const code = box.querySelector('#authCode').value.trim();
      if (!code) return (msg.textContent = '璇峰～楠岃瘉鐮?);
      try { await verifyCode(box.querySelector('#authEmail').value.trim(), code); m.hidden = true; location.reload(); }
      catch (e) { msg.textContent = '澶辫触锛? + e.message; }
    };
    return;
  }

  DRAFT = DRAFT || { ...profile() };
  const p = DRAFT;
  box.innerHTML = `<div class="m-body">
    <h3>鎴戠殑璐﹀彿</h3>
    <div class="profile-head"><span id="avatarPreview">${avatarHtml(p, 56)}</span>
      <div><div class="profile-name">${esc(p.name)}</div>
      <div class="profile-mail">${esc(email)} 路 UID #${p.id}</div></div></div>
    <label class="field-label">鏄电О</label>
    <input class="input" id="pName" maxlength="16" value="${esc(p.name)}">
    <label class="field-label">涓婁紶澶村儚锛堝彲缂╂斁锛?/label>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn" id="uploadBtn">閫夋嫨鍥剧墖</button>
      <button class="btn" id="clearImg">鐢?emoji</button>
      <input type="file" id="fileIn" accept="image/*" class="hidden">
    </div>
    <label class="field-label">鎴栭€変竴涓?emoji</label>
    <div class="picker" id="pAvatars">${AVATARS.map((a) => `<button class="pick ${a === p.avatar && !p.img ? 'on' : ''}" data-av="${a}">${a}</button>`).join('')}</div>
    <label class="field-label">涓婚鑹?/label>
    <div class="picker" id="pColors">${COLORS.map((c) => `<button class="pick-dot ${c === p.color ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
    <label class="field-label">鐧诲綍瀵嗙爜锛堣缃悗鍙湪浠绘剰璁惧鐢ㄩ偖绠?瀵嗙爜鐧诲綍锛?/label>
    <div style="display:flex;gap:8px">
      <input class="input" id="newPw" type="password" placeholder="鑷冲皯 6 浣? autocomplete="new-password">
      <button class="btn" id="setPwBtn">璁剧疆</button>
    </div>
    <p id="pwInfo" style="font-size:11.5px;color:var(--text-4);margin-top:6px"></p>

    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="pSave" style="flex:1">淇濆瓨璧勬枡</button>
      <button class="btn" id="doLogout">閫€鍑虹櫥褰?/button>
    </div></div>`;

  const draft = DRAFT;
  const preview = () => { const el = box.querySelector('#avatarPreview'); if (el) el.innerHTML = avatarHtml(draft, 56); };
  box.querySelector('#uploadBtn').onclick = () => box.querySelector('#fileIn').click();
  box.querySelector('#fileIn').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) openAvatarEditor(f, (dataUrl) => { DRAFT = { ...(DRAFT || profile()), img: dataUrl }; saveProfile(DRAFT); refreshAuthButton(); refreshOwnPosts(DRAFT).catch(() => {}); toast('澶村儚宸蹭繚瀛?); });
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
    toast('璧勬枡宸蹭繚瀛?);
  };
  const sendBtn = document.createElement('button');
  sendBtn.className = 'btn btn-block';
  sendBtn.style.marginTop = '14px';
  sendBtn.textContent = '鎶婅繖鍙拌澶囩殑鐧诲綍鐘舵€佸悓姝ュ埌鐢佃剳';
  sendBtn.onclick = () => openRelaySend();
  setPwBtn.parentElement.parentElement.insertBefore(sendBtn, setPwBtn.parentElement.nextSibling);

  const setPwBtn = box.querySelector('#setPwBtn');
  if (setPwBtn) setPwBtn.onclick = async () => {
    const pw = box.querySelector('#newPw').value;
    const info = box.querySelector('#pwInfo');
    if (!pw || pw.length < 6) return (info.textContent = '瀵嗙爜鑷冲皯 6 浣?);
    info.textContent = '璁剧疆涓€?;
    try { await setPassword(pw); info.textContent = '鉁?瀵嗙爜宸茶缃紝鍙湪鍏朵粬璁惧鐢ㄩ偖绠?瀵嗙爜鐧诲綍'; box.querySelector('#newPw').value = ''; }
    catch (e) { info.textContent = '澶辫触锛? + e.message; }
  };

  box.querySelector('#doLogout').onclick = () => { DRAFT = null; logout(); m.hidden = true; location.reload(); };
}

export function refreshAuthButton() {
  const btn = document.getElementById('authBtn');
  if (!btn) return;
  const email = currentEmail();
  if (!email) { btn.innerHTML = '鐧诲綍'; btn.title = '鐧诲綍'; return; }
  const p = profile();
  btn.innerHTML = avatarHtml(p, 30);
  btn.title = p.name || email;
  btn.style.cssText += ';padding:0;border:0;background:transparent;';
}

/* ---------- 鍙戝笘 ---------- */
export async function openComposer(game) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  if (!currentEmail()) return openLogin();
  m.hidden = false;
  const p = profile();
  box.innerHTML = `<div class="m-body">
    <h3>鍙戝笘</h3>
    <div class="profile-head" style="margin-bottom:12px">${avatarHtml(p, 40)}
      <div><div class="profile-name">${esc(p.name || '鎴?)}</div>
      <div class="profile-mail">${game ? esc(game.name) : '鑷敱鍒嗕韩'}</div></div></div>
    <input class="input" id="postTitle" maxlength="40" placeholder="鏍囬锛堜竴鍙ヨ瘽璇存槑浣犳兂鑱婁粈涔堬級">
    ${game ? '' : '<div style="position:relative;margin-top:8px"><input class="input" id="postGame" placeholder="鍏宠仈娓告垙锛堣緭鍏ュ悕瀛楁悳绱級" autocomplete="off"><div id="gameSug" class="sugbox hidden"></div></div><div id="gamePicked" class="pickedwrap"></div>'}
    <textarea class="input" id="postBody" rows="5" placeholder="姝ｆ枃锛氳璇磋繖娓告垙鎬庝箞鏍凤紵鍊煎緱鍏ュ悧锛? style="margin-top:8px"></textarea>
    <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
      <button class="btn" id="pickImgs">锛?鍥剧墖锛堟渶澶?9 寮狅級</button>
      <span id="imgCount" style="font-size:12px;color:var(--text-4)">0/9</span>
      <input type="file" id="imgIn" accept="image/*" multiple class="hidden">
    </div>
    <div id="imgPreview" class="imgprev"></div>
    <button class="btn btn-primary btn-block" id="doPost" style="margin-top:10px">鍙戝竷</button>
    <p id="postMsg" style="font-size:12px;color:var(--text-4);margin-top:8px"></p></div>`;

  const msg = box.querySelector('#postMsg');
  let picked = game ? { id: game.id, name: game.name } : null;
  let images = [];

  const gi = box.querySelector('#postGame');
  const sug = box.querySelector('#gameSug');
  const pickedBox = box.querySelector('#gamePicked');
  const renderPicked = () => {
    if (!pickedBox) return;
    pickedBox.innerHTML = picked ? '<span class="picked">宸插叧鑱旓細' + esc(picked.name) + ' <b data-clear="1">脳</b></span>' : '';
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
            : '<div class="sug-empty">娌℃壘鍒?/div>';
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
      .map((src, i) => `<span class="thumb"><img src="${src}"><b data-rm="${i}">脳</b></span>`)
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
    if (!title) return (msg.textContent = '缁欏笘瀛愯捣涓爣棰樺惂');
    if (!body) return (msg.textContent = '鍐欑偣姝ｆ枃鍚?);
    msg.textContent = '鍙戝竷涓€?;
    try {
      await rest('/rest/v1/posts', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          title, game_id: picked ? picked.id : 0, game_name: picked ? picked.name : '闂茶亰', body,
          images, author_name: p.name, author_id: p.id, author_avatar: p.img || p.avatar, author_email: currentEmail(),
        }],
      });
      m.hidden = true;
      toast('宸插彂甯?);
      if (window.LH_COMMUNITY_REFRESH) window.LH_COMMUNITY_REFRESH();
    } catch (e) {
      msg.textContent = '鍙戝竷澶辫触锛? + e.message;
    }
  };
}

/* ---------- 浣滆€呬富椤?---------- */
export async function openAuthor(name, uid) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  box.innerHTML = `<div class="m-body"><h3>${esc(name)}</h3><p style="color:var(--text-4);font-size:12px">璇诲彇涓€?/p></div>`;
  try {
    const filter = uid ? `author_id=eq.${uid}` : `author_name=eq.${encodeURIComponent(name)}`;
    const rows = await rest(`/rest/v1/posts?select=id,title,game_name,body,author_avatar,author_id,created_at&` + filter + `&order=created_at.desc&limit=20`);
    const av = rows[0]?.author_avatar || '馃幃';
    box.innerHTML = `<div class="m-body">
      <div class="profile-head">${avatarHtml({ avatar: av.startsWith('data:') ? '馃幃' : av, img: av.startsWith('data:') ? av : '' }, 56)}
        <div><div class="profile-name">${esc(name)}<span class="post-uid">#${uid || (rows[0] && rows[0].author_id) || '----'}</span></div>
        <div class="profile-mail">${rows.length} 绡囧笘瀛?/div></div></div>
      ${rows.map((x) => `<div class="author-post"><b>${esc(x.title || '鏃犳爣棰?)}</b>
        <div class="post-meta">${esc(x.game_name)} 路 ${timeAgo(x.created_at)}</div>
        <p class="post-body" style="margin:6px 0 0">${esc(x.body)}</p></div>`).join('')}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="m-body"><h3>${esc(name)}</h3><p style="color:var(--text-3)">璇诲彇澶辫触锛?{esc(e.message)}</p></div>`;
  }
}

function toast(t) { if (window.LH_TOAST) return window.LH_TOAST(t); }

/* ---------- 绀惧尯 ---------- */
const PAGE_KEY = 'lh.pageSize';
function pageSize() { return Number(localStorage.getItem(PAGE_KEY) || 10); }
let PAGE = 0;
let VIEW = 'list';
let CUR = null;

export async function renderCommunity(root) {
  if (!isConfigured()) {
    root.innerHTML = `<div class="empty-state"><span class="big">馃З</span>绀惧尯杩樻病鎺ュ悗绔€?/div>`;
    return;
  }
  if (VIEW === 'detail' && CUR) return renderDetail(root);
  await renderList(root);
}

async function renderList(root) {
  const size = pageSize();
  const loginHint = window.__LH_LOGIN_URL
    ? '<div class="login-sync"><span>鉁?宸茬櫥褰曘€傛兂鍦ㄧ數鑴戜笂涔熺櫥褰曪紵</span><button class="btn btn-sm" id="copyLoginUrl">澶嶅埗鐧诲綍閾炬帴</button><b data-hide-hint="1">脳</b></div>'
    : '';

  root.innerHTML = loginHint + `<div class="cmt-bar">
      <button class="btn btn-primary" id="newPost">锛?鍙戝笘</button>
      <button class="btn" id="myProfile">鎴戠殑璧勬枡</button>
      <span class="cmt-hint">鐐瑰笘瀛愯繘鍏ヨ鎯咃紝鍙湅鍥句笌璇勮</span>
      <span class="page-set">姣忛〉
        <select id="pageSizeSel" class="input sm" style="width:auto;display:inline-block">
          ${[10, 20, 30, 50].map((n) => `<option value="${n}" ${n === size ? 'selected' : ''}>${n}</option>`).join('')}
        </select> 鏉?      </span>
    </div><div id="postList"><div class="empty-state"><span class="spin"></span></div></div>
    <div class="pager"><button class="btn btn-sm" id="prevPage">涓婁竴椤?/button><span id="pageInfo"></span><button class="btn btn-sm" id="nextPage">涓嬩竴椤?/button></div>`;

  const cp = root.querySelector('#copyLoginUrl');
  if (cp) {
    cp.onclick = async () => {
      try {
        await navigator.clipboard.writeText(window.__LH_LOGIN_URL);
        cp.textContent = '宸插鍒?;
      } catch {
        prompt('鎵嬪姩澶嶅埗杩欎釜閾炬帴鍒扮數鑴戞墦寮€锛?, window.__LH_LOGIN_URL);
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
      list.innerHTML = '<div class="empty-state">鐧诲綍宸茶繃鏈?br><span style="font-size:12px;color:var(--text-4)">閲嶆柊鐧诲綍鍚庡嵆鍙仮澶?/span><br><br>' +
        '<button class="btn btn-primary" id="relogin">閲嶆柊鐧诲綍</button></div>';
      const b = list.querySelector('#relogin');
      if (b) b.onclick = () => openLogin();
      return;
    }
    list.innerHTML = '<div class="empty-state">璇诲彇澶辫触锛? + esc(msg) + '</div>';
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
  root.querySelector('#pageInfo').textContent = '绗?' + (PAGE + 1) + ' 椤?;
  root.querySelector('#prevPage').disabled = PAGE === 0;
  root.querySelector('#prevPage').onclick = () => { if (PAGE > 0) { PAGE -= 1; renderList(root); } };
  root.querySelector('#nextPage').disabled = posts.length < size;
  root.querySelector('#nextPage').onclick = () => { if (posts.length === size) { PAGE += 1; renderList(root); } };

  if (!posts.length) {
    list.innerHTML = `<div class="empty-state"><span class="big">馃尡</span>${PAGE === 0 ? '杩樻病鏈変汉鍙戝笘銆傜偣銆岋紜 鍙戝笘銆嶅啓绗竴鏉? : '杩欎竴椤垫病鏈夊唴瀹逛簡'}</div>`;
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
        <span class="post-meta">${esc(x.author_name)} 路 ${timeAgo(x.created_at)}</span>
      </header>
      ${x.title ? `<h4 class="post-title">${esc(x.title)}</h4>` : ''}
      <p class="post-body">${esc(x.body).slice(0, 160)}${x.body.length > 160 ? '鈥? : ''}</p>
      ${imgs.length ? `<div class="imgs">${imgs.slice(0, 4).map((src) => `<img src="${src}">`).join('')}${imgs.length > 4 ? `<span class="more-img">+${imgs.length - 4}</span>` : ''}</div>` : ''}
      <div class="post-foot">
        <button class="like ${liked ? 'on' : ''}" data-like="${x.id}">${liked ? '鈾? : '鈾?} ${n || ''}</button>
        <span class="cmt-n">璇勮</span>
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
      btn.innerHTML = (wasOn ? '鈾? : '鈾?) + (next ? ' ' + next : '');
      try {
        if (wasOn) await rest(`/rest/v1/post_likes?post_id=eq.${id}&user_email=eq.${encodeURIComponent(currentEmail())}`, { method: 'DELETE' });
        else await rest('/rest/v1/post_likes', { method: 'POST', body: [{ post_id: id, user_email: currentEmail() }] });
      } catch (e) {
        btn.classList.toggle('on', wasOn);
        btn.innerHTML = (wasOn ? '鈾? : '鈾?) + (cur ? ' ' + cur : '');
        toast('鎿嶄綔澶辫触锛? + e.message);
      }
    };
  });
}

function avatarOf(x) {
  const a = x.author_avatar || '';
  return a.startsWith('data:') ? { avatar: '馃幃', img: a } : { avatar: a || '馃幃', img: '' };
}

async function renderDetail(root) {
  const x = CUR;
  if (!x) { VIEW = 'list'; return renderList(root); }
  const av = avatarOf(x);
  const imgs = Array.isArray(x.images) ? x.images : [];
  root.innerHTML = `<div class="cmt-bar">
      <button class="btn" id="backBtn">鈫?杩斿洖绀惧尯</button>
      <span style="flex:1"></span>
      <button class="btn btn-sm" id="delPost" style="display:none">鍒犻櫎甯栧瓙</button>
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
      <div class="post-foot"><span class="cmt-n">鍔犺浇璇勮涓€?/span><span id="likeSlot"></span></div>
      <div id="cmtList" class="post-comments"></div>
      <div class="cmt-add">
        <input class="input sm" id="cmtInput" placeholder="璇勮涓ゅ彞鈥?>
        <button class="btn btn-sm" id="cmtSend">鍙戦€?/button>
      </div>
    </article>`;

  root.querySelector('#backBtn').onclick = () => { VIEW = 'list'; CUR = null; renderCommunity(root); };

  const delBtn = root.querySelector('#delPost');
  const emailNow = currentEmail();
  const canDel = emailNow && (x.author_email === emailNow || (!x.author_email && x.author_name === profile().name));
  if (delBtn && canDel) {
    delBtn.style.display = '';
    delBtn.onclick = async () => {
      if (!confirm('鍒犻櫎杩欐潯甯栧瓙锛?)) return;
      delBtn.disabled = true;
      try {
        await rest('/rest/v1/posts?id=eq.' + x.id, { method: 'DELETE' });
        toast('宸插垹闄?);
        VIEW = 'list';
        CUR = null;
        renderCommunity(root);
      } catch (e) {
        toast('鍒犻櫎澶辫触锛? + e.message);
        delBtn.disabled = false;
      }
    };
  }
  root.querySelector('[data-author]').onclick = () => openAuthor(x.author_name, x.author_id);

  // 鐐硅禐
  try {
    const ls = await rest(`/rest/v1/post_likes?select=user_email&post_id=eq.${x.id}`) || [];
    const email = currentEmail();
    const liked = email && ls.some((l) => l.user_email === email);
    root.querySelector('#likeSlot').innerHTML = `<button class="like ${liked ? 'on' : ''}" id="detailLike">${liked ? '鈾? : '鈾?} ${ls.length || ''}</button>`;
    root.querySelector('#detailLike').onclick = async (ev) => {
      if (!email) return openLogin();
      const btn = ev.currentTarget;
      btn.disabled = true;
      const next = liked ? Math.max(0, ls.length - 1) : ls.length + 1;
      btn.classList.toggle('on', !liked);
      btn.innerHTML = (liked ? '鈾? : '鈾?) + (next ? ' ' + next : '');
      try {
        if (liked) await rest(`/rest/v1/post_likes?post_id=eq.${x.id}&user_email=eq.${encodeURIComponent(email)}`, { method: 'DELETE' });
        else await rest('/rest/v1/post_likes', { method: 'POST', body: [{ post_id: x.id, user_email: email }] });
      } catch (e) {
        btn.classList.toggle('on', liked);
        btn.innerHTML = (liked ? '鈾? : '鈾?) + (ls.length ? ' ' + ls.length : '');
        toast('澶辫触');
      }
    };
  } catch {}

  // 璇勮
  const cmtList = root.querySelector('#cmtList');
  try {
    const cs = await rest(`/rest/v1/comments?select=id,body,author_name,author_email,created_at&post_id=eq.${x.id}&order=created_at.asc`) || [];
    cmtList.innerHTML = cs.map((c) => {
      const canDel = currentEmail() && c.author_email === currentEmail();
      return `<div class="cmt">
        <b>${esc(c.author_name)}</b> ${esc(c.body)}
        <span class="cmt-time">${timeAgo(c.created_at)}</span>
        ${canDel ? `<button class="cmt-del" data-delc="${c.id}">鍒犻櫎</button>` : ''}
      </div>`;
    }).join('') || '<div class="cmt" style="color:var(--text-4)">杩樻病鏈夎瘎璁?/div>';
    cmtList.querySelectorAll('[data-delc]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('鍒犻櫎杩欐潯璇勮锛?)) return;
        try { await rest(`/rest/v1/comments?id=eq.${b.dataset.delc}`, { method: 'DELETE' }); renderDetail(root); }
        catch (e) { toast('鍒犻櫎澶辫触锛? + e.message); }
      };
    });
    root.querySelector('#cmtSend').onclick = async () => {
      if (!currentEmail()) return openLogin();
      const v = root.querySelector('#cmtInput').value.trim();
      if (!v) return;
      try {
        await rest('/rest/v1/comments', { method: 'POST', body: [{ post_id: x.id, body: v, author_name: profile().name, author_email: currentEmail() }] });
        renderDetail(root);
      } catch (e) { toast('璇勮澶辫触'); }
    };
  } catch (e) {
    cmtList.innerHTML = `<div class="cmt">璇勮璇诲彇澶辫触锛?{esc(e.message)}</div>`;
  }
}


/* ================= 璁惧閰嶅涓浆 ================= */
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
const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function encryptPayload(code, obj) {
  const key = await deriveKey(code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return b64(iv) + '.' + b64(ct);
}
async function decryptPayload(code, payload) {
  const [ivB64, ctB64] = String(payload).split('.');
  const key = await deriveKey(code);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, unb64(ctB64));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** 鐢佃剳绔細鐢熸垚閰嶅鐮佸苟绛夊緟鎵嬫満閫佹潵浼氳瘽 */
export function openRelayReceive() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  const code = randCode(6);
  const secret = randSecret();
  const expires = new Date(Date.now() + 120000).toISOString();

  box.innerHTML = '<div class="m-body"><h3>鎵嬫満 鈫?鐢佃剳</h3>' +
    '<p style="color:var(--text-3);font-size:13px;margin:8px 0 12px">鍦?b>宸茬櫥褰曠殑鎵嬫満</b>涓婃墦寮€銆屾垜鐨勮处鍙?鈫?鍚屾鍒扮數鑴戙€嶏紝杈撳叆涓嬮潰鐨勯厤瀵圭爜銆?/p>' +
    '<div class="relay-code">' + code + '</div>' +
    '<p id="relayMsg" style="font-size:12px;color:var(--text-4);margin-top:10px">绛夊緟涓€︼紙120 绉掑唴鏈夋晥锛?/p></div>';

  const msg = box.querySelector('#relayMsg');
  rest('/rest/v1/login_relay', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: [{ code, secret, expires_at: expires }],
  }).catch(() => { msg.textContent = '鍒涘缓澶辫触锛氳鍏堝湪 Supabase 寤?login_relay 琛?; });

  let stopped = false;
  const t0 = Date.now();
  const tick = async () => {
    if (stopped) return;
    if (Date.now() - t0 > 125000) { msg.textContent = '宸茶秴鏃讹紝閲嶆柊鎵撳紑鍐嶆潵涓€娆?; return; }
    try {
      const res = await rest('/rest/v1/rpc/relay_claim', { method: 'POST', body: { p_secret: secret } });
      const payload = typeof res === 'string' ? res : (res && res.value);
      if (payload) {
        const sess = await decryptPayload(code, payload);
        localStorage.setItem(AUTH_SAVE, JSON.stringify(sess));
        stopped = true;
        msg.textContent = '鉁?宸叉帴鏀讹紝姝ｅ湪鐧诲綍鈥?;
        setTimeout(() => location.reload(), 600);
        return;
      }
    } catch {}
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 1500);
}

/** 鎵嬫満绔細鎶婂綋鍓嶄細璇濆彂鍒版寚瀹氶厤瀵圭爜 */
export function openRelaySend() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  const s = session();
  if (!s || !s.access_token) return openLogin();
  m.hidden = false;
  box.innerHTML = '<div class="m-body"><h3>鍚屾鍒扮數鑴?/h3>' +
    '<p style="color:var(--text-3);font-size:13px;margin:8px 0 12px">杈撳叆鐢佃剳涓婃樉绀虹殑 6 浣嶉厤瀵圭爜銆?/p>' +
    '<input class="input" id="relayInput" maxlength="6" placeholder="A7K2M9" style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-size:20px">' +
    '<button class="btn btn-primary btn-block" id="relayGo" style="margin-top:10px">鍙戦€佷細璇?/button>' +
    '<p id="relaySendMsg" style="font-size:12px;color:var(--text-4);margin-top:10px"></p></div>';

  const msg = box.querySelector('#relaySendMsg');
  box.querySelector('#relayGo').onclick = async () => {
    const code = (box.querySelector('#relayInput').value || '').trim().toUpperCase();
    if (code.length !== 6) return (msg.textContent = '閰嶅鐮佹槸 6 浣?);
    msg.textContent = '鍙戦€佷腑鈥?;
    try {
      const payload = await encryptPayload(code, s);
      await rest('/rest/v1/rpc/relay_post', { method: 'POST', body: { p_code: code, p_payload: payload } });
      msg.textContent = '鉁?宸插彂閫侊紝鍥炵數鑴戜笂鐪?;
    } catch (e) {
      msg.textContent = '澶辫触锛? + e.message;
    }
  };
}

/** 蹇樿瀵嗙爜锛氬彂鎭㈠閭欢 */
export async function recoverPassword(email) {
  const cfg = window.LIGHTHOUSE_SUPABASE || {};
  const res = await fetch(cfg.url + '/auth/v1/recover', {
    method: 'POST',
    headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message || '鍙戦€佸け璐?);
  }
  return true;
}
