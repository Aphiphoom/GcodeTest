/* =============================================================================
 * admin.js
 * -----------------------------------------------------------------------------
 * หน้า Admin: ดึงรายชื่อสมาชิกทั้งหมด, แก้สถานะ/วันหมดอายุ/role, ดู login log
 * ทั้งหมดเรียกตรงผ่าน Supabase (RLS policies เป็นตัวบังคับสิทธิ์ ไม่ต้องมี backend
 * function แยก — ถ้าผู้ใช้ไม่ใช่ admin จริง คำสั่งจะถูกปฏิเสธจาก database โดยตรง)
 * ========================================================================== */

(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let sb, users = [], selectedUserId = null;

  async function boot() {
    sb = window.AuthClient.sb;
    const user = await window.AuthClient.requireLogin();
    if (!user) return;

    const profile = await window.AuthClient.getMyProfile();
    if (!profile || profile.role !== 'admin') {
      $('accessMsg').textContent = 'หน้านี้สำหรับแอดมินเท่านั้น — บัญชีของคุณไม่มีสิทธิ์เข้าถึง';
      return;
    }

    $('accessGate').style.display = 'none';
    $('appRoot').style.display = '';
    $('userEmail').textContent = user.email;
    $('btnLogout').addEventListener('click', () => window.AuthClient.logout());
    $('btnRefresh').addEventListener('click', loadUsers);
    $('btnSaveUser').addEventListener('click', saveUser);

    await loadUsers();
  }

  async function loadUsers() {
    $('userTableBody').innerHTML = `<tr><td colspan="6" class="empty-hint">กำลังโหลด...</td></tr>`;
    const { data, error } = await sb.from('profiles').select('*').order('created_at', { ascending: false });
    if (error) { $('userTableBody').innerHTML = `<tr><td colspan="6" class="empty-hint">โหลดไม่สำเร็จ: ${error.message}</td></tr>`; return; }
    users = data.map(u => ({ id: u.id, email: u.email, role: u.role, status: u.status, expiresAt: u.expires_at, createdAt: u.created_at }));
    renderTable();
  }

  function statusLabel(s) { return { pending: 'รออนุมัติ', active: 'ใช้งานได้', suspended: 'ระงับสิทธิ์' }[s] || s; }

  function renderTable() {
    const body = $('userTableBody');
    if (!users.length) { body.innerHTML = `<tr><td colspan="6" class="empty-hint">ยังไม่มีสมาชิก</td></tr>`; return; }
    body.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      const expired = u.expiresAt && new Date(u.expiresAt).getTime() < Date.now();
      tr.innerHTML = `
        <td>${u.email}</td>
        <td><span class="status-pill status-${u.status}">${statusLabel(u.status)}</span></td>
        <td>${u.expiresAt ? u.expiresAt.slice(0, 10) + (expired ? ' (หมดอายุ)' : '') : '—'}</td>
        <td>${u.role}</td>
        <td>${u.createdAt ? u.createdAt.slice(0, 10) : '—'}</td>
        <td><button class="mini" data-id="${u.id}">จัดการ</button></td>`;
      tr.querySelector('button').addEventListener('click', () => openDetail(u));
      body.appendChild(tr);
    });
  }

  function openDetail(u) {
    selectedUserId = u.id;
    $('detailPanel').style.display = '';
    $('detailEmail').textContent = u.email;
    $('detailStatus').value = u.status;
    $('detailExpires').value = u.expiresAt ? u.expiresAt.slice(0, 10) : '';
    $('detailRole').value = u.role;
    $('saveUserMsg').textContent = '';
    loadLog(u.id);
    $('detailPanel').scrollIntoView({ behavior: 'smooth' });
  }

  async function saveUser() {
    if (!selectedUserId) return;
    $('saveUserMsg').textContent = 'กำลังบันทึก...';
    const expiresAt = $('detailExpires').value ? new Date($('detailExpires').value + 'T23:59:59Z').toISOString() : null;
    const { error } = await sb.from('profiles').update({
      status: $('detailStatus').value,
      role: $('detailRole').value,
      expires_at: expiresAt
    }).eq('id', selectedUserId);
    if (error) { $('saveUserMsg').textContent = '⚠ บันทึกไม่สำเร็จ: ' + error.message; return; }
    $('saveUserMsg').textContent = '✓ บันทึกแล้ว (มีผลตอนสมาชิก login ครั้งถัดไป)';
    await loadUsers();
  }

  async function loadLog(userId) {
    $('logTableBody').innerHTML = `<tr><td colspan="5" class="empty-hint">กำลังโหลด...</td></tr>`;
    const { data, error } = await sb.from('login_logs').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(50);
    if (error) { $('logTableBody').innerHTML = `<tr><td colspan="5" class="empty-hint">โหลด log ไม่สำเร็จ: ${error.message}</td></tr>`; return; }
    renderLog(data);
  }

  function renderLog(log) {
    const body = $('logTableBody');
    if (!log.length) { body.innerHTML = `<tr><td colspan="5" class="empty-hint">ยังไม่มีประวัติการ login</td></tr>`; return; }
    body.innerHTML = '';
    log.forEach(e => {
      const tr = document.createElement('tr');
      if (e.flagged) tr.classList.add('flagged-row');
      tr.innerHTML = `
        <td>${e.flagged ? '⚠' : ''}</td>
        <td>${new Date(e.created_at).toLocaleString('th-TH')}</td>
        <td>${e.ip || '—'}</td>
        <td>${e.city || 'ไม่ทราบ'}, ${e.country || 'ไม่ทราบ'}</td>
        <td class="ua-cell" title="${(e.user_agent || '').replace(/"/g, '')}">${(e.user_agent || '').slice(0, 28)}...</td>`;
      body.appendChild(tr);
    });
  }

  boot();
})();
