/* =============================================================================
 * dxf-reader.js
 * -----------------------------------------------------------------------------
 * ตัวอ่านไฟล์ DXF (DXF Parser) เขียนเองล้วน ๆ ไม่พึ่ง library ภายนอก
 * เพื่อให้เปิด index.html แล้วใช้งานได้ทันทีโดยไม่ต้องต่อเน็ตหรือรัน server
 *
 * DXF เป็นไฟล์ข้อความที่จัดเก็บเป็นคู่ ๆ ของ (group code, value)
 * บรรทัดคี่ = group code (ตัวเลข)   บรรทัดคู่ = ค่า (value)
 * เราจะอ่านทีละคู่แล้วประกอบเป็น Entity
 *
 * Entity ที่รองรับ: LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC
 * ข้อมูลที่ดึงออกมา: ชื่อ Layer (code 8), geometry, พิกัด
 *
 * ผลลัพธ์ที่ได้คือ object รูปแบบกลาง (normalized) ที่โมดูลอื่นเอาไปใช้ต่อได้:
 *   { layers:{...}, entities:[ {type, layer, ...geometry} ], bounds:{...} }
 * โดยทุก entity จะถูกแปลงให้มี polyline (อาเรย์ของจุด {x,y}) เพื่อให้วาด/คำนวณง่าย
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------------
   * แปลงข้อความ DXF ดิบ ๆ ให้เป็นอาเรย์ของคู่ { code, value }
   * รองรับทั้งบรรทัดแบบ \r\n และ \n
   * ------------------------------------------------------------------------- */
  function tokenize(text) {
    // แยกบรรทัด, ตัด \r ออก (กรณีไฟล์มาจาก Windows)
    const lines = text.split(/\r\n|\r|\n/);
    const pairs = [];
    // เดินทีละ 2 บรรทัด: บรรทัดแรก = code, บรรทัดสอง = value
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      const value = lines[i + 1].trim();
      // ข้ามคู่ที่ code ไม่ใช่ตัวเลข (กันไฟล์ที่มีบรรทัดว่างแปลก ๆ)
      if (Number.isNaN(code)) {
        i -= 1; // ถอยกลับ 1 บรรทัดเพื่อ resync
        continue;
      }
      pairs.push({ code, value });
    }
    return pairs;
  }

  /* ---------------------------------------------------------------------------
   * คำนวณส่วนโค้ง (arc) จากจุดศูนย์กลาง รัศมี และมุมเริ่ม-สิ้นสุด
   * คืนค่าเป็นอาเรย์ของจุด {x,y} เพื่อใช้วาดและสร้าง toolpath
   * segments = จำนวนเส้นย่อยที่ใช้ประมาณส่วนโค้ง (ยิ่งมากยิ่งเนียน)
   * ------------------------------------------------------------------------- */
  function arcToPoints(cx, cy, r, startDeg, endDeg, segments) {
    const pts = [];
    let a0 = startDeg;
    let a1 = endDeg;
    // DXF: arc วาดทวนเข็มนาฬิกา (CCW) จาก start ไป end เสมอ
    // ถ้า end < start ให้บวก 360 เพื่อให้ได้ช่วงมุมที่ถูกต้อง
    if (a1 < a0) a1 += 360;
    const sweep = a1 - a0;
    // เลือกจำนวน segment ตามขนาดมุม (ทุก ๆ ~6 องศา 1 เส้น) อย่างน้อย 2
    const n = segments || Math.max(2, Math.ceil(Math.abs(sweep) / 6));
    for (let i = 0; i <= n; i++) {
      const ang = (a0 + (sweep * i) / n) * Math.PI / 180;
      pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
    }
    return pts;
  }

  /* ---------------------------------------------------------------------------
   * แปลงวงกลมเต็มวงให้เป็น polyline ปิด (สำหรับ preview และ pocket/profile)
   * สำหรับงาน Drill เราจะใช้จุดศูนย์กลางแยกต่างหาก
   * ------------------------------------------------------------------------- */
  function circleToPoints(cx, cy, r, segments) {
    const n = segments || Math.max(16, Math.ceil((2 * Math.PI * r) / 2));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const ang = (2 * Math.PI * i) / n;
      pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
    }
    return pts;
  }

  /* ---------------------------------------------------------------------------
   * แปลง "bulge" ของ LWPOLYLINE ให้เป็นส่วนโค้ง
   * bulge = tan(theta/4) โดย theta คือมุมที่ส่วนโค้งกาง
   * ใช้ระหว่างจุด p0 -> p1 เพื่อสร้างจุดกลางทางบนส่วนโค้ง
   * ------------------------------------------------------------------------- */
  function bulgeToPoints(p0, p1, bulge) {
    if (!bulge || Math.abs(bulge) < 1e-9) return { points: [p1], arc: null }; // เส้นตรง
    const theta = 4 * Math.atan(bulge);          // มุมรวมของส่วนโค้ง
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const chord = Math.hypot(dx, dy);            // ความยาวคอร์ด
    if (chord < 1e-9) return { points: [p1], arc: null };
    const r = chord / (2 * Math.sin(theta / 2)); // รัศมี
    // จุดกึ่งกลางคอร์ด
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    // ระยะจากกึ่งกลางคอร์ดไปยังจุดศูนย์กลางวงกลม
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
    // ทิศตั้งฉากกับคอร์ด (ปรับเครื่องหมายตามทิศของ bulge)
    const sign = bulge > 0 ? 1 : -1;
    const nx = -dy / chord, ny = dx / chord;
    const cx = mx + sign * h * nx * (Math.abs(theta) > Math.PI ? -1 : 1);
    const cy = my + sign * h * ny * (Math.abs(theta) > Math.PI ? -1 : 1);
    // มุมเริ่ม-สิ้นสุดเทียบจุดศูนย์กลาง
    const a0 = Math.atan2(p0.y - cy, p0.x - cx);
    let a1 = Math.atan2(p1.y - cy, p1.x - cx);
    // จำนวน segment ตามขนาดมุม
    const segs = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 18)));
    const out = [];
    for (let i = 1; i <= segs; i++) {
      let a = a0 + (theta) * (i / segs);
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    // arc metadata: ccw=true ถ้า bulge บวก (theta>0 หมายถึงมุมเพิ่มขึ้น = ทวนเข็ม)
    return { points: out, arc: { cx, cy, r: Math.abs(r), ccw: theta > 0, a0, a1: a0 + theta } };
  }

  /* ---------------------------------------------------------------------------
   * ฟังก์ชันหลัก: parse(text) -> โครงสร้างกลาง
   * ------------------------------------------------------------------------- */
  function parse(text) {
    const pairs = tokenize(text);
    const entities = [];
    const layers = {}; // เก็บชื่อ layer ทั้งหมดที่พบ

    let i = 0;
    // ---- หา section ENTITIES ----
    // ข้ามไปจนเจอ (0,"SECTION") ที่ตามด้วย (2,"ENTITIES")
    // หมายเหตุ: บาง DXF มี layer อยู่ใน TABLES ด้วย แต่เราเก็บ layer จาก entity ที่ใช้จริงก็พอ
    function findEntitiesStart() {
      for (let k = 0; k + 1 < pairs.length; k++) {
        if (pairs[k].code === 0 && pairs[k].value === 'SECTION' &&
            pairs[k + 1].code === 2 && pairs[k + 1].value === 'ENTITIES') {
          return k + 2;
        }
      }
      return -1;
    }

    let start = findEntitiesStart();
    // ถ้าไม่เจอ section ENTITIES ก็ลองอ่านทั้งไฟล์ (DXF บางตัวย่อมาก)
    if (start < 0) start = 0;
    i = start;

    // ---- วนอ่าน entity จนจบ section ----
    while (i < pairs.length) {
      const p = pairs[i];
      // จบ ENTITIES section
      if (p.code === 0 && (p.value === 'ENDSEC' || p.value === 'EOF')) break;

      if (p.code === 0) {
        const type = p.value;
        // อ่านคู่ทั้งหมดของ entity นี้จนเจอ code 0 ตัวถัดไป
        const data = {};            // เก็บค่าตาม group code (สำหรับ code เดี่ยว)
        const verts = [];           // เก็บจุดของ LWPOLYLINE
        const polyVerts = [];       // เก็บจุดของ POLYLINE (จาก VERTEX)
        i++;
        // อ่าน attribute ของ entity จนกว่าจะเจอ entity ถัดไป
        // กรณี POLYLINE จะมี VERTEX ย่อย ๆ ตามมา เราจัดการแยก
        if (type === 'POLYLINE') {
          // เก็บ layer ของ POLYLINE
          let layer = '0';
          let closed = false;
          while (i < pairs.length && pairs[i].code !== 0) {
            if (pairs[i].code === 8) layer = pairs[i].value;
            if (pairs[i].code === 70) closed = (parseInt(pairs[i].value, 10) & 1) === 1;
            i++;
          }
          // อ่าน VERTEX ย่อย
          while (i < pairs.length && pairs[i].code === 0 && pairs[i].value === 'VERTEX') {
            i++; // ข้าม (0,"VERTEX")
            let vx = 0, vy = 0;
            while (i < pairs.length && pairs[i].code !== 0) {
              if (pairs[i].code === 10) vx = parseFloat(pairs[i].value);
              if (pairs[i].code === 20) vy = parseFloat(pairs[i].value);
              i++;
            }
            polyVerts.push({ x: vx, y: vy });
          }
          // ข้าม (0,"SEQEND")
          if (i < pairs.length && pairs[i].code === 0 && pairs[i].value === 'SEQEND') {
            i++;
            while (i < pairs.length && pairs[i].code !== 0) i++;
          }
          if (polyVerts.length >= 2) {
            const pts = polyVerts.slice();
            if (closed) pts.push({ x: pts[0].x, y: pts[0].y });
            entities.push({ type: 'POLYLINE', layer, closed, points: pts });
            layers[layer] = true;
          }
          continue; // ไป entity ถัดไป
        }

        // ---- entity อื่น ๆ : อ่านคู่ทั้งหมดเข้าไปก่อน ----
        // สำหรับ LWPOLYLINE จุดจะมาเป็นชุด (10,20[,42]) ซ้ำ ๆ
        let lwX = null, lwBulge = 0;
        while (i < pairs.length && pairs[i].code !== 0) {
          const c = pairs[i].code;
          const v = pairs[i].value;
          if (type === 'LWPOLYLINE') {
            // LWPOLYLINE: 10 = x, 20 = y ของแต่ละจุด, 42 = bulge ของ segment, 90 = จำนวนจุด, 70 = flag
            if (c === 10) { lwX = parseFloat(v); lwBulge = 0; }
            else if (c === 20) { verts.push({ x: lwX, y: parseFloat(v), bulge: 0 }); }
            else if (c === 42) { if (verts.length) verts[verts.length - 1].bulge = parseFloat(v); }
            else if (c === 70) { data[70] = parseInt(v, 10); }
            else if (c === 8) { data[8] = v; }
          } else {
            // entity ทั่วไป: เก็บ code เดี่ยว ๆ (ถ้า code ซ้ำให้เก็บตัวแรก/อัปเดต)
            if (c === 10) data[10] = parseFloat(v);
            else if (c === 20) data[20] = parseFloat(v);
            else if (c === 11) data[11] = parseFloat(v);
            else if (c === 21) data[21] = parseFloat(v);
            else if (c === 40) data[40] = parseFloat(v);
            else if (c === 50) data[50] = parseFloat(v);
            else if (c === 51) data[51] = parseFloat(v);
            else if (c === 8) data[8] = v;
            else if (c === 70) data[70] = parseInt(v, 10);
          }
          i++;
        }

        const layer = (type === 'LWPOLYLINE') ? (data[8] || '0') : (data[8] || '0');

        // ---- แปลงแต่ละชนิด entity เป็นรูปแบบกลาง ----
        if (type === 'LINE') {
          entities.push({
            type: 'LINE', layer, closed: false,
            points: [{ x: data[10] || 0, y: data[20] || 0 },
                     { x: data[11] || 0, y: data[21] || 0 }]
          });
          layers[layer] = true;
        } else if (type === 'CIRCLE') {
          entities.push({
            type: 'CIRCLE', layer, closed: true,
            cx: data[10] || 0, cy: data[20] || 0, r: data[40] || 0,
            points: circleToPoints(data[10] || 0, data[20] || 0, data[40] || 0)
          });
          layers[layer] = true;
        } else if (type === 'ARC') {
          entities.push({
            type: 'ARC', layer, closed: false,
            cx: data[10] || 0, cy: data[20] || 0, r: data[40] || 0,
            startAngle: data[50] || 0, endAngle: data[51] || 0,
            points: arcToPoints(data[10] || 0, data[20] || 0, data[40] || 0,
                                data[50] || 0, data[51] || 0)
          });
          layers[layer] = true;
        } else if (type === 'LWPOLYLINE') {
          const closed = (data[70] & 1) === 1;
          // สร้างจุดต่อเนื่อง รวมการแปลง bulge เป็นส่วนโค้ง
          // segments: เก็บข้อมูลแต่ละช่วงว่าเป็นเส้นตรงหรือส่วนโค้ง (พร้อมจุดศูนย์กลาง/รัศมี)
          // ไว้ใช้ตอน offset แบบรักษาความเป็นส่วนโค้งจริง (ไม่ใช่แปลงเป็นจุดล้วน ๆ)
          const pts = [];
          const segments = [];
          if (verts.length) {
            pts.push({ x: verts[0].x, y: verts[0].y });
            for (let k = 0; k < verts.length - 1; k++) {
              const p0 = { x: verts[k].x, y: verts[k].y }, p1 = { x: verts[k + 1].x, y: verts[k + 1].y };
              const { points: seg, arc } = bulgeToPoints(verts[k], verts[k + 1], verts[k].bulge);
              segments.push(arc ? { type: 'arc', p0, p1, cx: arc.cx, cy: arc.cy, r: arc.r, ccw: arc.ccw } : { type: 'line', p0, p1 });
              for (const s of seg) pts.push(s);
            }
            // ถ้าปิด ให้เชื่อมจุดสุดท้ายกลับจุดแรก (รวม bulge ของ segment สุดท้าย)
            if (closed) {
              const p0 = { x: verts[verts.length - 1].x, y: verts[verts.length - 1].y }, p1 = { x: verts[0].x, y: verts[0].y };
              const { points: seg, arc } = bulgeToPoints(verts[verts.length - 1], verts[0], verts[verts.length - 1].bulge);
              segments.push(arc ? { type: 'arc', p0, p1, cx: arc.cx, cy: arc.cy, r: arc.r, ccw: arc.ccw } : { type: 'line', p0, p1 });
              for (const s of seg) pts.push(s);
            }
          }
          if (pts.length >= 2) {
            const hasArc = segments.some(s => s.type === 'arc');
            entities.push({ type: 'LWPOLYLINE', layer, closed, points: pts, segments: hasArc ? segments : null });
            layers[layer] = true;
          }
        }
        // entity ชนิดอื่น (TEXT, INSERT, ฯลฯ) ถูกข้ามไปโดยตั้งใจ
      } else {
        i++;
      }
    }

    // ---- คำนวณกรอบขอบเขต (bounding box) ของทั้งงาน ----
    const bounds = computeBounds(entities);

    return { entities, layers: Object.keys(layers), bounds };
  }

  /* ---------------------------------------------------------------------------
   * คำนวณกรอบ min/max ของทุก entity เพื่อใช้จัด view ให้พอดีจอ
   * ------------------------------------------------------------------------- */
  function computeBounds(entities) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of entities) {
      const pts = e.points || [];
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  /* ---------------------------------------------------------------------------
   * หาเส้นกรอบของแผ่นไม้เต็มแผ่นจาก layer "_ABF_SHEET_BORDER"
   * ถ้าไม่เจอ ให้คืน null (ผู้เรียกจะ fallback ไปใช้ bounding box ของงานทั้งหมดแทน
   * พร้อมแจ้งเตือนผู้ใช้)
   * ------------------------------------------------------------------------- */
  function findSheetBorder(parsed) {
    const ents = parsed.entities.filter(e => e.layer === '_ABF_SHEET_BORDER');
    if (!ents.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of ents) {
      for (const p of e.points) {
        if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
      }
    }
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, fromLayer: true };
  }

  // ส่งออก API ของโมดูลไปไว้ใน global namespace (ใช้ผ่าน <script> ธรรมดาได้ ไม่ต้อง server)
  global.DXFReader = { parse, arcToPoints, circleToPoints, computeBounds, findSheetBorder };

})(typeof window !== 'undefined' ? window : globalThis);
