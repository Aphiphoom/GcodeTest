/* =============================================================================
 * auth-client.js
 * -----------------------------------------------------------------------------
 * ตัวกลางคุยกับ Supabase Auth ใช้ร่วมกันทั้ง index.html, login.html, admin.html
 * ต้องโหลด config.js และ Supabase JS (CDN) มาก่อนไฟล์นี้เสมอ
 * ========================================================================== */

(function (global) {
  'use strict';

  if (!global.SUPABASE_URL || global.SUPABASE_URL.includes('YOUR-PROJECT-REF')) {
    console.error('ยังไม่ได้ตั้งค่า config.js — กรุณาใส่ SUPABASE_URL / SUPABASE_ANON_KEY ของคุณก่อนใช้งาน');
  }

  const sb = global.supabase.createClient(global.SUPABASE_URL, global.SUPABASE_ANON_KEY);

  async function getUser() {
    const { data } = await sb.auth.getUser();
    return data ? data.user : null;
  }

  // ถ้ายังไม่ login ให้เด้งไปหน้า login ทันที (เก็บ path เดิมไว้เผื่อ redirect กลับ)
  async function requireLogin() {
    const user = await getUser();
    if (!user) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.href = `login.html?next=${next}`;
      return null;
    }
    return user;
  }

  // ดึงโปรไฟล์ (role/status/expiresAt) ของ user ปัจจุบันจากตาราง profiles
  async function getMyProfile() {
    const user = await getUser();
    if (!user) return null;
    const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
    if (error) return null;
    return data;
  }

  async function logout() {
    await sb.auth.signOut();
    location.href = 'login.html';
  }

  global.AuthClient = { sb, getUser, requireLogin, getMyProfile, logout };

})(window);
