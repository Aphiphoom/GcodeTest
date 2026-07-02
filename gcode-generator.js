/* =============================================================================
 * gcode-generator.js (v3)
 * -----------------------------------------------------------------------------
 * เปลี่ยนจากเดิม (v2):
 *  - ตัดระบบ phase 1/phase 2 ออกทั้งหมด — จัดลำดับใหม่ตาม "ชื่อ Layer + เลขลำดับ"
 *    ที่กรอกไว้ในหน้า Layer Mapping (ดู orderOperations() ด้านล่าง)
 *  - ตัด G4 P2 ออกหลังคำสั่งเปิดสปินเดิล
 *  - Pocket: ไม่ยกมีดขึ้นเลยตลอดกระบวนการ (ทุก ring ทุก pass) จนกว่าจะเสร็จสมบูรณ์
 *  - รองรับ circleMeta: ถ้า operation ตรวจพบว่าเป็นวงกลมจริง (และไม่มี tabs) จะออก
 *    คำสั่ง G2/G3 (ส่วนโค้งสมบูรณ์) แทนการเดิน G1 ทีละจุด
 * ========================================================================== */

(function (global) {
  'use strict';

  function fmt(n) {
    if (Math.abs(n) < 1e-9) n = 0;
    let s = n.toFixed(3);
    s = s.replace(/\.?0+$/, '');
    return s === '' || s === '-' ? '0' : s;
  }

  function fillTemplate(tpl, toolNumber, toolName) {
    return tpl.replace(/\{tool\}/g, toolNumber).replace(/\{toolName\}/g, toolName || '');
  }

  function pathLength(pts) {
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    return L;
  }

  /* ---------------------------------------------------------------------------
   * สร้างเส้นทางที่ลง Z แบบ "ราย 45 องศา" ตามแนวเส้นทางจริง (ไม่ใช่ดิ่งตรง)
   * เดินไปตาม path สะสมระยะทาง ระยะแนวนอนที่ใช้ ramp = |toZ-fromZ| (มุม 45° จึง
   * แนวนอน=แนวตั้งพอดี) เมื่อถึงระยะนั้นแล้ว Z จะเท่ากับ toZ ตลอดส่วนที่เหลือ
   * ถ้า path สั้นกว่าระยะ ramp ที่ต้องการ (ชิ้นงานเล็กมาก) จะ clamp ให้จบที่ปลาย
   * path พอดี (ลาดชันกว่า 45° เล็กน้อยในกรณีนี้ แทนการวนหลายรอบเพื่อความง่าย)
   * คืนอาเรย์ [{x,y,z}, ...] จุดแรก = จุดเริ่ม path ที่ความสูง fromZ
   * ------------------------------------------------------------------------- */
  function rampedPath(path, fromZ, toZ) {
    const rampDist = Math.abs(toZ - fromZ);
    const out = [{ x: path[0].x, y: path[0].y, z: fromZ }];
    if (rampDist < 1e-6) {
      for (let i = 1; i < path.length; i++) out.push({ x: path[i].x, y: path[i].y, z: toZ });
      return out;
    }
    const total = pathLength(path);
    const effectiveRampDist = Math.min(rampDist, Math.max(total, 1e-6)); // กันกรณี path สั้นกว่าระยะ ramp
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-9) continue;
      const accBefore = acc, accAfter = acc + segLen;
      if (accAfter <= effectiveRampDist) {
        const z = fromZ + (toZ - fromZ) * (accAfter / effectiveRampDist);
        out.push({ x: b.x, y: b.y, z });
      } else if (accBefore >= effectiveRampDist) {
        out.push({ x: b.x, y: b.y, z: toZ });
      } else {
        const t = (effectiveRampDist - accBefore) / segLen;
        const mx = a.x + t * (b.x - a.x), my = a.y + t * (b.y - a.y);
        out.push({ x: mx, y: my, z: toZ });
        out.push({ x: b.x, y: b.y, z: toZ });
      }
      acc = accAfter;
    }
    return out;
  }

  function tabbedPath(path, tabs, zCut, tabTopZ) {
    const cutGoesNegative = zCut < 0 || tabTopZ < 0;
    const isDeeper = cutGoesNegative ? (zCut < tabTopZ - 1e-6) : (zCut > tabTopZ + 1e-6);

    if (!tabs || !tabs.length || !isDeeper) {
      return path.map(p => ({ x: p.x, y: p.y, z: zCut }));
    }
    const inTab = (d) => tabs.some(t => d >= t.start - 1e-6 && d <= t.end + 1e-6);

    const out = [];
    let acc = 0;
    out.push({ x: path[0].x, y: path[0].y, z: inTab(0) ? tabTopZ : zCut });
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-9) continue;
      const cuts = [];
      for (const t of tabs) {
        for (const edge of [t.start, t.end]) {
          if (edge > acc + 1e-6 && edge < acc + segLen - 1e-6) cuts.push(edge);
        }
      }
      cuts.sort((p, q) => p - q);
      for (const c of cuts) {
        const tt = (c - acc) / segLen;
        const x = a.x + tt * (b.x - a.x), y = a.y + tt * (b.y - a.y);
        out.push({ x, y, z: inTab(c) ? tabTopZ : zCut });
      }
      acc += segLen;
      out.push({ x: b.x, y: b.y, z: inTab(acc) ? tabTopZ : zCut });
    }
    return out;
  }

  /* ---------------------------------------------------------------------------
   * พื้นที่ของ "ชิ้นงาน" ที่ layer นี้ตัด — ใช้เรียงลำดับเล็กก่อน-ใหญ่ทีหลัง
   * คืนพื้นที่ของ contour ที่ใหญ่ที่สุดใน layer (เส้นตัดนอกของชิ้นงานหลัก) — drill/pocket
   * ที่ไม่มี path คืน 0 (ถือว่าเล็กสุด มาก่อน) เพื่อไม่ให้ดันไปท้ายโดยไม่ตั้งใจ
   * ------------------------------------------------------------------------- */
  function layerCutArea(ops) {
    let maxArea = 0;
    for (const op of ops) {
      const a = opCutArea(op);
      if (a > maxArea) maxArea = a;
    }
    return maxArea;
  }

  // ตัดจุดปิดซ้ำหัว-ท้ายออกถ้ามี (เผื่อ signedArea คำนวณเพี้ยนจากจุดซ้ำ)
  function stripClosingLocal(pts) {
    if (pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) return pts.slice(0, -1);
    }
    return pts;
  }

  /* ---------------------------------------------------------------------------
   * จัดลำดับ operations ตาม "ชื่อ Layer" — แทนที่ระบบ phase เดิมทั้งหมด
   *  1) Layer ที่ล็อกท้ายสุด (เช่น _ABF_CUTTING_LINES) ไปอยู่ท้ายสุดเสมอ
   *  2) Layer ที่กรอกเลขลำดับ มาก่อนเสมอ เรียงน้อย->มาก
   *  3) Layer ที่ไม่กรอกเลขลำดับ ตามมาทีหลัง เรียงเลขมีดมาก->น้อย
   *  4) ไม่จัดกลุ่มลดการเปลี่ยนมีด — เรียงตามลำดับเลเยอร์เป๊ะ ๆ เป็นหลัก
   * ------------------------------------------------------------------------- */
  function orderOperations(operations, machine) {
    const lockedLayer = (global.MachineConfig && global.MachineConfig.LOCKED_LAST_LAYER) || '_ABF_CUTTING_LINES';

    const groups = {};
    const layerOrder = [];
    for (const op of operations) {
      if (!groups[op.layer]) { groups[op.layer] = []; layerOrder.push(op.layer); }
      groups[op.layer].push(op);
    }

    const locked = [];
    const explicit = [];
    const unfilled = [];

    for (const layerName of layerOrder) {
      if (layerName === lockedLayer) { locked.push(layerName); continue; }
      const ops = groups[layerName];
      const orderVal = ops[0].order;
      if (orderVal !== null && orderVal !== undefined && !Number.isNaN(orderVal)) {
        explicit.push({ layerName, order: orderVal });
      } else {
        unfilled.push({ layerName, toolNumber: ops[0].toolNumber });
      }
    }

    explicit.sort((a, b) => a.order - b.order);
    // เลขมีดเดียวกัน: Profile Outside (ตัดแยกชิ้นงานออกจากแผ่น) ต้องอยู่ท้ายกลุ่มมีดนั้นเสมอ
    // กันกรณี Pocket/Drill/Inside ที่ใช้มีดเดียวกันแต่ไม่ได้กรอกลำดับ ดันถูกตัดทีหลังการ
    // ตัดนอกที่ทำให้ชิ้นงานหลุดจากแผ่นไปแล้ว (ตำแหน่งเพี้ยน/ชิ้นงานขยับได้)
    //
    // และในกลุ่ม Profile Outside ที่มีดเดียวกันด้วยกันเอง: เรียง "ชิ้นเล็กก่อน-ใหญ่ทีหลัง"
    // (พื้นที่ภายในเส้นตัดนอกน้อย -> มาก) เพราะเมื่อตัดชิ้นใหญ่หลุดออกไปก่อน ชิ้นเล็กที่ยัง
    // ติดอยู่ในแผ่นอาจเสียการรองรับ/ขยับได้ ตัดชิ้นเล็กให้เสร็จก่อนปลอดภัยกว่า
    unfilled.sort((a, b) => {
      if (b.toolNumber !== a.toolNumber) return b.toolNumber - a.toolNumber;
      const aOut = groups[a.layerName][0].cutType === 'Profile Outside' ? 1 : 0;
      const bOut = groups[b.layerName][0].cutType === 'Profile Outside' ? 1 : 0;
      if (aOut !== bOut) return aOut - bOut;
      // ถึงตรงนี้แปลว่ามีดเดียวกัน + เป็น Profile Outside ทั้งคู่ (หรือไม่ใช่ทั้งคู่) -> เรียงตามขนาด
      return layerCutArea(groups[a.layerName]) - layerCutArea(groups[b.layerName]);
    });

    const finalLayerNames = explicit.map(e => e.layerName)
      .concat(unfilled.map(u => u.layerName))
      .concat(locked);

    return finalLayerNames.map(layerName => {
      const ops = groups[layerName];
      // เรียง ops ภายใน layer เดียวกันด้วย — สำคัญมากเพราะไฟล์จริงมักรวม Profile Outside
      // ของชิ้นงานหลายชิ้นไว้ใน layer เดียว (เช่น cut_outside_18) การเรียงระดับ layer
      // อย่างเดียวจึงไม่พอ ต้องเรียง "ชิ้นเล็กก่อน-ใหญ่ทีหลัง" ที่ระดับ op ด้วย
      const sortedOps = sortOpsWithinLayer(ops, layerName, machine);
      return { layerName, toolNumber: ops[0].toolNumber, tool: ops[0].tool, ops: sortedOps };
    });
  }

  /* ---------------------------------------------------------------------------
   * เรียง operations ภายใน layer เดียวกัน:
   *   - แยก contour ที่เป็น Profile Outside ออกมาเรียงตามพื้นที่ (เล็ก->ใหญ่) แล้ววางท้าย
   *   - op อื่น ๆ (drill/pocket/Profile Inside/OnLine) คงลำดับเดิมไว้ด้านหน้า
   *   - เหตุผลเดียวกับการเรียงระดับ layer: ตัดชิ้นเล็กที่ยังมีแผ่นรองรับให้เสร็จก่อน
   *     ค่อยตัดชิ้นใหญ่ (และตัดนอกที่ทำให้ชิ้นหลุดควรอยู่ท้ายสุดของ layer เสมอ)
   * ------------------------------------------------------------------------- */
  function sortOpsWithinLayer(ops, layerName, machine) {
    const outside = [];
    const others = [];
    for (const op of ops) {
      if (op.kind === 'contour' && op.cutType === 'Profile Outside') outside.push(op);
      else others.push(op);
    }
    if (outside.length < 2) {
      // ถ้ามีแค่ 1 ชิ้น ยังต้องเพิ่ม preFinal pass ถ้าเข้าเงื่อนไขชิ้นเล็ก
      if (outside.length === 1 && isCutOutsideLayer(layerName)) {
        return others.concat([applySmallPartPass(outside[0], machine)]);
      }
      return ops;
    }
    if (!isCutOutsideLayer(layerName)) {
      // layer ที่ไม่ใช่ cut_outside_: เรียงตาม area เดิม ไม่แบ่งกลุ่มเล็ก/ใหญ่
      outside.sort((a, b) => opCutArea(a) - opCutArea(b));
      return others.concat(outside);
    }

    const threshold = parseFloat((machine || {}).smallPartThreshold) || 0;
    if (threshold <= 0) {
      // threshold = 0 → ปิดฟีเจอร์ เรียงตาม area เหมือนเดิม
      outside.sort((a, b) => opCutArea(a) - opCutArea(b));
      return others.concat(outside);
    }

    // แบ่งกลุ่ม: ชิ้นที่ด้านแคบที่สุดของ bounding box < threshold = "เล็ก"
    const small = [], large = [];
    for (const op of outside) {
      (opNarrowSide(op) < threshold ? small : large).push(op);
    }
    small.sort((a, b) => opNarrowSide(a) - opNarrowSide(b)); // เล็กก่อน (narrowSide น้อย→มาก)
    large.sort((a, b) => opCutArea(a) - opCutArea(b));       // ใหญ่เรียงตาม area

    // เพิ่ม preFinal pass ให้ชิ้นเล็กทุกชิ้น
    const smallWithPass = small.map(op => applySmallPartPass(op, machine));
    return others.concat(smallWithPass).concat(large);
  }

  // เช็คว่า layer นี้เป็น cut_outside_ ที่ต้องใช้ logic ชิ้นเล็ก/ใหญ่
  function isCutOutsideLayer(layerName) {
    return typeof layerName === 'string' && layerName.toLowerCase().indexOf('cut_outside_') === 0;
  }

  // คำนวณ bounding box แล้วคืนค่า "ด้านแคบที่สุด" ของชิ้นงาน
  // วิธีนี้ตรงตาม spec: ตีกรอบ path ทั้งเส้นก่อน แล้วค่อยวัดว่ากรอบนั้นกว้าง/ยาวแค่ไหน
  // ไม่ได้ดูว่าเส้นใดเส้นหนึ่งสั้น (เพราะชิ้นงานอาจมีรูปทรงโค้ง/หยัก แต่กรอบยังใหญ่พอ)
  function opNarrowSide(op) {
    if (op.kind !== 'contour' || !op.path || op.path.length < 2) return Infinity;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of op.path) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX, h = maxY - minY;
    return Math.min(w, h);
  }

  // แทรก preFinal pass ใน op ของชิ้นเล็ก:
  //   passes = [...passesBefore, finalZ] → [...passesBefore, preFinalZ, finalZ]
  //   ไม่ mutate op เดิม — คืน op ใหม่ที่ copy passes แล้ว
  function applySmallPartPass(op, machine) {
    const finalPassThickness = parseFloat((machine || {}).smallPartFinalPass) || 0;
    if (finalPassThickness <= 0 || !op.passes || op.passes.length < 1) return op;
    const passes = op.passes;
    const finalZ = passes[passes.length - 1]; // Z ของรอบสุดท้าย (realZ ติดลบ = ทะลุ)
    const preFinalZ = finalZ + finalPassThickness; // สูงกว่า finalZ finalPassThickness mm
    // preFinalZ ต้องอยู่ระหว่าง pass ก่อนหน้ากับ finalZ:
    //   - ถ้า preFinalZ >= 0 แปลว่าเหนือผิวไม้ ไม่ต้องตัดรอบนี้ (ยังไม่แตะเนื้อไม้)
    //   - ถ้า passes[-2] มีอยู่และ preFinalZ <= passes[-2] แปลว่า pass ก่อนหน้าลึกกว่า
    //     preFinal อยู่แล้ว ไม่ต้องแทรก (จะทำให้ Z ขึ้นสูง = wrong direction)
    const prevPass = passes.length >= 2 ? passes[passes.length - 2] : null;
    if (preFinalZ <= finalZ) return op; // preFinalZ ต้องสูงกว่า finalZ เสมอ (กัดน้อยกว่า)
    // block เฉพาะเมื่อ pass ก่อนหน้าลึกกว่า preFinal (จะทำให้ Z ต้องขึ้นสูง = wrong direction)
    if (prevPass !== null && prevPass < preFinalZ) return op;
    const newPasses = passes.slice(0, -1).concat([preFinalZ, finalZ]);
    return Object.assign({}, op, { passes: newPasses });
  }

  // พื้นที่ของ contour op เดียว (ใช้เรียงขนาดชิ้นงานระดับ op + layerCutArea)
  function opCutArea(op) {
    if (op.kind !== 'contour' || !op.path || op.path.length < 3) return 0;
    return Math.abs(signedAreaLocal(stripClosingLocal(op.path)));
  }

  // signedArea แบบโลคัล (ไม่พึ่ง ToolpathGenerator) เผื่อโหลดสคริปต์คนละลำดับ
  function signedAreaLocal(pts) {
    let a = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  /* ---------------------------------------------------------------------------
   * ฟังก์ชันหลัก: generate(job, config) -> { gcode, stats }
   * ------------------------------------------------------------------------- */
  function generate(job, config) {
    const { machine, header, footer, toolChange } = config;
    const lines = [];
    const z0Offset = (machine.z0Mode === 'table') ? (parseFloat(machine.woodThickness) || 0) : 0;
    const safeZ = parseFloat(machine.safeZ) + z0Offset;
    const clearance = parseFloat(machine.rapidClearance || 3) + z0Offset;
    let stats = { rapidMM: 0, cutMM: 0, lineCount: 0, toolChanges: 0 };
    let lastTool = null;
    let cur = { x: null, y: null, z: null };

    const emit = (s) => lines.push(s);
    const blank = () => { if (lines.length && lines[lines.length - 1] !== '') lines.push(''); };

    function rapid(x, y, z) {
      let s = 'G0';
      if (x !== undefined) s += ' X' + fmt(x);
      if (y !== undefined) s += ' Y' + fmt(y);
      if (z !== undefined) s += ' Z' + fmt(z);
      emit(s); trackMove(x, y, z, true);
    }
    function feed(x, y, z, f) {
      let s = 'G1';
      if (x !== undefined) s += ' X' + fmt(x);
      if (y !== undefined) s += ' Y' + fmt(y);
      if (z !== undefined) s += ' Z' + fmt(z);
      if (f !== undefined) s += ' F' + fmt(f);
      emit(s); trackMove(x, y, z, false);
    }
    // วงกลมเต็มวง 1 รอบ จาก fromZ ลง/ขึ้นไปที่ toZ ตลอดการหมุน 360° (helix) — ถ้า
    // fromZ === toZ จะกลายเป็นวงกลมแบนปกติโดยอัตโนมัติ (ค่า Z ไม่เปลี่ยนตลอดวง)
    function helixTurn(cx, cy, startX, startY, fromZ, toZ, clockwise, f) {
      const iVal = cx - startX, jVal = cy - startY;
      const cmd = clockwise ? 'G2' : 'G3';
      emit(`${cmd} X${fmt(startX)} Y${fmt(startY)} Z${fmt(toZ)} I${fmt(iVal)} J${fmt(jVal)} F${fmt(f)}`);
      const r = Math.hypot(iVal, jVal);
      stats.cutMM += 2 * Math.PI * r;
      cur = { x: startX, y: startY, z: toZ };
    }
    function trackMove(x, y, z, isRapid) {
      const nx = x !== undefined ? x : cur.x;
      const ny = y !== undefined ? y : cur.y;
      const nz = z !== undefined ? z : cur.z;
      if (cur.x !== null) {
        const d = Math.hypot((nx ?? cur.x) - cur.x, (ny ?? cur.y) - cur.y, (nz ?? cur.z) - cur.z);
        if (isRapid) stats.rapidMM += d; else stats.cutMM += d;
      }
      cur = { x: nx, y: ny, z: nz };
    }

    emit('(Generated by DXF to G-Code Generator)');
    emit('(' + new Date().toISOString() + ')');
    if (header && header.trim()) header.split(/\r?\n/).forEach(l => emit(l));
    blank();

    const blocks = orderOperations(job.operations, machine);

    for (const block of blocks) {
      const tool = block.tool;
      if (lastTool !== block.toolNumber) {
        blank();
        emit(`(--- Tool ${block.toolNumber}: ${tool.name} | Ø${tool.diameter}mm ---)`);
        if (toolChange && toolChange.trim()) {
          fillTemplate(toolChange, block.toolNumber, tool.name).split(/\r?\n/).forEach(l => emit(l));
        }
        emit(`M3 S${Math.round(tool.spindle)}`);
        stats.toolChanges++;
        lastTool = block.toolNumber;
        blank();
      }
      emit(`(Layer: ${block.layerName})`);
      for (const op of block.ops) {
        if (op.kind === 'drill') emitDrill(op);
        else if (op.kind === 'pocket') emitPocket(op);
        else if (op.kind === 'doorprofile') emitDoorProfile(op);
        else emitContour(op);
      }
    }

    blank();
    if (footer && footer.trim()) footer.split(/\r?\n/).forEach(l => emit(l));
    else { emit('M5'); emit(`G0 Z${fmt(safeZ)}`); emit('M30'); }

    stats.lineCount = lines.length;
    const feedXY = parseFloat((job.operations[0] && job.operations[0].tool && job.operations[0].tool.feedXY) || 3000);
    stats.estMinutes = stats.cutMM / Math.max(1, feedXY) + stats.rapidMM / 8000;

    return { gcode: lines.join('\n'), stats };

    function emitContour(op) {
      const t = op.tool;
      emit(`(${op.cutType} | layer ${op.layer})`);

      if (op.circleMeta && (!op.tabs || !op.tabs.length)) {
        // วงกลมจริง: ลงทุก pass แบบ helix (เกลียว) ตามที่ตั้งใจ ไม่ใช่ดิ่งตรง 45°
        const { cx, cy, r } = op.circleMeta;
        const clockwise = signedAreaLocal(op.path) < 0;
        const startX = cx + r, startY = cy;
        rapid(undefined, undefined, safeZ);
        rapid(startX, startY, undefined);
        rapid(undefined, undefined, clearance);
        let fromZ = clearance;
        op.passes.forEach((zCut) => {
          helixTurn(cx, cy, startX, startY, fromZ, zCut, clockwise, t.feedXY);
          fromZ = zCut;
        });
        // วงแบนปิดท้ายที่ระดับสุดท้าย — เก็บรอย seam ของเกลียว (มีดอยู่ที่ Z สุดท้ายแล้ว
        // helixTurn ที่ fromZ===toZ จึงเป็นวงกลมแบน ไม่เปลี่ยน Z ตลอดวง)
        if (op.passes.length) {
          const zLast = op.passes[op.passes.length - 1];
          helixTurn(cx, cy, startX, startY, zLast, zLast, clockwise, t.feedXY);
        }
        rapid(undefined, undefined, safeZ);
        blank();
        return;
      }

      // รูปทรงทั่วไป: ทุก pass ลงด้วยมุม 45° ตามแนวเส้นทางจริง (ไม่ดิ่งตรง) และไม่ยก
      // Z ระหว่างเปลี่ยน pass เลย (ยกขึ้น Safe Z แค่ตอนเริ่มครั้งแรกกับตอนจบทั้งหมด)
      // ถ้ามีมุมโค้งจริง (arcRanges) ที่อยู่นอกโซน ramp แล้ว จะออก G2/G3 เฉพาะช่วงนั้นแทน
      // การเดินจุดทีละจุด (เช่น สี่เหลี่ยมที่ลบมุมเป็นโค้ง)
      const startPt = op.path[0];
      const lastIdx = op.passes.length - 1;
      rapid(undefined, undefined, safeZ);
      rapid(startPt.x, startPt.y, undefined);
      rapid(undefined, undefined, clearance);
      let fromZ = clearance;
      op.passes.forEach((zCut, idx) => {
        const isLast = (idx === lastIdx);
        if (op.tabs && op.tabs.length) {
          // มี tabs: ใช้ดิ่งตรงแบบเดิม (ผสม ramp + tab กลางทางซับซ้อนเกินไปในรอบนี้)
          if (idx > 0) feed(startPt.x, startPt.y, undefined, t.feedXY);
          feed(undefined, undefined, zCut, t.feedZ);
          const pts = tabbedPath(op.path, op.tabs, zCut, op.tabTopZ);
          for (let i = 1; i < pts.length; i++) feed(pts[i].x, pts[i].y, pts[i].z, t.feedXY);
        } else if (!op.closed) {
          // เส้นเปิด (เช่น Profile On Line ปลายไม่บรรจบ):
          //  - ขึ้น pass ใหม่: ย้อนกลับจุดเริ่ม "ตามแนวเส้น" (อยู่ในร่องเดิม ไม่ตัดทแยงข้ามชิ้นงาน)
          //  - pass สุดท้าย: ramp ลง → ย้อนกลับจุดเริ่มที่ระดับเต็ม → วิ่งเต็มเส้น เพื่อไม่ให้เหลือลิ่มต้นเส้น
          if (idx > 0) emitReverseRetrace(op.path, fromZ, t.feedXY);
          if (isLast) emitOpenLastPass(op.path, fromZ, zCut, t.feedXY);
          else emitRampedPathWithArcs(op.path, op.arcRanges, fromZ, zCut, t.feedXY);
        } else {
          if (idx > 0) feed(startPt.x, startPt.y, undefined, t.feedXY); // กลับจุดเริ่มที่ความสูงเดิม (ไม่ยก)
          emitRampedPathWithArcs(op.path, op.arcRanges, fromZ, zCut, t.feedXY);
          // เส้นปิด pass สุดท้าย: ลูปวิ่งกลับถึงจุดเริ่มแล้ว ตัดต่อจากจุดเริ่มไปจนสุดช่วง ramp
          // ที่ระดับเต็ม เพื่อเก็บลิ่มที่ ramp ทิ้งไว้ตรงจุดดิ่งมีด
          if (isLast) emitRampCloseOff(op.path, fromZ, zCut, t.feedXY);
        }
        fromZ = zCut;
      });
      rapid(undefined, undefined, safeZ);
      blank();
    }

    // เส้นเปิด: ย้อนกลับจุดเริ่มโดยเดินตามแนวเส้นในทางกลับ (อยู่ในร่องเดิม ไม่ตัดทแยง)
    // ตอนเรียก มีดอยู่ที่ปลายเส้น (E) ที่ระดับ z
    function emitReverseRetrace(path, z, feedXY) {
      for (let i = path.length - 2; i >= 0; i--) feed(path[i].x, path[i].y, z, feedXY);
    }

    // เส้นปิด: เก็บลิ่มที่ ramp ทิ้งไว้ — ตอนเรียก มีดอยู่ที่จุดเริ่ม (S) ที่ระดับเต็ม (toZ) แล้ว
    // ตัดต่อจาก S ไปตามเส้นจนถึงจุดที่ ramp ถึงระดับเต็ม (R = ระยะตามเส้น = effRamp) ที่ระดับ toZ
    function emitRampCloseOff(path, fromZ, toZ, feedXY) {
      const rampDist = Math.abs(toZ - fromZ);
      if (rampDist < 1e-6 || path.length < 2) return;
      const total = pathLength(path);
      const effRamp = Math.min(rampDist, Math.max(total, 1e-6));
      let acc = 0;
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (acc + segLen >= effRamp - 1e-9) {
          const tt = (effRamp - acc) / (segLen || 1);
          feed(a.x + tt * (b.x - a.x), a.y + tt * (b.y - a.y), toZ, feedXY);
          return;
        }
        feed(b.x, b.y, toZ, feedXY);
        acc += segLen;
      }
    }

    // เส้นเปิด pass สุดท้าย: ramp S→R (ลง toZ ภายในระยะ effRamp) → ย้อน R→S ที่ toZ →
    // เดินหน้าเต็มเส้น S→E ที่ toZ — ตอนเรียก มีดอยู่ที่ S ที่ระดับ fromZ
    function emitOpenLastPass(path, fromZ, toZ, feedXY) {
      if (path.length < 2) return;
      const total = pathLength(path);
      const rampDist = Math.abs(toZ - fromZ);
      const effRamp = Math.min(Math.max(rampDist, 1e-6), Math.max(total, 1e-6));
      // 1) ramp S→R พร้อมเก็บจุดที่เดินผ่าน (รวม R) ไว้ย้อนกลับ
      const fwd = [];
      let acc = 0, reached = false;
      for (let i = 1; i < path.length && !reached; i++) {
        const a = path[i - 1], b = path[i];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        if (acc + segLen >= effRamp - 1e-9) {
          const tt = (effRamp - acc) / (segLen || 1);
          const rx = a.x + tt * (b.x - a.x), ry = a.y + tt * (b.y - a.y);
          feed(rx, ry, toZ, feedXY);
          fwd.push({ x: rx, y: ry });
          reached = true;
        } else {
          const z = fromZ + (toZ - fromZ) * ((acc + segLen) / effRamp);
          feed(b.x, b.y, z, feedXY);
          fwd.push({ x: b.x, y: b.y });
          acc += segLen;
        }
      }
      // 2) ย้อน R→S ที่ระดับ toZ (ผ่านจุดเดิมในทางกลับ แล้วจบที่ S)
      for (let i = fwd.length - 2; i >= 0; i--) feed(fwd[i].x, fwd[i].y, toZ, feedXY);
      feed(path[0].x, path[0].y, toZ, feedXY);
      // 3) เดินหน้าเต็มเส้น S→E ที่ระดับ toZ
      for (let i = 1; i < path.length; i++) feed(path[i].x, path[i].y, toZ, feedXY);
    }

    // เดินตามเส้นทางแบบ ramp 45° เหมือน rampedPath แต่ถ้าช่วงไหนตรงกับมุมโค้งจริง
    // (arcRanges) และอยู่นอกโซน ramp แล้ว (Z ถึงเป้าหมายแล้ว) จะออก G2/G3 รวดเดียว
    // แทนการเดินจุดทีละจุดของส่วนโค้งนั้น — ถ้ามุมโค้งดันอยู่คาบเกี่ยวกับโซน ramp
    // (พบยากเพราะ ramp สั้นกว่าระยะรอบรูปมาก) จะ fallback เป็นจุดแบบเดิมสำหรับมุมนั้น
    function emitRampedPathWithArcs(path, arcRanges, fromZ, toZ, feedXY) {
      const rampDist = Math.abs(toZ - fromZ);
      if (rampDist < 1e-6) {
        // ไม่มีการเปลี่ยนความลึกรอบนี้ (กรณีพิเศษ) — เดินที่ Z เดิมตลอด ใช้โค้งได้เต็มที่
        return emitFlatWithArcs(path, arcRanges, toZ, feedXY);
      }
      const total = pathLength(path);
      const effRamp = Math.min(rampDist, Math.max(total, 1e-6));
      let acc = 0, idx = 1;
      while (idx < path.length) {
        const ar = arcRanges && arcRanges.find(r => r.startIdx === idx - 1);
        if (ar && acc >= effRamp - 1e-6) {
          const startPt2 = path[ar.startIdx], endPt2 = path[ar.endIdx];
          const cmd = ar.ccw ? 'G3' : 'G2';
          emit(`${cmd} X${fmt(endPt2.x)} Y${fmt(endPt2.y)} Z${fmt(toZ)} I${fmt(ar.cx - startPt2.x)} J${fmt(ar.cy - startPt2.y)} F${fmt(feedXY)}`);
          stats.cutMM += 2 * Math.PI * ar.r; // ประมาณระยะ (สถิติเท่านั้น ไม่กระทบความถูกต้องของ G-code)
          cur = { x: endPt2.x, y: endPt2.y, z: toZ };
          idx = ar.endIdx + 1;
          continue;
        }
        const a = path[idx - 1], b = path[idx];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const accBefore = acc, accAfter = acc + segLen;
        if (accAfter <= effRamp) {
          // ทั้งช่วงนี้ยังอยู่ในโซน ramp
          const z = fromZ + (toZ - fromZ) * (accAfter / effRamp);
          feed(b.x, b.y, z, feedXY);
        } else if (accBefore >= effRamp) {
          // เลยโซน ramp ไปแล้ว อยู่ที่ความลึกเป้าหมายเต็มที่
          feed(b.x, b.y, toZ, feedXY);
        } else {
          // ช่วงนี้คาบเกี่ยว: ส่วนแรกยัง ramp ส่วนหลังถึงความลึกแล้ว -> แทรกจุดกึ่งกลางที่ความลึกพอดี
          const tt = (effRamp - accBefore) / segLen;
          const mx = a.x + tt * (b.x - a.x), my = a.y + tt * (b.y - a.y);
          feed(mx, my, toZ, feedXY);
          feed(b.x, b.y, toZ, feedXY);
        }
        acc = accAfter;
        idx++;
      }
    }

    // ใช้เมื่อไม่มีการเปลี่ยน Z เลย (rampDist=0) — เดินที่ความลึกเดิม ใช้ G2/G3 ได้ทุกมุมโค้ง
    function emitFlatWithArcs(path, arcRanges, z, feedXY) {
      let idx = 1;
      while (idx < path.length) {
        const ar = arcRanges && arcRanges.find(r => r.startIdx === idx - 1);
        if (ar) {
          const startPt2 = path[ar.startIdx], endPt2 = path[ar.endIdx];
          const cmd = ar.ccw ? 'G3' : 'G2';
          emit(`${cmd} X${fmt(endPt2.x)} Y${fmt(endPt2.y)} Z${fmt(z)} I${fmt(ar.cx - startPt2.x)} J${fmt(ar.cy - startPt2.y)} F${fmt(feedXY)}`);
          stats.cutMM += 2 * Math.PI * ar.r;
          cur = { x: endPt2.x, y: endPt2.y, z };
          idx = ar.endIdx + 1;
          continue;
        }
        feed(path[idx].x, path[idx].y, z, feedXY);
        idx++;
      }
    }

    /* =========================================================================
     * โหมด "ตีบัวหน้าบาน" — ใช้ G2/G3 สำหรับมุมโค้งเหมือน Profile ทั่วไป แต่ที่มุม
     * แหลมจริงของ pass สุดท้าย (op.spikeIndices) จะแทรกการแทง-ถอน: ขึ้นไปแตะมุมจริง
     * บนเส้น V-line ที่ผิวไม้ (op.surfacePath ที่ Z=op.surfaceZ) แล้วถอนกลับลงมาที่
     * ความลึกตัดเดิม ก่อนเดินทางต่อ — เก็บมุมที่ดอก V-bit ทรงกรวยกัดมุมแหลมไม่ถึง
     * ========================================================================= */
    function emitFlatWithArcsAndSpikes(path, arcRanges, z, feedXY, spikeSet, surfacePath, surfaceZ) {
      const n = path.length - 1;
      let idx = 1;
      while (idx < path.length) {
        const ar = arcRanges && arcRanges.find(r => r.startIdx === idx - 1);
        if (ar) {
          const startPt2 = path[ar.startIdx], endPt2 = path[ar.endIdx];
          const cmd = ar.ccw ? 'G3' : 'G2';
          emit(`${cmd} X${fmt(endPt2.x)} Y${fmt(endPt2.y)} Z${fmt(z)} I${fmt(ar.cx - startPt2.x)} J${fmt(ar.cy - startPt2.y)} F${fmt(feedXY)}`);
          stats.cutMM += 2 * Math.PI * ar.r;
          cur = { x: endPt2.x, y: endPt2.y, z };
          idx = ar.endIdx + 1;
          continue;
        }
        feed(path[idx].x, path[idx].y, z, feedXY);
        const logicalIdx = idx % n;
        if (spikeSet.has(logicalIdx)) {
          const sp = surfacePath[logicalIdx];
          feed(sp.x, sp.y, surfaceZ, feedXY);            // แทง: ขึ้นไปแตะมุมจริงที่ผิวไม้
          feed(path[idx].x, path[idx].y, z, feedXY);      // ถอน: กลับลงที่ความลึกตัดเดิม
        }
        idx++;
      }
    }

    function emitDoorProfile(op) {
      const t = op.tool;
      emit(`(ตีบัวหน้าบาน | ${op.layer})`);
      const startPt = op.path[0];
      const lastIdx = op.passes.length - 1;
      const spikeSet = op.spikeIndices ? new Set(op.spikeIndices) : null;
      rapid(undefined, undefined, safeZ);
      rapid(startPt.x, startPt.y, undefined);
      rapid(undefined, undefined, clearance);
      op.passes.forEach((zCut, idx) => {
        if (idx > 0) feed(startPt.x, startPt.y, undefined, t.feedXY); // กลับจุดเริ่มที่ความสูงเดิม (ไม่ยก)
        feed(undefined, undefined, zCut, t.feedZ); // ดิ่งลงตรงไปความลึกของ pass นี้
        const isLast = (idx === lastIdx);
        if (isLast && spikeSet && spikeSet.size) {
          emitFlatWithArcsAndSpikes(op.path, op.arcRanges, zCut, t.feedXY, spikeSet, op.surfacePath, op.surfaceZ);
        } else {
          emitFlatWithArcs(op.path, op.arcRanges, zCut, t.feedXY);
        }
      });
      rapid(undefined, undefined, safeZ);
      blank();
    }

    function emitPocket(op) {
      const t = op.tool;
      emit(`(Pocket | layer ${op.layer})`);

      if (op.circleRings && op.circleRings.length) {
        // Pocket วงกลม: ทุก pass ลงแบบ helix บนวงในสุดก่อน (ที่ตำแหน่งนั้นเปลี่ยนความลึก)
        // ส่วนวงอื่นในพาสเดียวกัน Z ไม่เปลี่ยน (helix แบบ fromZ=toZ = วงกลมแบนปกติ)
        const rings = op.circleRings; // index0=วงนอกสุด, ลำดับสุดท้าย=วงในสุด
        const clockwise = (machine.cutDirection === 'climb');
        const innermost = rings[rings.length - 1];
        rapid(undefined, undefined, safeZ);
        rapid(innermost.cx + innermost.r, innermost.cy, undefined);
        rapid(undefined, undefined, clearance);
        let fromZ = clearance;
        for (const zCut of op.passes) {
          for (let r = rings.length - 1; r >= 0; r--) {
            const ring = rings[r];
            const sx = ring.cx + ring.r, sy = ring.cy;
            feed(sx, sy, undefined, t.feedXY); // ย้ายไปจุดเริ่มวงนี้ที่ความสูงเดิม (ไม่ยกมีด)
            const z0 = (r === rings.length - 1) ? fromZ : zCut; // วงแรกของ pass นี้ลง ramp/helix, วงอื่นแบนอยู่แล้ว
            helixTurn(ring.cx, ring.cy, sx, sy, z0, zCut, clockwise, t.feedXY);
          }
          fromZ = zCut;
        }
        // เก็บรอย seam ของวงในสุด (วงเดียวที่ลงแบบ helix ในแต่ละ pass) ด้วยวงแบนที่ Z สุดท้าย
        if (op.passes.length) {
          const zLast = op.passes[op.passes.length - 1];
          const sx = innermost.cx + innermost.r, sy = innermost.cy;
          feed(sx, sy, undefined, t.feedXY);
          helixTurn(innermost.cx, innermost.cy, sx, sy, zLast, zLast, clockwise, t.feedXY);
        }
        rapid(undefined, undefined, safeZ);
        blank();
        return;
      }

      const startRing = op.rings[op.rings.length - 1];
      rapid(undefined, undefined, safeZ);
      rapid(startRing[0].x, startRing[0].y, undefined);
      rapid(undefined, undefined, clearance);
      let fromZ = clearance;
      for (const zCut of op.passes) {
        let ramped = false; // กันกรณีวงในสุดเสื่อมสภาพเป็นจุดเดียว (perimeter≈0) จาก makePocket
        for (let r = op.rings.length - 1; r >= 0; r--) {
          const ring = op.rings[r];
          feed(ring[0].x, ring[0].y, undefined, t.feedXY);
          if (!ramped && pathLength(ring) > 0.05) {
            const rp = rampedPath(ring, fromZ, zCut);
            for (let i = 1; i < rp.length; i++) feed(rp[i].x, rp[i].y, rp[i].z, t.feedXY);
            ramped = true;
          } else {
            feed(undefined, undefined, zCut, t.feedZ); // ตั้ง Z ให้ถูกเสมอแม้วงนี้ไม่ได้ ramp (กันหลุด Z เดิม)
            for (let i = 1; i < ring.length; i++) feed(ring[i].x, ring[i].y, undefined, t.feedXY);
          }
        }
        fromZ = zCut;
      }
      // เก็บลิ่มที่ ramp ของวงในสุด (วงเดียวที่ ramp ในแต่ละ pass) — เดินวงในสุดแบบแบนที่ Z สุดท้าย
      if (op.passes.length) {
        const zLast = op.passes[op.passes.length - 1];
        let innerRing = null;
        for (let r = op.rings.length - 1; r >= 0; r--) {
          if (pathLength(op.rings[r]) > 0.05) { innerRing = op.rings[r]; break; }
        }
        if (innerRing) {
          feed(innerRing[0].x, innerRing[0].y, undefined, t.feedXY);
          feed(undefined, undefined, zLast, t.feedZ);
          for (let i = 1; i < innerRing.length; i++) feed(innerRing[i].x, innerRing[i].y, zLast, t.feedXY);
        }
      }
      rapid(undefined, undefined, safeZ);
      blank();
    }

    function emitDrill(op) {
      const t = op.tool;
      emit(`(Drill | layer ${op.layer} @ X${fmt(op.point.x)} Y${fmt(op.point.y)})`);
      rapid(undefined, undefined, safeZ);
      rapid(op.point.x, op.point.y, undefined);
      rapid(undefined, undefined, clearance);
      // ถอยขึ้นก่อนเจาะ pass ถัดไป: ไม่ว่า z0Mode จะเป็น 'top' (ค่าความลึกติดลบ) หรือ
      // 'table' (ค่าเป็นบวกแต่ลดลงเมื่อลึกขึ้น) "ถอยขึ้น" คือ Z เพิ่มขึ้นเสมอทั้งสองโหมด
      // (ผิวไม้/clearance อยู่สูงกว่าจุดเจาะเสมอ) ไม่ต้องเช็คเครื่องหมายของ targetZ เลย
      for (let i = 0; i < op.passes.length; i++) {
        const zCut = op.passes[i];
        feed(undefined, undefined, zCut, t.feedZ);
        if (i < op.passes.length - 1) rapid(undefined, undefined, zCut + 1);
      }
      rapid(undefined, undefined, safeZ);
      blank();
    }
  }

  global.GCodeGenerator = { generate, fmt, fillTemplate, orderOperations, rampedPath, pathLength };

})(typeof window !== 'undefined' ? window : globalThis);
