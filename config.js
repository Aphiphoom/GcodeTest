/* =============================================================================
 * config.js
 * -----------------------------------------------------------------------------
 * ใส่ค่า URL และ Anon Key ของโปรเจกต์ Supabase ของคุณตรงนี้
 * หาได้จาก Supabase Dashboard -> Project Settings -> API
 *   - Project URL          -> SUPABASE_URL
 *   - anon public API key  -> SUPABASE_ANON_KEY  (กุญแจนี้ใส่ในโค้ด client ได้
 *     อย่างปลอดภัย เพราะ Supabase ออกแบบมาให้ใช้ร่วมกับ Row Level Security เสมอ
 *     ไม่ใช่กุญแจระดับ admin)
 * ========================================================================== */

window.SUPABASE_URL = 'https://modbgnzikhrdvrcxnzqy.supabase.co';
window.SUPABASE_ANON_KEY = 'sb_publishable_55FVfkHoyMRlmiAkTjt5LQ_IbqajFqr';
