// 后端配置：填上就能启用邮箱登录与社区
// 1) 注册 https://supabase.com（免费）→ New project
// 2) Project Settings → API：复制 Project URL 与 anon public key
// 3) SQL Editor 里执行仓库的 db/schema.sql
// 4) 把下面两个值填好，重新构建即可
window.LIGHTHOUSE_SUPABASE = {
  url: '',      // 例：https://abcdefghijk.supabase.co
  anonKey: '',  // 例：eyJhbGciOiJIUzI1NiIsInR5cCI6...
};
