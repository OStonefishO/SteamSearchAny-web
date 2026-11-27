// 社区与登录界面（无框架，挂到主应用上）
import { isConfigured, sendCode, verifyCode, logout, currentEmail, listPosts, createPost, listComments, createComment } from './supabase-lite.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const timeAgo = (iso) => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return '刚刚';
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  return `${Math.floor(d / 86400)} 天前`;
};

let posts = [];
let comments = new Map();

export function authLabel() {
  const email = currentEmail();
  if (!isConfigured()) return '未配置';
  return email ? email.split('@')[0] : '登录';
}

export function openLogin() {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m) return;
  m.hidden = false;
  const email = currentEmail();

  if (!isConfigured()) {
    box.innerHTML = `<div class="m-body" style="padding:24px">
      <h3>还没有接后端</h3>
      <p style="color:var(--text-3);font-size:13px;margin-top:8px">
        登录和社区需要一个免费后端（Supabase）。注册一个项目后，把地址和 anon key 填进
        <code>public/config.js</code>，这里的按钮就会变成真的。
      </p>
      <pre style="margin-top:12px;padding:10px;background:#0a1219;border:1px solid var(--line);border-radius:8px;font-size:12px;overflow:auto">window.LIGHTHOUSE_SUPABASE = {
  url: 'https://xxxx.supabase.co',
  anonKey: 'eyJhbGciOi...'
};</pre>
      <p style="color:var(--text-4);font-size:12px;margin-top:10px">
        建表 SQL 已经写好在仓库的 <code>db/schema.sql</code>，粘到 Supabase SQL Editor 执行即可。
      </p>
    </div>`;
    return;
  }

  if (email) {
    box.innerHTML = `<div class="m-body" style="padding:24px">
      <h3>已登录</h3>
      <p style="margin-top:8px;color:var(--text-2)">${esc(email)}</p>
      <button class="btn" id="doLogout" style="margin-top:16px">退出登录</button>
    </div>`;
    box.querySelector('#doLogout').onclick = () => {
      logout();
      m.hidden = true;
      location.reload();
    };
    return;
  }

  box.innerHTML = `<div class="m-body" style="padding:24px">
    <h3>邮箱登录</h3>
    <p style="color:var(--text-3);font-size:13px;margin:8px 0 14px">输入邮箱收验证码，不用设密码。</p>
    <input class="input" id="authEmail" type="email" placeholder="you@example.com" autocomplete="email">
    <button class="btn btn-primary btn-block" id="sendCode" style="margin-top:10px">发送验证码</button>
    <div id="codeBox" class="hidden" style="margin-top:14px">
      <input class="input" id="authCode" inputmode="numeric" placeholder="6 位验证码" maxlength="8">
      <button class="btn btn-primary btn-block" id="doVerify" style="margin-top:10px">登录</button>
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
      msg.textContent = '验证码已发送，检查邮箱（含垃圾箱）';
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
}

export function openComposer(game) {
  const m = document.getElementById('modal');
  const box = document.getElementById('modalContent');
  if (!m || !game) return;
  m.hidden = false;
  box.innerHTML = `<div class="m-body" style="padding:24px">
    <h3>分享到社区</h3>
    <p style="color:var(--text-3);font-size:13px;margin:8px 0 12px">${esc(game.name)}</p>
    <textarea class="input" id="postBody" rows="5" placeholder="说说这游戏怎么样？值得入吗？"></textarea>
    <button class="btn btn-primary btn-block" id="doPost" style="margin-top:10px">发布</button>
    <p id="postMsg" style="font-size:12px;color:var(--text-4);margin-top:8px"></p>
  </div>`;
  const msg = box.querySelector('#postMsg');
  box.querySelector('#doPost').onclick = async () => {
    const body = box.querySelector('#postBody').value.trim();
    if (!body) return (msg.textContent = '写点什么吧');
    msg.textContent = '发布中…';
    try {
      await createPost({ gameId: game.id, gameName: game.name, body });
      m.hidden = true;
      toast('已发布');
      if (window.LH_COMMUNITY_REFRESH) window.LH_COMMUNITY_REFRESH();
    } catch (e) {
      msg.textContent = e.message === '请先登录' ? '请先点右上角登录' : '发布失败：' + e.message;
    }
  };
}

function toast(t) {
  if (window.LH_TOAST) return window.LH_TOAST(t);
  console.log(t);
}

export async function renderCommunity(root) {
  root.innerHTML = `<div class="empty-state"><span class="spin"></span></div>`;
  if (!isConfigured()) {
    root.innerHTML = `<div class="empty-state"><span class="big">🧩</span>
      社区还没接后端。<br><span style="font-size:12px;color:var(--text-4)">点右上角「未配置」看怎么开（一分钟的事）</span></div>`;
    return;
  }
  try {
    posts = await listPosts(30);
    comments = new Map();
    if (posts.length) {
      const rows = await listComments(posts.map((p) => p.id));
      for (const c of rows) {
        if (!comments.has(c.post_id)) comments.set(c.post_id, []);
        comments.get(c.post_id).push(c);
      }
    }
  } catch (e) {
    root.innerHTML = `<div class="empty-state">读取失败：${esc(e.message)}</div>`;
    return;
  }

  if (!posts.length) {
    root.innerHTML = `<div class="empty-state"><span class="big">🌱</span>还没有人发帖。<br>
      <span style="font-size:12px;color:var(--text-4)">在任意游戏详情里点「分享到社区」就是第一条</span></div>`;
    return;
  }

  root.innerHTML = posts
    .map((p) => {
      const cs = comments.get(p.id) || [];
      return `<article class="post" data-post="${p.id}">
      <header>
        <a class="post-game" href="?info=${p.game_id}">${esc(p.game_name)}</a>
        <span class="post-meta">${esc(p.author_name)} · ${timeAgo(p.created_at)}</span>
      </header>
      <p class="post-body">${esc(p.body)}</p>
      <div class="post-comments">
        ${cs.map((c) => `<div class="cmt"><b>${esc(c.author_name)}</b> ${esc(c.body)}</div>`).join('')}
        <div class="cmt-add">
          <input class="input sm" data-cmt-input="${p.id}" placeholder="评论两句…">
          <button class="btn btn-sm" data-cmt-send="${p.id}">发送</button>
        </div>
      </div>
    </article>`;
    })
    .join('');

  root.querySelectorAll('[data-cmt-send]').forEach((btn) => {
    btn.onclick = async () => {
      const id = Number(btn.dataset.cmtSend);
      const input = root.querySelector(`[data-cmt-input="${id}"]`);
      const body = input.value.trim();
      if (!body) return;
      btn.disabled = true;
      try {
        await createComment({ postId: id, body });
        input.value = '';
        renderCommunity(root);
      } catch (e) {
        toast(e.message === '请先登录' ? '请先登录' : '评论失败');
        btn.disabled = false;
      }
    };
  });
}
