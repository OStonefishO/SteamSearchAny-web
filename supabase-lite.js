// 轻量 Supabase 客户端（零依赖）：邮箱验证码登录 + REST + 社区读写
// 没配置时全部降级为「未启用」，不影响现有功能

const CFG = () => (window.LIGHTHOUSE_SUPABASE || {});
export const isConfigured = () => {
  const c = CFG();
  return Boolean(c.url && c.anonKey);
};

const H = () => ({ apikey: CFG().anonKey, Authorization: `Bearer ${session()?.access_token || CFG().anonKey}` });

const SKEY = 'lh.auth';
export function session() {
  try {
    return JSON.parse(localStorage.getItem(SKEY) || 'null');
  } catch {
    return null;
  }
}
function saveSession(s) {
  try {
    if (s) localStorage.setItem(SKEY, JSON.stringify(s));
    else localStorage.removeItem(SKEY);
  } catch {}
}

export function currentEmail() {
  return session()?.email || null;
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const c = CFG();
  if (!isConfigured()) throw new Error('未配置后端');
  const res = await fetch(`${c.url}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...H(), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.msg || data?.message || data?.error_description || `HTTP ${res.status}`);
  return data;
}

// ---------- 登录 ----------
export async function sendCode(email) {
  // 带上当前页面地址，邮件链接就会回到这里（而不是 Supabase 后台的 Site URL）
  const back = encodeURIComponent(location.origin + location.pathname);
  return call('/auth/v1/otp?redirect_to=' + back, { method: 'POST', body: { email, create_user: true } });
}

export async function verifyCode(email, token) {
  const data = await call('/auth/v1/verify', { method: 'POST', body: { email, token, type: 'email' } });
  const s = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    email: data.user?.email || email,
    uid: data.user?.id,
  };
  saveSession(s);
  return s;
}

export function logout() {
  saveSession(null);
}

// ---------- 社区 ----------
export async function listPosts(limit = 30) {
  const rows = await call(
    `/rest/v1/posts?select=id,game_id,game_name,body,author_name,created_at&order=created_at.desc&limit=${limit}`
  );
  return rows || [];
}

export async function createPost({ gameId, gameName, body, authorName }) {
  const s = session();
  if (!s) throw new Error('请先登录');
  return call('/rest/v1/posts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: [{ game_id: gameId, game_name: gameName, body, author_name: authorName || s.email.split('@')[0] }],
  });
}

export async function listComments(postIds) {
  if (!postIds.length) return [];
  const rows = await call(
    `/rest/v1/comments?select=id,post_id,body,author_name,created_at&post_id=in.(${postIds.join(',')})&order=created_at.asc`
  );
  return rows || [];
}

export async function createComment({ postId, body, authorName }) {
  const s = session();
  if (!s) throw new Error('请先登录');
  return call('/rest/v1/comments', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: [{ post_id: postId, body, author_name: authorName || s.email.split('@')[0] }],
  });
}

// 点邮件链接回调：Supabase 会把 access_token / refresh_token 放在 URL hash 里
export function captureHashSession() {
  try {
    const h = location.hash || '';
    if (!h.includes('access_token=')) return false;
    const p = new URLSearchParams(h.replace(/^#/, ''));
    const access = p.get('access_token');
    const refresh = p.get('refresh_token');
    const expires = Number(p.get('expires_in') || 3600);
    if (!access) return false;
    saveSession({
      access_token: access,
      refresh_token: refresh,
      expires_at: Date.now() + expires * 1000,
      email: p.get('email') || null,
      uid: null,
    });
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  } catch {
    return false;
  }
}

/** 用 access_token 反查邮箱（用来在顶栏显示昵称） */
export async function fillEmailFromUser() {
  const s = session();
  if (!s || s.email || !s.access_token) return s;
  try {
    const data = await call('/auth/v1/user', { method: 'GET' });
    if (data && data.email) {
      s.email = data.email;
      saveSession(s);
    }
  } catch {}
  return session();
}
