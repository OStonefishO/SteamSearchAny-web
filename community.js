// 社区与账号（含头像/昵称、主动发帖）
import { isConfigured, sendCode, verifyCode, logout, currentEmail, listPosts, createPost, listComments, createComment, captureHashSession, fillEmailFromUser } from './supabase-lite.js';

try { if (captureHashSession()) fillEmailFromUser(); } catch {}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeAgo = (iso) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
};

const PK = 'lh.profile';
export function profile() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(PK) || '{}'); } catch {}
  const email = currentEmail() || '';
  return {
    name: p.name || (email ? email.split('@')[0] : ''),
    avatar: p.avatar || '🎮',
    color: p.color || '#45bdf7',
  };
}
function saveProfile(p) {
  try { localStorage.setItem(PK, JSON.stringify(p)); } catch {}
}

const AVATARS = ['🎮', '🕹️', '👾', '🚀', '🌌', '🐱', '🦊', '🐳', '🌙', '⭐', '🔥', '🎧'];
const COLORS = ['#45bdf7', '#b6e04a', '#ffb04d', '#f4736f', '#a78bfa', '#34d399', '#f472b6'];

let posts = [];
let comments = new Map();

export function authLabel() {
  if (!isConfigured()) return '登录';
  const email = currentEmail();
  if (!email) return '登录';
  return profile().name || email.split('@')[0];
}

/* ---------------- 账号面板 ---------------- */
export function openLogin() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  const email = currentEmail();

  if (!isConfigured()) {
    box.innerHTML = `<div class="m-body"><h3>还没有接后端</h3>
      <p style="color:var(--text-3);font-size:13px;margin-top:8px">把 Supabase 的地址和 anon key 填进 <code>public/config.js</code> 即可启用登录与社区。</p></div>`;
    return;
  }

  if (!email) {
    box.innerHTML = `<div class="m-body">
      <h3>邮箱登录</h3>
      <p style="color:var(--text-3);font-size:13px;margin:8px 0 14px">输入邮箱，会收到一封带登录链接的邮件 —— 点开就能登录（也可以把邮件里的 6 位码贴进来）。</p>
      <input class="input" id="authEmail" type="email" placeholder="you@example.com" autocomplete="email">
      <button class="btn btn-primary btn-block" id="sendCode" style="margin-top:10px">发送邮件</button>
      <div id="codeBox" class="hidden" style="margin-top:14px">
        <input class="input" id="authCode" inputmode="numeric" placeholder="6 位验证码（可选）" maxlength="8">
        <button class="btn btn-block" id="doVerify" style="margin-top:10px">用验证码登录</button>
      </div>
      <p id="authMsg" style="font-size:12px;color:var(--text-4);margin-top:10px"></p>
    </div>`;

    const msg = box.querySelector('#authMsg');
    box.querySelector('#sendCode').onclick = async () => {
      const em = box.querySelector('#authEmail').value.trim();
      if (!em) return (msg.textContent = '请填邮箱');
      msg.textContent = '发送中…';
      try {
        await sendCode(em);
        box.querySelector('#codeBox').classList.remove('hidden');
        msg.textContent = '邮件已发送，点链接即可登录（或粘贴验证码）';
      } catch (e) {
        msg.textContent = '发送失败：' + e.message;
      }
    };
    box.querySelector('#doVerify').onclick = async () => {
      const em = box.querySelector('#authEmail').value.trim();
      const code = box.querySelector('#authCode').value.trim();
      if (!code) return (msg.textContent = '请填验证码');
      msg.textContent = '验证中…';
      try {
        await verifyCode(em, code);
        m.hidden = true;
        location.reload();
      } catch (e) {
        msg.textContent = '登录失败：' + e.message;
      }
    };
    return;
  }

  // 已登录：个人资料
  const p = profile();
  box.innerHTML = `<div class="m-body">
    <h3>我的账号</h3>
    <div class="profile-head">
      <div class="avatar" id="avatarPreview" style="background:${esc(p.color)}1f;border-color:${esc(p.color)}55">${esc(p.avatar)}</div>
      <div>
        <div class="profile-name" id="namePreview">${esc(p.name || email.split('@')[0])}</div>
        <div class="profile-mail">${esc(email)}</div>
      </div>
    </div>

    <label class="field-label">昵称</label>
    <input class="input" id="pName" maxlength="16" value="${esc(p.name)}" placeholder="给自己起个名字">

    <label class="field-label">头像</label>
    <div class="picker" id="pAvatars">
      ${AVATARS.map((a) => `<button class="pick ${a === p.avatar ? 'on' : ''}" data-av="${a}">${a}</button>`).join('')}
    </div>

    <label class="field-label">主题色</label>
    <div class="picker" id="pColors">
      ${COLORS.map((c) => `<button class="pick-dot ${c === p.color ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}
    </div>

    <div style="display:flex;gap:8px;margin-top:16px">
      <button class="btn btn-primary" id="pSave" style="flex:1">保存资料</button>
      <button class="btn" id="doLogout">退出登录</button>
    </div>
    <p style="font-size:11.5px;color:var(--text-4);margin-top:8px">资料只存在本机浏览器，发帖时用作署名。</p>
  </div>`;

  let draft = { ...p };
  box.querySelector('#pAvatars').onclick = (e) => {
    const b = e.target.closest('[data-av]');
    if (!b) return;
    draft.avatar = b.dataset.av;
    box.querySelectorAll('#pAvatars .pick').forEach((x) => x.classList.toggle('on', x.dataset.av === draft.avatar));
    const av = box.querySelector('#avatarPreview');
    av.textContent = draft.avatar;
  };
  box.querySelector('#pColors').onclick = (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    draft.color = b.dataset.c;
    box.querySelectorAll('#pColors .pick-dot').forEach((x) => x.classList.toggle('on', x.dataset.c === draft.color));
    const av = box.querySelector('#avatarPreview');
    av.style.background = draft.color + '1f';
    av.style.borderColor = draft.color + '55';
  };
  box.querySelector('#pSave').onclick = () => {
    draft.name = (box.querySelector('#pName').value || '').trim().slice(0, 16) || email.split('@')[0];
    saveProfile(draft);
    m.hidden = true;
    refreshAuthButton();
    toast('资料已保存');
    if (window.LH_COMMUNITY_REFRESH) window.LH_COMMUNITY_REFRESH();
  };
  box.querySelector('#doLogout').onclick = () => {
    logout();
    m.hidden = true;
    location.reload();
  };
}

export function refreshAuthButton() {
  const btn = document.getElementById('authBtn');
  if (!btn) return;
  const label = authLabel();
  btn.textContent = label;
  btn.title = currentEmail() ? '我的账号' : '登录';
}

/* ---------------- 发帖 ---------------- */
export async function openComposer(game) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  if (!currentEmail()) {
    openLogin();
    return;
  }
  m.hidden = false;

  const p = profile();
  box.innerHTML = `<div class="m-body">
    <h3>发帖</h3>
    <div class="profile-head" style="margin-bottom:12px">
      <div class="avatar" style="background:${esc(p.color)}1f;border-color:${esc(p.color)}55">${esc(p.avatar)}</div>
      <div>
        <div class="profile-name">${esc(p.name || '我')}</div>
        <div class="profile-mail">${game ? esc(game.name) : '自由分享'}</div>
      </div>
    </div>
    ${game ? '' : `<input class="input" id="postGame" placeholder="关联的游戏名（可留空）">`}
    <textarea class="input" id="postBody" rows="5" placeholder="说说这游戏怎么样？值得入吗？" style="margin-top:10px"></textarea>
    <button class="btn btn-primary btn-block" id="doPost" style="margin-top:10px">发布</button>
    <p id="postMsg" style="font-size:12px;color:var(--text-4);margin-top:8px"></p>
  </div>`;

  const msg = box.querySelector('#postMsg');
  box.querySelector('#doPost').onclick = async () => {
    const body = box.querySelector('#postBody').value.trim();
    if (!body) return (msg.textContent = '写点什么吧');
    const gname = game ? game.name : (box.querySelector('#postGame').value.trim() || '闲聊');
    const gid = game ? game.id : 0;
    msg.textContent = '发布中…';
    try {
      await createPost({ gameId: gid, gameName: gname, body, authorName: p.name });
      m.hidden = true;
      toast('已发布');
      if (window.LH_COMMUNITY_REFRESH) window.LH_COMMUNITY_REFRESH();
    } catch (e) {
      msg.textContent = '发布失败：' + e.message;
    }
  };
}

function toast(t) {
  if (window.LH_TOAST) return window.LH_TOAST(t);
  console.log(t);
}

/* ---------------- 社区列表 ---------------- */
export async function renderCommunity(root) {
  if (!isConfigured()) {
    root.innerHTML = `<div class="empty-state"><span class="big">🧩</span>社区还没接后端。</div>`;
    return;
  }

  const p = profile();
  const bar = `<div class="cmt-bar">
      <button class="btn btn-primary" id="newPost">＋ 发帖</button>
      <span class="cmt-hint">${currentEmail() ? '你可以自由分享，也可以从游戏详情里分享' : '登录后即可发帖与评论'}</span>
    </div>`;

  root.innerHTML = bar + `<div id="postList"><div class="empty-state"><span class="spin"></span></div></div>`;
  root.querySelector('#newPost').onclick = () => (currentEmail() ? openComposer(null) : openLogin());

  const list = root.querySelector('#postList');
  try {
    posts = await listPosts(30);
    comments = new Map();
    if (posts.length) {
      const rows = await listComments(posts.map((x) => x.id));
      for (const c of rows) {
        if (!comments.has(c.post_id)) comments.set(c.post_id, []);
        comments.get(c.post_id).push(c);
      }
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-state">读取失败：${esc(e.message)}</div>`;
    return;
  }

  if (!posts.length) {
    list.innerHTML = `<div class="empty-state"><span class="big">🌱</span>还没有人发帖。<br>
      <span style="font-size:12px;color:var(--text-4)">点上面「＋ 发帖」，或在任意游戏详情里点「分享到社区」</span></div>`;
    return;
  }

  list.innerHTML = posts
    .map((x) => {
      const cs = comments.get(x.id) || [];
      return `<article class="post">
      <header>
        <span class="post-avatar" style="background:${esc(p.color)}1f">${esc(p.avatar)}</span>
        <a class="post-game" href="${x.game_id ? '?info=' + x.game_id : '#'}">${esc(x.game_name)}</a>
        <span class="post-meta">${esc(x.author_name)} · ${timeAgo(x.created_at)}</span>
      </header>
      <p class="post-body">${esc(x.body)}</p>
      <div class="post-comments">
        ${cs.map((c) => `<div class="cmt"><b>${esc(c.author_name)}</b> ${esc(c.body)}</div>`).join('')}
        <div class="cmt-add">
          <input class="input sm" data-cmt-input="${x.id}" placeholder="评论两句…">
          <button class="btn btn-sm" data-cmt-send="${x.id}">发送</button>
        </div>
      </div>
    </article>`;
    })
    .join('');

  list.querySelectorAll('[data-cmt-send]').forEach((btn) => {
    btn.onclick = async () => {
      if (!currentEmail()) return openLogin();
      const id = Number(btn.dataset.cmtSend);
      const input = list.querySelector(`[data-cmt-input="${id}"]`);
      const body = input.value.trim();
      if (!body) return;
      btn.disabled = true;
      try {
        await createComment({ postId: id, body, authorName: profile().name });
        input.value = '';
        renderCommunity(root);
      } catch (e) {
        toast('评论失败');
        btn.disabled = false;
      }
    };
  });
}
