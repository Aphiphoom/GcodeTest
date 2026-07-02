/* =============================================================================
 * app.js — ตัวควบคุมหลัก (Supabase edition)
 * -----------------------------------------------------------------------------
 * ลำดับการทำงานตอนเปิดหน้า:
 *   1) รอเช็ค session ของ Supabase Auth -> ถ้าไม่ login เด้งไป login.html
 *   2) อ่านโปรไฟล์ (role/status/expiresAt) จากตาราง profiles (ผ่าน RLS)
 *   3) เรียก geolocation API ของเบราว์เซอร์ผู้ใช้เอง แล้ว insert login_logs
 *   4) อ่าน user_settings ที่เคยบันทึกไว้ มาแทนค่า default
 *   5) แสดง #appRoot แล้วเริ่มแอปตามปกติ
 * ========================================================================== */

(function () {
  'use strict';

  const DXF = window.DXFReader, MC = window.MachineConfig, TP = window.ToolpathGenerator,
        GC = window.GCodeGenerator, PS = window.ProjectStorage, AC = window.AuthClient;
  const $ = (id) => document.getElementById(id);

  /* ===== สถานะกลาง ===== */
  let state = MC.defaultState();
  let tabs = [];          // [{id, fileName, dxf, layerColor:{}, layerVisible:{}, originInfo, warnings:[], lastJob, gcode, stats}]
  let activeTabId = null;
  let tabCounter = 0;
  let currentUserId = null;

  const PALETTE = ['#f5a623', '#34d2c0', '#7c9cff', '#ff8ac4', '#9ad14e', '#ffd24d', '#ff7a5c', '#56c2e6', '#c08bff', '#8de0b0'];
  // เลเยอร์ที่ไม่แสดงในหน้า Layer/Mapping เลย (ไม่ใช่งานตัด เป็นแค่ข้อความกำกับ)
  const HIDDEN_LAYERS = (MC.EXCLUDED_LAYERS || []).filter(l => l !== '_ABF_SHEET_BORDER');
  const BORDER_LAYER = '_ABF_SHEET_BORDER'; // ยกเว้น border: ไม่อยู่ใน mapping แต่ "วาดในพรีวิว" ได้

  /* =========================================================================
   * 0. AUTH GUARD
   * ====================================================================== */
  async function bootAuth() {
    const user = await AC.requireLogin();
    if (!user) return; // requireLogin จะ redirect ไป login.html เองถ้าไม่ login
    currentUserId = user.id;

    let profile;
    try {
      profile = await AC.getMyProfile();
      if (!profile) throw new Error('no-profile');
    } catch (err) {
      $('accessMsg').textContent = 'ตรวจสอบสิทธิ์ไม่สำเร็จ (เครือข่ายมีปัญหา) — ลองโหลดหน้าใหม่อีกครั้ง';
      return;
    }

    const allowed = profile.role === 'admin' ||
      (profile.status === 'active' && (!profile.expires_at || new Date(profile.expires_at).getTime() >= Date.now()));
    if (!allowed) {
      const messages = {
        pending: 'บัญชีของคุณรออนุมัติจากแอดมิน กรุณาติดต่อแอดมินเพื่อเปิดสิทธิ์ใช้งาน',
        suspended: 'บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อแอดมิน'
      };
      const reason = profile.status === 'suspended' ? 'suspended'
        : (profile.expires_at && new Date(profile.expires_at).getTime() < Date.now()) ? 'expired' : 'pending';
      $('accessMsg').textContent = reason === 'expired'
        ? 'สิทธิ์การใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อแอดมินเพื่อต่ออายุ'
        : (messages[reason] || 'ไม่สามารถเข้าใช้งานได้ในขณะนี้');
      $('btnGateLogout').style.display = '';
      $('btnGateLogout').addEventListener('click', () => AC.logout());
      return;
    }

    recordLogin().catch(() => {}); // บันทึก log แบบ fire-and-forget ไม่บล็อกการเข้าใช้งาน

    try {
      const { data } = await AC.sb.from('user_settings').select('*').eq('user_id', user.id).single();
      if (data) applyLoadedSettings(data);
    } catch (err) { /* ยังไม่เคยบันทึกมาก่อน ใช้ค่า default ต่อไป */ }

    $('accessGate').style.display = 'none';
    $('appRoot').style.display = '';
    $('userEmail').textContent = user.email;
    $('btnLogout').addEventListener('click', () => AC.logout());

    initApp();
  }

  // ขอตำแหน่งโดยประมาณจาก IP ของเบราว์เซอร์เอง (ไม่มี server-side geo แบบ Netlify
  // แล้ว) แล้วบันทึกลง login_logs พร้อมเทียบกับครั้งก่อนเพื่อติดธงเตือนถ้าข้าม
  // เมือง/ประเทศภายใน 3 ชั่วโมง — ใช้แค่เตือนแอดมินดูเฉย ๆ ไม่ block อัตโนมัติ
  async function recordLogin() {
    let geo = { city: 'ไม่ทราบ', country: 'ไม่ทราบ', countryCode: '', ip: 'unknown' };
    try {
      const res = await fetch('https://ipapi.co/json/');
      const j = await res.json();
      geo = { city: j.city || 'ไม่ทราบ', country: j.country_name || 'ไม่ทราบ', countryCode: j.country_code || '', ip: j.ip || 'unknown' };
    } catch (err) { /* หา geo ไม่ได้ก็ยังบันทึก log ได้ แค่ไม่มีตำแหน่ง */ }

    const sb = AC.sb;
    let flagged = false;
    try {
      const { data: last } = await sb.from('login_logs').select('*').eq('user_id', currentUserId)
        .order('created_at', { ascending: false }).limit(1).single();
      if (last) {
        const diffMs = Date.now() - new Date(last.created_at).getTime();
        const differentLocation = last.city !== geo.city || last.country_code !== geo.countryCode;
        if (diffMs <= 3 * 60 * 60 * 1000 && differentLocation) flagged = true;
      }
    } catch (err) { /* ยังไม่มี log มาก่อน ไม่ใช่ error ร้ายแรง */ }

    await sb.from('login_logs').insert({
      user_id: currentUserId, ip: geo.ip, city: geo.city, country: geo.country,
      country_code: geo.countryCode, user_agent: navigator.userAgent, flagged
    });
  }

  function applyLoadedSettings(row) {
    if (row.machine) state.machine = Object.assign(MC.defaultMachine(), row.machine);
    if (row.tools && Object.keys(row.tools).length) state.tools = row.tools;
    if (row.saved_mappings) state.savedMappings = row.saved_mappings;
    if (row.tool_change) state.toolChange = row.tool_change;
    if (row.header) state.header = row.header;
    if (row.footer) state.footer = row.footer;
  }

  /* =========================================================================
   * 1. SETTINGS AUTO-SAVE (debounced) + ปุ่ม "บันทึก" (force ทันที)
   * ====================================================================== */
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    setIndicator('กำลังจะบันทึก...');
    saveTimer = setTimeout(forceSave, 900);
  }
  async function forceSave() {
    clearTimeout(saveTimer);
    setIndicator('กำลังบันทึก...');
    try {
      const { error } = await AC.sb.from('user_settings').upsert({
        user_id: currentUserId,
        machine: state.machine, tools: state.tools, saved_mappings: state.savedMappings,
        tool_change: state.toolChange, header: state.header, footer: state.footer,
        updated_at: new Date().toISOString()
      });
      setIndicator(error ? '⚠ บันทึกไม่สำเร็จ' : '✓ บันทึกแล้ว');
    } catch (err) { setIndicator('⚠ บันทึกไม่สำเร็จ (เครือข่าย)'); }
  }
  function setIndicator(text) {
    const el = $('saveIndicator');
    if (el) el.textContent = text;
    setTimeout(() => { if (el && el.textContent === text) el.textContent = ''; }, 2500);
  }

  /* =========================================================================
   * 2. การจดจำ Layer Mapping แบบถาวร (ผูกกับชื่อ Layer ข้ามไฟล์)
   * ====================================================================== */
  function resolveMapping(layerName) {
    if (!state.savedMappings[layerName]) {
      state.savedMappings[layerName] = MC.guessMapping(layerName, state.tools, state.machine);
      scheduleSave();
    }
    return state.savedMappings[layerName];
  }

  // คำนวณ targetZ จริงจาก depth ที่ผู้ใช้กรอก (เลขบวก) ตามโหมด Z0
  // คำนวณ targetZ จริงจาก depth ที่ผู้ใช้กรอก (เลขบวก) ตามโหมด Z0
  // หมายเหตุ: CutDeeper มีผลแค่ตอนสร้างค่า Default Depth (= ความหนาไม้ + CutDeeper)
  // เท่านั้น — สูตรแปลงเป็น Z จริงตรงนี้ "ไม่บวก CutDeeper ซ้ำ" อีก เพื่อไม่ให้
  // เผลอบวกสองรอบ (ถ้าผู้ใช้พิมพ์ความหนาไม้ตรง ๆ จะได้ Z=0 เสมอพื้นโต๊ะพอดี
  // ถ้าใช้ค่า Default ที่รวม CutDeeper ไว้แล้ว จะได้ Z ติดลบเล็กน้อยตามที่ตั้งใจ)
  function toRealZ(depthPositive) {
    const d = Math.abs(parseFloat(depthPositive) || 0);
    if (state.machine.z0Mode === 'table') {
      return (parseFloat(state.machine.woodThickness) || 0) - d;
    }
    return -d;
  }

  /* =========================================================================
   * 3. จัดการแท็บไฟล์ DXF หลายไฟล์
   * ====================================================================== */
  function activeTab() { return tabs.find(t => t.id === activeTabId) || null; }

  function originCornerPoint(border, corner) {
    switch (corner) {
      case 'bottom-right': return { x: border.maxX, y: border.minY };
      case 'top-left': return { x: border.minX, y: border.maxY };
      case 'top-right': return { x: border.maxX, y: border.maxY };
      default: return { x: border.minX, y: border.minY }; // bottom-left
    }
  }

  /* ---------------------------------------------------------------------------
   * คำนวณ Depth ของ Layer ที่อาจกรอกเป็น "นิพจน์" ไม่ใช่แค่ตัวเลขตายตัว
   * ตัวแปรที่ใช้ได้: pt = ความหนาไม้ (woodThickness), cd = Cut Deeper
   * เช่น "18.3" (เลขตรง ๆ แบบเดิม), "pt+0.3", "pt-2"
   * ปลอดภัย: กรองอักขระก่อนส่งเข้า Function — รับได้แค่ตัวเลข จุดทศนิยม เครื่องหมาย + - คูณ หาร วงเล็บ เว้นวรรค pt cd เท่านั้น
   * คืนค่า NaN ถ้านิพจน์ไม่ถูกต้อง (ผู้เรียกต้องเช็คเอง)
   * ------------------------------------------------------------------------- */
  function evalDepthExpr(expr, machine) {
    const pt = parseFloat(machine.woodThickness) || 0;
    const cd = parseFloat(machine.cutDeeper) || 0;
    const raw = (expr === null || expr === undefined) ? '' : String(expr).trim();
    if (raw === '') return 0;
    const stripped = raw.replace(/\bpt\b/g, '').replace(/\bcd\b/g, '');
    if (!/^[0-9+\-*/().\s]*$/.test(stripped)) return NaN; // มีอักขระแปลกปลอม ไม่ปลอดภัย/ไม่ใช่นิพจน์ที่รองรับ
    try {
      const val = new Function('pt', 'cd', `return (${raw});`)(pt, cd);
      return (typeof val === 'number' && isFinite(val)) ? val : NaN;
    } catch (e) { return NaN; }
  }

  function translateEntities(entities, dx, dy) {
    for (const e of entities) {
      for (const p of e.points) { p.x -= dx; p.y -= dy; }
      if (e.cx !== undefined) { e.cx -= dx; e.cy -= dy; }
    }
  }

  async function addDxfFile(file) {
    const text = await PS.readFileAsText(file);
    let parsed;
    try { parsed = DXF.parse(text); }
    catch (err) { setWarn(['อ่านไฟล์ ' + file.name + ' ไม่สำเร็จ: ' + err.message]); return; }

    // จุด (0,0) อ้างอิงจากกรอบรวมของ "ทุก entity ในไฟล์" เสมอ (ไม่สนใจชื่อ Layer)
    // เพราะไฟล์จากโปรแกรมอื่นที่ไม่ใช่ ABF อาจมีเส้นกรอบขนาดเท่าแผ่นไม้ติดมาด้วย แต่ใช้ชื่อ Layer ต่างกัน —
    // กรอบรวมของทุก entity จะครอบคลุมเส้นกรอบนั้นไปโดยอัตโนมัติอยู่แล้ว ไม่ต้องรู้ชื่อ Layer เลย
    const border = DXF.computeBounds(parsed.entities);
    const origin = originCornerPoint(border, state.machine.originCorner);
    translateEntities(parsed.entities, origin.x, origin.y);
    parsed.bounds = DXF.computeBounds(parsed.entities);

    const id = 'tab' + (++tabCounter);
    const layerColor = {}, layerVisible = {};
    parsed.layers.forEach((ln, i) => {
      if (ln === BORDER_LAYER || HIDDEN_LAYERS.indexOf(ln) !== -1) return;
      layerColor[ln] = PALETTE[i % PALETTE.length];
      layerVisible[ln] = true;
      const m = resolveMapping(ln); // จดจำ/สร้าง mapping ของ layer นี้ไว้ในระบบกลาง
      // เลเยอร์ตัดหลัก (_ABF_CUTTING_LINES) ล็อกท้ายสุด — depth รีเซ็ตกลับเป็นนิพจน์ "pt+cd"
      // ทุกครั้งที่ "เปิดไฟล์" (ทับค่าที่แก้ไว้ก่อนหน้า) หลังจากนี้ผู้ใช้ยังแก้ไขเองได้ตามปกติ
      // เหมือน Layer อื่นทุกอย่าง จนกว่าจะเปิดไฟล์ใหม่อีกรอบ
      if (ln === MC.LOCKED_LAST_LAYER) {
        m.depth = 'pt+cd';
      }
    });

    const tab = {
      id, fileName: file.name, dxf: parsed, layerColor, layerVisible,
      lastJob: null, gcode: '', stats: null,
      doorMode: MC.defaultDoorMode(state.tools), lastDoors: null
    };
    tabs.push(tab);
    activeTabId = id;

    renderFileTabs();
    renderLayerList();
    renderMapping();
    fitView();
    refreshOutputFileSelect();
    syncView3DIfActive(); // ถ้าเปิดโหมด 3D อยู่ ให้ตามไฟล์ใหม่ที่เพิ่งเปิดทันที (กันภาพค้างเป็นไฟล์เก่า)
  }

  function closeTab(id) {
    tabs = tabs.filter(t => t.id !== id);
    if (activeTabId === id) activeTabId = tabs.length ? tabs[tabs.length - 1].id : null;
    renderFileTabs(); renderLayerList(); renderMapping(); render(); refreshOutputFileSelect();
  }

  function renderFileTabs() {
    const host = $('fileTabs');
    host.innerHTML = '';
    tabs.forEach(t => {
      const el = document.createElement('div');
      el.className = 'filetab' + (t.id === activeTabId ? ' active' : '');
      el.innerHTML = `<span>${t.fileName}</span><span class="ft-close" title="ปิดไฟล์นี้">✕</span>`;
      el.querySelector('span').addEventListener('click', () => { if (guard3D()) return; activeTabId = t.id; renderFileTabs(); renderLayerList(); refreshLayerPaneMode(); fitView(); render(); syncView3DIfActive(); });
      el.querySelector('.ft-close').addEventListener('click', (ev) => { ev.stopPropagation(); if (guard3D()) return; closeTab(t.id); });
      host.appendChild(el);
    });
  }

  $('btnOpenDxfLabel').addEventListener('click', (e) => {
    if (guard3D()) { e.preventDefault(); return; } // กันไว้ก่อนที่ native file dialog จะเปิดขึ้นเลย
  });

  $('dxfInput').addEventListener('change', async (e) => {
    if (guard3D()) { e.target.value = ''; return; } // กันชั้นที่ 2 เผื่อมีไฟล์เข้ามาทางอื่น (เช่น drag&drop ในอนาคต)
    const files = Array.from(e.target.files || []);
    if (!files.length) { e.target.value = ''; return; }
    // บังคับปิดงานเดิมทั้งหมดก่อนเปิดไฟล์ชุดใหม่เสมอ (กันความหนาไม้/สถานะของไฟล์ก่อนหน้าปนกับชุดใหม่)
    if (tabs.length) [...tabs].forEach(t => closeTab(t.id));
    // เดาความหนาไม้จากชื่อไฟล์แรกของชุดที่เปิด (รูปแบบ "18mm"/"6mm" ต้นชื่อไฟล์) — ถ้าจับไม่ได้ ใช้ค่าเดิม
    const detected = detectThicknessFromFileName(files[0].name);
    if (detected !== null) {
      state.machine.woodThickness = detected;
      const twInput = $('woodThicknessInput');
      if (twInput) twInput.value = detected;
      scheduleSave();
    }
    for (const f of files) await addDxfFile(f);
    e.target.value = '';
  });

  /* =========================================================================
   * 4. Canvas Preview (zoom/pan) — ทำงานกับแท็บที่ active อยู่
   * ====================================================================== */
  const canvas = $('preview');
  const ctx = canvas.getContext('2d');
  const canvas3dWrap = $('preview3d');
  let view3DActive = false;
  let view = { scale: 1, ox: 50, oy: 50 };

  function W2S(x, y) { return { x: x * view.scale + view.ox, y: canvas.clientHeight - (y * view.scale + view.oy) }; }
  function S2W(sx, sy) { return { x: (sx - view.ox) / view.scale, y: (canvas.clientHeight - sy - view.oy) / view.scale }; }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w === 0 || h === 0) return; // ยังไม่ layout เสร็จ ข้ามไปก่อน
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }
  // ใช้ ResizeObserver แทน window resize event เดี่ยว ๆ เพราะจับการเปลี่ยนขนาดที่
  // เกิดจาก layout/flex/grid ปรับตัวได้แม่นยำกว่า (กันเส้นเบลอจาก backing-store ไม่ตรงขนาดจริง)
  if (window.ResizeObserver) {
    new ResizeObserver(() => resizeCanvas()).observe(canvas.parentElement);
  }

  // ปัดตำแหน่งจุดให้ตรงกึ่งกลางพิกเซล เพื่อให้เส้นบาง 1px คมชัดขึ้น (ลดอาการเบลอจาก anti-aliasing)
  function crisp(v) { return Math.round(v) + 0.5; }

  function fitView() {
    const tab = activeTab();
    if (!tab) { view = { scale: 1, ox: 50, oy: 50 }; render(); return; }
    const b = tab.dxf.bounds;
    const pad = 40;
    const w = canvas.clientWidth - pad * 2, h = canvas.clientHeight - pad * 2;
    const sx = w / (b.width || 1), sy = h / (b.height || 1);
    view.scale = Math.min(sx, sy);
    view.ox = pad + (w - b.width * view.scale) / 2 - b.minX * view.scale;
    view.oy = pad + (h - b.height * view.scale) / 2 - b.minY * view.scale;
    render();
  }

  function render() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h);
    drawAxes();
    const tab = activeTab();
    if (tab) {
      drawSheetBorder(tab);
      drawEntities(tab);
      if (tab.doorMode && tab.doorMode.enabled) drawDoorPreview(tab);
      if ($('chkToolpath').checked) drawToolpath(tab);
      if ($('chkStartPoints').checked) drawStartPoints(tab);
    }
  }

  // วาดเส้น V-line / ทางเดิน V-bit / ทางเดิน FormTool ของโหมดตีบัวหน้าบาน — แสดงเสมอ
  // ตอนโหมดนี้เปิดอยู่ (ไม่ผูกกับ checkbox "แสดง Toolpath" เพราะเป็นเส้นอ้างอิงหลักของโหมดนี้)
  function drawDoorPreview(tab) {
    if (!tab.lastDoors) computeJob(tab);
    if (!tab.lastDoors) return;
    ctx.lineWidth = 1.3;
    tab.lastDoors.forEach(d => {
      ctx.strokeStyle = '#f5a623'; ctx.setLineDash([5, 3]); drawPolyline(d.vLine); ctx.setLineDash([]);
      ctx.strokeStyle = '#34d2c0'; drawPolyline(d.vbitPath);
      ctx.strokeStyle = '#ff6b5e'; drawPolyline(d.formtoolPath);
    });
  }

  function drawGrid(w, h) {
    let g = 10;
    const targetPx = 28;
    while (g * view.scale < targetPx) g *= 5;
    while (g * view.scale > targetPx * 6) g /= 5;
    const step = g * view.scale;
    ctx.lineWidth = 1;
    const startX = ((view.ox % step) + step) % step;
    const startY = ((view.oy % step) + step) % step;
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.beginPath();
    for (let x = startX; x < w; x += step) { const cx = crisp(x); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); }
    for (let y = h - startY; y > 0; y -= step) { const cy = crisp(y); ctx.moveTo(0, cy); ctx.lineTo(w, cy); }
    ctx.stroke();
  }

  function drawAxes() {
    const o = W2S(0, 0);
    const ox = crisp(o.x), oy = crisp(o.y);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,107,94,0.5)';
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + 34, oy); ctx.stroke();
    ctx.strokeStyle = 'rgba(78,208,122,0.5)';
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - 34); ctx.stroke();
    ctx.fillStyle = '#e6edf3';
    ctx.beginPath(); ctx.arc(o.x, o.y, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  function drawEntities(tab) {
    for (const e of tab.dxf.entities) {
      if (e.layer === BORDER_LAYER || HIDDEN_LAYERS.indexOf(e.layer) !== -1) continue;
      if (tab.layerVisible[e.layer] === false) continue;
      ctx.strokeStyle = tab.layerColor[e.layer] || '#cccccc';
      ctx.lineWidth = 1.4;
      drawPolyline(e.points);
    }
  }
  // วาดเส้นกรอบ _ABF_SHEET_BORDER แยกต่างหาก (เส้นประสีเทาอ่อน) เป็นกรอบอ้างอิงให้เห็น
  // ไม่ใช่ layer ที่เลือกแสดง/ซ่อนได้ และไม่เกี่ยวกับ toolpath
  function drawSheetBorder(tab) {
    ctx.strokeStyle = 'rgba(180,190,200,0.55)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    for (const e of tab.dxf.entities) {
      if (e.layer !== BORDER_LAYER) continue;
      drawPolyline(e.points);
    }
    ctx.setLineDash([]);
  }
  function drawPolyline(pts) {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    const s0 = W2S(pts[0].x, pts[0].y);
    ctx.moveTo(s0.x, s0.y);
    for (let i = 1; i < pts.length; i++) { const s = W2S(pts[i].x, pts[i].y); ctx.lineTo(s.x, s.y); }
    ctx.stroke();
  }
  function drawStartPoints(tab) {
    ctx.fillStyle = '#f5a623';
    for (const e of tab.dxf.entities) {
      if (e.layer === BORDER_LAYER || HIDDEN_LAYERS.indexOf(e.layer) !== -1) continue;
      if (tab.layerVisible[e.layer] === false) continue;
      const p = e.points[0];
      const s = W2S(p.x, p.y);
      ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
  function drawToolpath(tab) {
    if (!tab.lastJob) computeJob(tab);
    if (!tab.lastJob) return;
    ctx.lineWidth = 1.1;
    for (const op of tab.lastJob.operations) {
      if (op.kind === 'drill') {
        const s = W2S(op.point.x, op.point.y);
        ctx.strokeStyle = '#34d2c0';
        ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x - 6, s.y); ctx.lineTo(s.x + 6, s.y); ctx.moveTo(s.x, s.y - 6); ctx.lineTo(s.x, s.y + 6); ctx.stroke();
      } else if (op.kind === 'pocket') {
        ctx.strokeStyle = 'rgba(52,210,192,0.55)';
        for (const ring of op.rings) drawPolyline(ring);
      } else {
        ctx.strokeStyle = '#34d2c0';
        ctx.setLineDash([4, 3]);
        drawPolyline(op.path);
        ctx.setLineDash([]);
        if (op.tabs && op.tabs.length) {
          ctx.fillStyle = '#ff6b5e';
          for (const t of op.tabs) {
            const mid = (t.start + t.end) / 2;
            const p = pointAtDist(op.path, mid);
            const s = W2S(p.x, p.y);
            ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
          }
        }
      }
    }
  }
  function pointAtDist(pts, d) {
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      if (acc + seg >= d) { const t = (d - acc) / seg; return { x: pts[i].x + t * (pts[i + 1].x - pts[i].x), y: pts[i].y + t * (pts[i + 1].y - pts[i].y) }; }
      acc += seg;
    }
    return pts[pts.length - 1];
  }

  let dragging = false, dragStart = null;
  canvas.addEventListener('mousedown', (e) => { dragging = true; dragStart = { x: e.offsetX, y: e.offsetY, ox: view.ox, oy: view.oy }; });
  window.addEventListener('mouseup', () => { dragging = false; });
  canvas.addEventListener('mousemove', (e) => {
    if (dragging) { view.ox = dragStart.ox + (e.offsetX - dragStart.x); view.oy = dragStart.oy - (e.offsetY - dragStart.y); render(); }
    const wp = S2W(e.offsetX, e.offsetY);
    $('coordReadout').textContent = `X ${wp.x.toFixed(2)}　Y ${wp.y.toFixed(2)}`;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const before = S2W(e.offsetX, e.offsetY);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    view.scale *= factor;
    view.ox = e.offsetX - before.x * view.scale;
    view.oy = (canvas.clientHeight - e.offsetY) - before.y * view.scale;
    render();
  }, { passive: false });

  /* =========================================================================
   * 5. รายการ Layer (ซ้าย) — ของแท็บที่ active
   * ====================================================================== */
  function renderLayerList() {
    const host = $('layerList');
    const tab = activeTab();
    if (!tab) { host.innerHTML = '<p class="empty-hint">เปิดไฟล์ DXF เพื่อแสดงรายการ Layer</p>'; updateLegend(); return; }
    const layers = tab.dxf.layers.filter(l => l !== BORDER_LAYER && HIDDEN_LAYERS.indexOf(l) === -1);
    if (!layers.length) { host.innerHTML = '<p class="empty-hint">ไม่พบ Layer ในไฟล์นี้</p>'; return; }
    host.innerHTML = '';
    const counts = {};
    tab.dxf.entities.forEach(e => counts[e.layer] = (counts[e.layer] || 0) + 1);
    layers.forEach(ln => {
      const row = document.createElement('div');
      row.className = 'layer-row' + (tab.layerVisible[ln] === false ? ' hidden' : '');
      row.innerHTML = `
        <span class="layer-swatch" style="background:${tab.layerColor[ln]}"></span>
        <span class="layer-name" title="${ln}">${ln}</span>
        <span class="layer-count">${counts[ln] || 0}</span>
        <span class="layer-eye" title="แสดง/ซ่อน">${tab.layerVisible[ln] === false ? '◌' : '◉'}</span>`;
      row.querySelector('.layer-eye').addEventListener('click', (ev) => {
        ev.stopPropagation();
        tab.layerVisible[ln] = !(tab.layerVisible[ln] !== false);
        renderLayerList(); render();
      });
      row.addEventListener('click', () => { switchTab('mapping'); highlightMapping(ln); });
      host.appendChild(row);
    });
    updateLegend();
  }
  function updateLegend() {
    $('legend').innerHTML = `
      <div class="lg"><span class="dot" style="background:#f5a623"></span> จุดเริ่ม Path</div>
      <div class="lg"><span class="dot" style="background:#34d2c0"></span> Toolpath</div>
      <div class="lg"><span class="dot" style="background:#ff6b5e"></span> Tab</div>`;
  }
  $('btnShowAll').addEventListener('click', () => { const t = activeTab(); if (t) t.dxf.layers.forEach(l => t.layerVisible[l] = true); renderLayerList(); render(); });
  $('btnHideAll').addEventListener('click', () => { const t = activeTab(); if (t) t.dxf.layers.forEach(l => t.layerVisible[l] = false); renderLayerList(); render(); });

  /* =========================================================================
   * 6. Layer Mapping (แท็บขวา) — แถวเดียวต่อ layer, รวมจากทุกไฟล์ที่เปิดอยู่
   * ====================================================================== */
  function allOpenLayerNames() {
    const set = new Set();
    tabs.forEach(t => t.dxf.layers.forEach(l => { if (l !== BORDER_LAYER && HIDDEN_LAYERS.indexOf(l) === -1) set.add(l); }));
    return Array.from(set);
  }

  /* =========================================================================
   * 3b. โหมด "ตีบัวหน้าบาน" — toggle ที่หน้า Layer Mapping สลับจากตาราง mapping
   *     ปกติ ไปเป็นฟอร์มตั้งค่าเฉพาะของโหมดนี้ (offset/ความลึก/เลือกมีด V-bit/FormTool)
   *     เก็บค่าแยกต่อแท็บไฟล์ (ดู tab.doorMode ที่สร้างไว้ตอนเปิดไฟล์)
   * ====================================================================== */
  function refreshLayerPaneMode() {
    const tab = activeTab();
    const enabled = !!(tab && tab.doorMode && tab.doorMode.enabled);
    const btn = $('btnDoorMode');
    btn.textContent = enabled ? 'ออกจากโหมดตีบัวหน้าบาน · กลับไปหน้า Layer ปกติ' : 'เข้าโหมดตีบัวหน้าบาน';
    btn.classList.toggle('active', enabled);
    btn.disabled = !tab;
    $('doorModeForm').style.display = enabled ? '' : 'none';
    $('mappingTableHead').style.display = enabled ? 'none' : '';
    $('mappingList').style.display = enabled ? 'none' : '';
    if (enabled) renderDoorModeForm(tab); else renderMapping();
  }

  function toolOptionsByType(type) {
    return Object.keys(state.tools).map(Number).sort((a, b) => a - b)
      .filter(n => (state.tools[n].toolType || 'endmill') === type);
  }
  function allToolOptions() {
    return Object.keys(state.tools).map(Number).sort((a, b) => a - b);
  }

  function renderDoorModeForm(tab) {
    const dm = tab.doorMode;
    $('doorOffset').value = dm.offset;
    $('doorDepth').value = dm.depth;
    const fillSel = (sel, keys, selected, allowNone) => {
      const opts = keys.map(n => `<option value="${n}" ${n === selected ? 'selected' : ''}>T${n} · ${state.tools[n].name}</option>`);
      if (allowNone) opts.unshift(`<option value="" ${!selected ? 'selected' : ''}>— ไม่ใช้ —</option>`);
      sel.innerHTML = opts.length ? opts.join('') : '<option value="">— ไม่มีมีดชนิดนี้ใน Tool Library —</option>';
    };
    fillSel($('doorVbitTool'), toolOptionsByType('vbit'), dm.vbitTool, false);
    fillSel($('doorFormtoolTool'), toolOptionsByType('formtool'), dm.formtoolTool, false);
    fillSel($('doorVlineTool'), allToolOptions(), dm.vlineTool, true);
    fillSel($('doorBorderTool'), allToolOptions(), dm.borderTool, true);
    $('doorVlineDepth').value = dm.vlineDepth;
    const borderDepthInput = $('doorBorderDepth');
    borderDepthInput.value = String(dm.borderDepth);
    updateBorderDepthPreview(borderDepthInput);
    // ถ้าค่าที่บันทึกไว้ไม่มีในรายการแล้ว (ลบมีดไปแล้ว) ให้ sync กลับเป็นค่าจริงที่เลือกอยู่ในช่อง
    dm.vbitTool = $('doorVbitTool').value ? Number($('doorVbitTool').value) : null;
    dm.formtoolTool = $('doorFormtoolTool').value ? Number($('doorFormtoolTool').value) : null;
    dm.vlineTool = $('doorVlineTool').value ? Number($('doorVlineTool').value) : null;
    dm.borderTool = $('doorBorderTool').value ? Number($('doorBorderTool').value) : null;
  }

  // โชว์ tooltip "= xx.x mm" ของช่อง Depth ตัดขอบ (รับนิพจน์ pt/cd เหมือนหน้า Layer Mapping)
  function updateBorderDepthPreview(input) {
    const val = evalDepthExpr(input.value, state.machine);
    const invalid = !isFinite(val);
    input.classList.toggle('invalid', invalid);
    input.title = invalid
      ? 'นิพจน์ไม่ถูกต้อง — ใช้ได้แค่ตัวเลข, pt (ความหนาไม้), cd (Cut Deeper) และ + - * / ( )'
      : `= ${val.toFixed(2)} mm`;
  }

  $('btnDoorMode').addEventListener('click', () => {
    const tab = activeTab();
    if (!tab) return;
    tab.doorMode.enabled = !tab.doorMode.enabled;
    tab.lastJob = null; tab.lastDoors = null;
    refreshLayerPaneMode();
    render();
  });
  $('doorBorderDepth').addEventListener('input', () => updateBorderDepthPreview($('doorBorderDepth')));
  ['doorOffset', 'doorDepth', 'doorVbitTool', 'doorFormtoolTool', 'doorVlineTool', 'doorVlineDepth', 'doorBorderTool', 'doorBorderDepth'].forEach(id => {
    $(id).addEventListener('change', () => {
      const tab = activeTab();
      if (!tab) return;
      tab.doorMode.offset = parseFloat($('doorOffset').value) || 0;
      tab.doorMode.depth = parseFloat($('doorDepth').value) || 0;
      tab.doorMode.vbitTool = $('doorVbitTool').value ? Number($('doorVbitTool').value) : null;
      tab.doorMode.formtoolTool = $('doorFormtoolTool').value ? Number($('doorFormtoolTool').value) : null;
      tab.doorMode.vlineTool = $('doorVlineTool').value ? Number($('doorVlineTool').value) : null;
      tab.doorMode.vlineDepth = parseFloat($('doorVlineDepth').value) || 0;
      tab.doorMode.borderTool = $('doorBorderTool').value ? Number($('doorBorderTool').value) : null;
      tab.doorMode.borderDepth = $('doorBorderDepth').value.trim() || '0';
      tab.lastJob = null; tab.lastDoors = null;
      render();
    });
  });

  let mappingSortCol = null; // null = ไม่เรียง (ใช้ลำดับเปิดไฟล์ตามเดิม) | 'enabled'|'layer'|'operation'|'tool'|'depth'|'order'|'tabs'
  let mappingSortDir = 1;    // 1 = น้อย→มาก/ก→ฮ, -1 = สลับกลับ

  // ดึงค่าของ Layer หนึ่งแถว ตามคอลัมน์ที่จะใช้เรียง — คืนค่าที่เทียบกันได้ตรง ๆ (ตัวเลข/string)
  function mappingSortValue(ln, col) {
    const m = resolveMapping(ln);
    switch (col) {
      case 'enabled': return m.enabled ? 1 : 0;
      case 'layer': return ln.toLowerCase();
      case 'operation': return (m.operation || '').toLowerCase();
      case 'tool': return Number(m.toolNumber) || 0;
      case 'depth': { const v = evalDepthExpr(m.depth, state.machine); return isFinite(v) ? v : -Infinity; }
      case 'order': return (m.order === null || m.order === undefined) ? Infinity : Number(m.order);
      case 'tabs': return m.tabsEnabled ? 1 : 0;
      default: return 0;
    }
  }

  function sortLayerNames(names) {
    if (!mappingSortCol) return names;
    const col = mappingSortCol, dir = mappingSortDir;
    return names.slice().sort((a, b) => {
      const va = mappingSortValue(a, col), vb = mappingSortValue(b, col);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.localeCompare(b); // ค่าเท่ากัน: ใช้ชื่อ Layer ตัดสินให้ลำดับเดิมที่แน่นอนเสมอ
    });
  }

  document.querySelectorAll('.mh-sort').forEach(btn => {
    btn.addEventListener('click', () => {
      const col = btn.dataset.col;
      if (mappingSortCol === col) mappingSortDir *= -1;
      else { mappingSortCol = col; mappingSortDir = 1; }
      document.querySelectorAll('.mh-sort').forEach(b => b.classList.remove('sort-asc', 'sort-desc'));
      btn.classList.add(mappingSortDir === 1 ? 'sort-asc' : 'sort-desc');
      renderMapping();
    });
  });

  function renderMapping() {
    const host = $('mappingList');
    const names = sortLayerNames(allOpenLayerNames());
    if (!names.length) { host.innerHTML = '<p class="empty-hint">เปิด DXF แล้วกำหนดงานให้แต่ละ Layer</p>'; return; }
    host.innerHTML = '';
    const toolOpts = Object.keys(state.tools).map(Number).sort((a, b) => a - b)
      .map(n => `<option value="${n}">T${n} · ${state.tools[n].name}</option>`).join('');

    names.forEach(ln => {
      const m = resolveMapping(ln);
      const row = document.createElement('div');
      row.className = 'mapping-row' + (m.enabled ? '' : ' disabled');
      row.dataset.layer = ln;
      const isProfile = m.operation.indexOf('Profile') === 0;
      const isLocked = (ln === MC.LOCKED_LAST_LAYER);
      row.innerHTML = `
        <span class="mr-enable"><input type="checkbox" class="m-enabled" ${m.enabled ? 'checked' : ''}></span>
        <span class="mr-name" title="${ln}"><span class="layer-swatch" style="background:${colorForLayer(ln)}"></span>${ln}</span>
        <select class="m-op">${MC.OPERATIONS.map(o => `<option ${o === m.operation ? 'selected' : ''}>${o}</option>`).join('')}</select>
        <select class="m-tool">${toolOpts}</select>
        <input type="text" class="m-depth" placeholder="pt+cd">
        <input type="number" class="m-order" min="1" step="1" placeholder="${isLocked ? 'สุดท้าย' : '—'}"
               value="${m.order === null || m.order === undefined ? '' : m.order}" ${isLocked ? 'disabled title="เลเยอร์นี้ล็อกให้อยู่ท้ายสุดเสมอ"' : ''}>
        <span class="mr-tabs">${isProfile ? `<input type="checkbox" class="m-tabs" ${m.tabsEnabled ? 'checked' : ''}>` : ''}</span>`;
      row.querySelector('.m-tool').value = m.toolNumber;
      const depthInput = row.querySelector('.m-depth');
      depthInput.value = String(m.depth);
      updateDepthPreview(depthInput);

      const upd = () => {
        m.operation = row.querySelector('.m-op').value;
        m.toolNumber = parseInt(row.querySelector('.m-tool').value, 10);
        m.depth = row.querySelector('.m-depth').value.trim() || '0';
        m.enabled = row.querySelector('.m-enabled').checked;
        const orderInput = row.querySelector('.m-order');
        const orderRaw = orderInput ? orderInput.value.trim() : '';
        m.order = (orderRaw === '' || isLocked) ? null : Number(orderRaw);
        const tabsInput = row.querySelector('.m-tabs');
        m.tabsEnabled = tabsInput ? tabsInput.checked : false;
        row.classList.toggle('disabled', !m.enabled);
        invalidateAllJobs();
        renderMapping(); // re-render เผื่อ operation เปลี่ยนทำให้ checkbox tabs โผล่/หาย
        if ($('chkToolpath').checked) render();
        scheduleSave();
      };
      row.querySelectorAll('select, input').forEach(el => el.addEventListener('change', upd));
      depthInput.addEventListener('input', () => updateDepthPreview(depthInput)); // โชว์ผลลัพธ์สดตอนพิมพ์ ไม่ต้องรอ blur
      host.appendChild(row);
    });
  }
  // อัปเดต tooltip "= xx.x mm" ของช่อง Depth ตามนิพจน์ที่พิมพ์อยู่ตอนนี้ + ขึ้นขอบแดงถ้านิพจน์ผิด
  function updateDepthPreview(depthInput) {
    const val = evalDepthExpr(depthInput.value, state.machine);
    const invalid = !isFinite(val);
    depthInput.classList.toggle('invalid', invalid);
    depthInput.title = invalid
      ? 'นิพจน์ไม่ถูกต้อง — ใช้ได้แค่ตัวเลข, pt (ความหนาไม้), cd (Cut Deeper) และ + - * / ( )'
      : `= ${val.toFixed(2)} mm  (pt=ความหนาไม้, cd=Cut Deeper)`;
  }
  function colorForLayer(ln) {
    for (const t of tabs) if (t.layerColor[ln]) return t.layerColor[ln];
    return '#cccccc';
  }
  function highlightMapping(ln) {
    const row = document.querySelector(`.mapping-row[data-layer="${CSS.escape(ln)}"]`);
    if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.style.outline = '1px solid var(--amber)'; setTimeout(() => row.style.outline = '', 1200); }
  }
  function invalidateAllJobs() { tabs.forEach(t => { t.lastJob = null; t.gcode = ''; t.stats = null; }); syncView3DIfActive(); }

  /* =========================================================================
   * 7. Tool Library + ทิศทางตัด (cutDirection — ค่ากลาง ใช้ร่วม Outside/Inside)
   * ====================================================================== */
  function bindCutDirection() {
    $('selCutDirection').value = state.machine.cutDirection || 'climb';
    $('selCutDirection').addEventListener('change', (e) => {
      state.machine.cutDirection = e.target.value;
      invalidateAllJobs();
      scheduleSave();
    });
  }

  let selectedTool = null;
  function renderToolList() {
    const host = $('toolList');
    host.innerHTML = '';
    const keys = Object.keys(state.tools).map(Number).sort((a, b) => a - b);
    if (selectedTool == null && keys.length) selectedTool = keys[0];
    keys.forEach(n => {
      const t = state.tools[n];
      const item = document.createElement('div');
      item.className = 'tool-item' + (n === selectedTool ? ' selected' : '');
      item.innerHTML = `<span class="tool-badge">T${n}</span><span class="ti-name">${t.name}${t.isOutsideTool ? ' ★' : ''}</span><span class="ti-dia">Ø${t.diameter}</span><span class="ti-type">${toolTypeBadge(t)}</span>`;
      item.addEventListener('click', () => { selectedTool = n; renderToolList(); renderToolForm(); });
      host.appendChild(item);
    });
    renderToolForm();
  }
  // ข้อความสั้น ๆ บอกชนิดทูล (อ่านอย่างเดียว) สำหรับแถบรายการย่อ
  function toolTypeBadge(t) {
    const type = t.toolType || 'endmill';
    if (type === 'vbit') return `V-bit ${t.vbitAngle || 0}° · Tip Ø${t.vbitTipDiameter || 0}`;
    if (type === 'formtool') return 'Formtool';
    return 'Endmill';
  }
  function renderToolForm() {
    const host = $('toolForm');
    const t = state.tools[selectedTool];
    if (!t) { host.innerHTML = ''; return; }
    const type = t.toolType || 'endmill';
    const F = (key, label, step) => `<label class="fld"><span>${label}</span><input type="number" data-k="${key}" step="${step || 'any'}" value="${t[key]}"></label>`;
    const TYPE_OPTS = [['endmill', 'Endmill'], ['vbit', 'V-bit'], ['formtool', 'Formtool']];
    host.innerHTML = `
      <div class="tool-form-head">
        <strong style="font-family:var(--mono)">แก้ไข T${t.number}</strong>
        <button class="danger" id="btnDelTool">ลบมีด</button>
      </div>
      <label class="fld full2"><span>Tool Name</span><input type="text" data-k="name" value="${t.name}"></label>
      ${F('number', 'Tool Number', '1')}
      ${F('diameter', 'Diameter (mm)', '0.1')}
      <label class="fld"><span>ชนิดทูล</span>
        <select id="selToolType">${TYPE_OPTS.map(([v, l]) => `<option value="${v}" ${v === type ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <span id="vbitFields" style="display:${type === 'vbit' ? 'contents' : 'none'}">
        <label class="fld"><span>องศาดอก (V-bit)</span><input type="number" data-k="vbitAngle" step="1" min="0" max="180" value="${t.vbitAngle || 90}"></label>
        <label class="fld"><span>ขนาดปลายดอก (mm)</span><input type="number" data-k="vbitTipDiameter" step="0.1" min="0" value="${t.vbitTipDiameter || 0}"></label>
      </span>
      ${F('spindle', 'Spindle (rpm)', '100')}
      ${F('passDepth', 'Pass Depth (mm)', '0.1')}
      ${F('feedXY', 'Feed XY (mm/min)', '50')}
      ${F('feedZ', 'Feed Z (mm/min)', '50')}
      ${F('safeHeight', 'Safe Height (mm)', '1')}
      <label class="fld full2 check" style="margin-top:4px">
        <input type="checkbox" id="chkOutsideTool" ${t.isOutsideTool ? 'checked' : ''}>
        ทูลหลักสำหรับตัดนอก (ใช้เป็น default ของ Profile Outside)
      </label>`;
    $('selToolType').addEventListener('change', (e) => {
      t.toolType = e.target.value;
      invalidateAllJobs(); renderToolList(); scheduleSave();
    });
    host.querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      if (k === 'name') t.name = inp.value;
      else if (k === 'number') {
        const newN = parseInt(inp.value, 10);
        if (newN && newN !== t.number && !state.tools[newN]) { delete state.tools[t.number]; t.number = newN; state.tools[newN] = t; selectedTool = newN; }
      } else t[k] = parseFloat(inp.value);
      invalidateAllJobs(); renderToolList(); renderMapping(); scheduleSave();
    }));
    $('chkOutsideTool').addEventListener('change', (e) => {
      // มีได้แค่ตัวเดียว: ติ๊กตัวนี้แล้วปลดตัวอื่นทั้งหมด
      Object.values(state.tools).forEach(tt => tt.isOutsideTool = false);
      t.isOutsideTool = e.target.checked;
      invalidateAllJobs(); renderToolList(); scheduleSave();
    });
    $('btnDelTool').addEventListener('click', () => {
      if (Object.keys(state.tools).length <= 1) { alert('ต้องมีมีดอย่างน้อย 1 ดอก'); return; }
      delete state.tools[selectedTool]; selectedTool = null;
      invalidateAllJobs(); renderToolList(); renderMapping(); scheduleSave();
    });
  }
  $('btnAddTool').addEventListener('click', () => {
    const keys = Object.keys(state.tools).map(Number);
    const n = (keys.length ? Math.max(...keys) : 0) + 1;
    state.tools[n] = MC.makeTool(n, { name: `Tool ${n}` });
    selectedTool = n;
    renderToolList(); renderMapping(); scheduleSave();
  });

  /* =========================================================================
   * 8b. กล่องความหนาไม้ (ย้ายมาจาก Machine Setup — อยู่บนคอลัมน์ Layer)
   *     ใช้ค่าเดียวร่วมกันทุกแท็บไฟล์ที่เปิดอยู่ (ไม่แยกอิสระต่อไฟล์)
   * ====================================================================== */
  function bindThicknessBox() {
    const el = $('woodThicknessInput');
    el.value = state.machine.woodThickness;
    el.addEventListener('change', () => {
      state.machine.woodThickness = parseFloat(el.value) || 0;
      invalidateAllJobs();
      renderMapping(); // เผื่อ Layer อื่นอ้างอิงความหนาไม้อยู่ด้วย
      if ($('chkToolpath').checked) render();
      scheduleSave();
    });
  }

  // พยายามอ่านความหนาจากชื่อไฟล์ (รูปแบบ "18mm" หรือ "6mm" ที่ต้นชื่อไฟล์ เช่น 18MM_001.dxf)
  // คืนค่าตัวเลข (mm) ถ้าจับได้ ไม่งั้นคืน null (ไม่แก้ค่าเดิม)
  function detectThicknessFromFileName(fileName) {
    const m = fileName.match(/^(\d+(?:\.\d+)?)\s*mm/i);
    return m ? parseFloat(m[1]) : null;
  }


  function renderMachineForm() {
    const m = state.machine;
    const host = $('machineForm');
    const N = (key, label, step) => `<label class="fld"><span>${label}</span><input type="number" data-k="${key}" step="${step || 'any'}" value="${m[key]}"></label>`;
    host.innerHTML = `
      <label class="fld"><span>Units</span>
        <select data-k="units"><option value="mm" ${m.units === 'mm' ? 'selected' : ''}>mm</option><option value="inch" ${m.units === 'inch' ? 'selected' : ''}>inch</option></select></label>
      ${N('safeZ', 'Safe Z (mm)', '1')}
      ${N('rapidClearance', 'Rapid Clearance (mm)', '0.5')}
      ${N('pocketStepover', 'Pocket Stepover (%)', '5')}
      ${N('cutDeeper', 'Cut Deeper (mm)', '0.1')}
      <label class="fld"><span>จุดอ้างอิง X0Y0 (มุมของ _ABF_SHEET_BORDER)</span>
        <select data-k="originCorner">
          <option value="bottom-left">มุมล่างซ้าย</option>
          <option value="bottom-right">มุมล่างขวา</option>
          <option value="top-left">มุมบนซ้าย</option>
          <option value="top-right">มุมบนขวา</option>
        </select></label>
      <label class="fld"><span>จุดอ้างอิง Z0</span>
        <select data-k="z0Mode"><option value="top">ผิวบนของไม้</option><option value="table">พื้น Top โต๊ะตัด (สเปกบอร์ด)</option></select></label>
      ${N('tabWidth', 'Tab Width (mm)', '0.5')}
      ${N('tabHeight', 'Tab Height (mm)', '0.5')}
      ${N('tabCount', 'Tab Count', '1')}
      <hr class="form-divider">
      ${N('smallPartThreshold', 'ชิ้นงานขนาดเล็ก (mm)', '1')}
      <small class="hint" style="grid-column:1/-1">ด้านแคบที่สุดของ bounding box ที่ถือว่า "เล็ก" (0 = ปิด) — ใช้กับ layer ที่ขึ้นต้นด้วย cut_outside_</small>
      ${N('smallPartFinalPass', 'ความหนาตัดรอบสุดท้าย (mm)', '0.5')}
      <small class="hint" style="grid-column:1/-1">รอบพิเศษก่อนตัดขาด สำหรับชิ้นเล็กเท่านั้น (0 = ไม่เพิ่มรอบพิเศษ)</small>`;
    host.querySelector('[data-k="originCorner"]').value = m.originCorner;
    host.querySelector('[data-k="z0Mode"]').value = m.z0Mode;
    host.querySelectorAll('input, select').forEach(el => el.addEventListener('change', () => {
      const k = el.dataset.k;
      m[k] = (el.tagName === 'SELECT') ? el.value : parseFloat(el.value);
      invalidateAllJobs();
      if (k === 'originCorner') { reapplyOriginToAllTabs(); }
      scheduleSave();
    }));
  }

  // เปลี่ยนมุมอ้างอิง -> ต้องโหลดไฟล์ใหม่จริง ๆ เพื่อคำนวณ offset ใหม่ (เตือนผู้ใช้)
  function reapplyOriginToAllTabs() {
    if (tabs.length) setWarn(['เปลี่ยนจุดอ้างอิง X0Y0 แล้ว — กรุณาเปิดไฟล์ DXF ที่เปิดอยู่ใหม่อีกครั้งเพื่อคำนวณตำแหน่งใหม่']);
  }

  /* =========================================================================
   * 9. Post Processor
   * ====================================================================== */
  function bindPostFields() {
    $('taToolChange').value = state.toolChange;
    $('taHeader').value = state.header;
    $('taFooter').value = state.footer;
    $('taToolChange').addEventListener('input', () => { state.toolChange = $('taToolChange').value; scheduleSave(); });
    $('taHeader').addEventListener('input', () => { state.header = $('taHeader').value; scheduleSave(); });
    $('taFooter').addEventListener('input', () => { state.footer = $('taFooter').value; scheduleSave(); });
  }

  /* =========================================================================
   * 10. คำนวณ Job + สร้าง G-code (ทุกไฟล์พร้อมกัน) + Export .zip
   * ====================================================================== */
  function mappingsForTab(tab) {
    const m = {};
    tab.dxf.layers.forEach(ln => {
      if (ln === BORDER_LAYER || HIDDEN_LAYERS.indexOf(ln) !== -1) return;
      const raw = resolveMapping(ln);
      const evaluated = evalDepthExpr(raw.depth, state.machine);
      m[ln] = Object.assign({}, raw, { depth: isFinite(evaluated) ? evaluated : 0 });
    });
    return m;
  }
  function computeJob(tab) {
    if (tab.doorMode && tab.doorMode.enabled) {
      const dm = tab.doorMode;
      const borderDepthNum = evalDepthExpr(dm.borderDepth, state.machine);
      const resolvedDoorMode = Object.assign({}, dm, { borderDepth: isFinite(borderDepthNum) ? borderDepthNum : 0 });
      const res = TP.generateDoorProfile(tab.dxf, resolvedDoorMode, state.tools, state.machine, toRealZ);
      tab.lastJob = { operations: res.operations, warnings: res.warnings };
      tab.lastDoors = res.doors;
    } else {
      tab.lastJob = TP.generate(tab.dxf, mappingsForTab(tab), state.tools, state.machine, toRealZ);
      tab.lastDoors = null;
    }
    return tab.lastJob;
  }

  /* =========================================================================
   * ตรวจสิทธิ์ล่าสุดจาก DB ก่อน generate จริง — ทำพร้อมกันกับ generate + delay หลอก
   * ผู้ใช้เห็นแค่ "กำลังสร้าง G-code..." 3-4 วินาที
   * เบื้องหลัง: Supabase เช็คสถานะจริง ถ้าไม่ผ่าน → error + logout อัตโนมัติ
   * ====================================================================== */
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function checkLatestProfile() {
    try {
      const { data, error } = await AC.sb
        .from('profiles')
        .select('status, expires_at')
        .eq('id', (await AC.getUser()).id)
        .single();
      if (error || !data) return { ok: false, reason: 'network' };
      if (data.status === 'pending')   return { ok: false, reason: 'pending' };
      if (data.status === 'suspended') return { ok: false, reason: 'suspended' };
      if (data.expires_at && new Date(data.expires_at) < new Date()) return { ok: false, reason: 'expired' };
      if (data.status !== 'active')    return { ok: false, reason: 'suspended' };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'network' };
    }
  }

  const AUTH_ERROR_MSG = {
    pending:   'บัญชีของคุณยังรอการอนุมัติจากแอดมิน',
    suspended: 'สิทธิ์การใช้งานของคุณถูกระงับ กรุณาติดต่อแอดมิน',
    expired:   'สิทธิ์การใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อแอดมิน',
    network:   'ไม่สามารถตรวจสอบสิทธิ์ได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต'
  };

  $('btnGenerate').addEventListener('click', async () => {
    if (!tabs.length) { setWarn(['ยังไม่ได้เปิดไฟล์ DXF']); return; }

    // ล็อก UI ระหว่างรอ
    const btnGen = $('btnGenerate');
    const btnExport = $('btnExportZip');
    const origText = btnGen.textContent;
    btnGen.textContent = 'กำลังสร้าง G-code...';
    btnGen.disabled = true;
    if (btnExport) btnExport.disabled = true;

    try {
      // 3 งานพร้อมกัน: generate จริง + เช็คสิทธิ์ + หน่วงเวลาหลอก
      const fakeDelay = 3000 + Math.random() * 1000;
      const [, profileResult] = await Promise.all([
        (async () => {
          // compute ทุก tab (synchronous จริง ๆ แต่ห่อ async ให้อยู่ใน Promise.all)
          for (const tab of tabs) {
            computeJob(tab);
            const out = GC.generate(tab.lastJob, { machine: state.machine, header: state.header, footer: state.footer, toolChange: state.toolChange });
            tab.gcode = out.gcode; tab.stats = out.stats;
          }
        })(),
        checkLatestProfile(),
        delay(fakeDelay)
      ]);

      // เช็คผลสิทธิ์ หลัง Promise.all ครบ
      if (!profileResult.ok) {
        const msg = AUTH_ERROR_MSG[profileResult.reason] || AUTH_ERROR_MSG.network;
        setWarn([msg]);
        await AC.logout(); // auto-logout ทุกกรณีที่ไม่ผ่าน
        return;
      }

      // สิทธิ์ผ่าน → แสดงผล G-code ตามปกติ
      const allWarnings = [];
      let totalLines = 0, totalChanges = 0, totalCut = 0, totalRapid = 0, totalMin = 0;
      for (const tab of tabs) {
        allWarnings.push(...tab.lastJob.warnings.map(w => `[${tab.fileName}] ${w}`));
        const s = tab.stats;
        totalLines += s.lineCount; totalChanges += s.toolChanges;
        totalCut += s.cutMM; totalRapid += s.rapidMM; totalMin += s.estMinutes;
      }
      setWarn(allWarnings.length ? allWarnings : [`สร้าง G-code สำเร็จ ${tabs.length} ไฟล์`], allWarnings.length === 0);
      $('gStats').innerHTML =
        `รวม ${tabs.length} ไฟล์ · บรรทัด: <b>${totalLines}</b>　เปลี่ยนมีด: <b>${totalChanges}</b><br>` +
        `ระยะกัด: <b>${totalCut.toFixed(0)}</b> mm　ระยะเร็ว: <b>${totalRapid.toFixed(0)}</b> mm<br>` +
        `เวลาโดยประมาณรวม: <b>${totalMin.toFixed(1)}</b> นาที`;
      refreshOutputFileSelect();
      if (tabs.length) { $('outputFileSelect').value = tabs[0].id; showOutputFor(tabs[0].id); }
      $('chkToolpath').checked = true;
      render();
      switchTab('output');

    } finally {
      // คืน UI เสมอ ไม่ว่าจะผ่านหรือ error
      btnGen.textContent = origText;
      btnGen.disabled = false;
      if (btnExport) btnExport.disabled = false;
    }
  });

  function refreshOutputFileSelect() {
    const sel = $('outputFileSelect');
    sel.innerHTML = tabs.map(t => `<option value="${t.id}">${t.fileName}</option>`).join('');
    sel.onchange = () => showOutputFor(sel.value);
  }
  function showOutputFor(tabId) {
    const tab = tabs.find(t => t.id === tabId);
    $('gcodeOut').value = tab ? tab.gcode : '';
  }

  $('btnExportZip').addEventListener('click', async () => {
    const ready = tabs.filter(t => t.gcode);
    if (!ready.length) { setWarn(['ยังไม่มี G-code ให้ Export — กด "สร้าง G-code ทุกไฟล์" ก่อน']); return; }
    const files = ready.map(t => ({ name: t.fileName.replace(/\.dxf$/i, '') + '.nc', content: t.gcode }));
    try {
      await PS.downloadZip('gcode-output.zip', files);
    } catch (err) { setWarn(['สร้างไฟล์ zip ไม่สำเร็จ: ' + err.message]); }
  });

  /* =========================================================================
   * 11. ปุ่ม "บันทึก" (force save ทันที) + แท็บฝั่งขวา + ปุ่มควบคุม view
   * ====================================================================== */
  $('btnSave').addEventListener('click', forceSave);

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
    if (name === 'mapping') refreshLayerPaneMode();
  }
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  $('btnZoomIn').addEventListener('click', () => zoomCenter(1.2));
  $('btnZoomOut').addEventListener('click', () => zoomCenter(1 / 1.2));
  $('btnFit').addEventListener('click', () => { if (guard3D()) return; fitView(); });
  $('btnView3D').addEventListener('click', toggle3DView);

  /* =========================================================================
   * 4b. พรีวิว 3 มิติ (Simulate3D) — สลับกับ canvas 2D เดิม ไม่ลบของเดิม
   * ====================================================================== */
  // ใช้ปิดกั้นการกระทำที่จะไปยุ่งกับ tab/ไฟล์ DXF ระหว่างเปิดพรีวิว 3 มิติอยู่ —
  // เพราะการสลับแท็บ/เปิดไฟล์ใหม่/พอดีจอ (ของ 2D) ระหว่างที่ 3D กำลัง rebuild หรือกำลัง
  // แสดงผลอยู่ อาจไปชนกับ state ของ 3D (heightmap/texture/action queue) ที่ผูกกับ tab
  // เดิมอยู่ ปลอดภัยกว่าถ้าบังคับให้ออกจากโหมด 3D ก่อนเสมอ
  function guard3D() {
    if (!view3DActive) return false;
    setWarn(['กรุณาออกจากหน้าพรีวิว 3 มิติก่อน (กดปุ่ม 3D อีกครั้ง) จึงจะใช้งานปุ่มนี้ได้']);
    return true;
  }

  function syncView3DIfActive() {
    if (!view3DActive) return;
    const tab = activeTab();
    if (!tab || !window.Simulate3D) return;
    if (!tab.lastJob) computeJob(tab);
    window.Simulate3D.loadJob(tab, state.machine);
  }
  function toggle3DView() {
    const tab = activeTab();
    if (!tab) { setWarn(['ยังไม่ได้เปิดไฟล์ DXF']); return; }
    view3DActive = !view3DActive;
    $('btnView3D').classList.toggle('active', view3DActive);
    if (view3DActive) {
      canvas.parentElement.style.display = 'none';
      canvas3dWrap.style.display = '';
      if (!window.Simulate3D) { setWarn(['โหลด Three.js ไม่สำเร็จ — ตรวจการเชื่อมต่ออินเทอร์เน็ต']); return; }
      window.Simulate3D.init(canvas3dWrap);
      if (!tab.lastJob) computeJob(tab);
      window.Simulate3D.loadJob(tab, state.machine);
    } else {
      canvas3dWrap.style.display = 'none';
      canvas.parentElement.style.display = '';
      resizeCanvas();
    }
  }
  function zoomCenter(f) {
    const cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2;
    const before = S2W(cx, cy);
    view.scale *= f;
    view.ox = cx - before.x * view.scale;
    view.oy = (canvas.clientHeight - cy) - before.y * view.scale;
    render();
  }
  $('chkStartPoints').addEventListener('change', render);
  $('chkToolpath').addEventListener('change', () => { const t = activeTab(); if (t && $('chkToolpath').checked) computeJob(t); render(); });

  function setWarn(list, ok) {
    const host = $('warnArea');
    host.innerHTML = list.map(w => `<div class="${ok ? 'ok' : ''}">${ok ? '✓ ' : '⚠ '}${w}</div>`).join('');
  }

  /* =========================================================================
   * 12. เริ่มต้นแอป (เรียกหลัง auth+settings โหลดเสร็จ)
   * ====================================================================== */
  function initApp() {
    renderToolList();
    bindCutDirection();
    renderMachineForm();
    bindThicknessBox();
    refreshLayerPaneMode();
    bindPostFields();
    updateLegend();
    resizeCanvas();
    fitView();
    refreshOutputFileSelect();
    window.addEventListener('resize', resizeCanvas);
  }

  bootAuth();

})();
