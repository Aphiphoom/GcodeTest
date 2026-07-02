/* =============================================================================
 * toolpath-generator.js (v3)
 * -----------------------------------------------------------------------------
 * เปลี่ยนจากเดิม (v2):
 *  - ตัดระบบ phase/cutType ออกทั้งหมด (ใช้ระบบลำดับใหม่ตาม layer+order แทน
 *    ดูรายละเอียดที่ gcode-generator.js orderOperations())
 *  - เพิ่ม "order" ต่อ operation (มาจาก mapping ของ layer นั้น)
 *  - เพิ่มการตรวจจับวงกลม (circle-fit) + ใช้ชื่อ Layer (เช่น D10, D35) ช่วยยืนยัน/
 *    ปรับขนาดให้แม่นยำขึ้น แล้วติด circleMeta ไว้ใน operation เพื่อให้
 *    gcode-generator.js เลือกออก G2/G3 แทนการเดินจุดทีละจุด (เฉพาะ Profile
 *    Outside/Inside ที่ไม่มี tabs — ถ้ามี tabs ใช้จุดแบบเดิมเพราะการยกมีดกลางทาง
 *    บนส่วนโค้งซับซ้อนเกินไป)
 *  - เพิ่มการตรวจจับเส้นซ้อนกันหลายชั้นใน layer เดียวกัน (nesting) แล้วสลับทิศ
 *    offset ตามระดับความลึกของการซ้อน (เหมือนกฎ even-odd) สำหรับ Profile
 *    Outside/Inside
 *  - ข้าม layer ที่ EXCLUDED_LAYERS (_ABF_SHEET_BORDER/_ID/_MATERIAL) และ
 *    operation = 'None'
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ===== เรขาคณิตพื้นฐาน ===== */

  function signedArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function stripClosing(pts) {
    if (pts.length > 1) {
      const a = pts[0], b = pts[pts.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) return pts.slice(0, -1);
    }
    return pts.slice();
  }

  function lineIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }

  function offsetPolygon(ptsIn, dist, outward) {
    let pts = stripClosing(ptsIn);
    const n = pts.length;
    if (n < 3 || dist <= 1e-9) return pts.slice();
    if (signedArea(pts) < 0) pts = pts.slice().reverse();
    const sign = outward ? 1 : -1;
    const lines = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      let dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      dx /= len; dy /= len;
      const nx = dy * sign, ny = -dx * sign;
      lines.push({
        ax: a.x + nx * dist, ay: a.y + ny * dist,
        bx: b.x + nx * dist, by: b.y + ny * dist
      });
    }
    const out = [];
    const m = lines.length;
    for (let i = 0; i < m; i++) {
      const l0 = lines[(i - 1 + m) % m];
      const l1 = lines[i];
      const p = lineIntersect(l0.ax, l0.ay, l0.bx, l0.by, l1.ax, l1.ay, l1.bx, l1.by);
      out.push(p || { x: l1.ax, y: l1.ay });
    }
    out.push({ x: out[0].x, y: out[0].y });
    return out;
  }

  /* ---------------------------------------------------------------------------
   * Offset เส้นทางที่มีทั้งเส้นตรงและส่วนโค้ง (เช่น สี่เหลี่ยมที่ลบมุมเป็นโค้ง) โดย
   * รักษาความเป็นส่วนโค้งไว้จริง (ไม่แปลงเป็นจุดแบนแล้วค่อย offset แบบ polygon ปกติ)
   *   - เส้นตรง: เลื่อนตั้งฉากเหมือน offsetPolygon
   *   - ส่วนโค้ง: ปรับแค่รัศมี (จุดศูนย์กลางเดิม) ตามทิศ outward/inward
   *   - มุมต่อกัน: เส้นตรง-เส้นตรง ใช้ miter intersection เหมือน offsetPolygon เดิม
   *     ส่วนที่มีโค้งเกี่ยวข้อง ใช้จุดบนวงกลม/เส้นที่ offset แล้วตรง ๆ (เชื่อสัมผัสกัน
   *     พอดีถ้าต้นฉบับสัมผัสกันจริง — กรณีทั่วไปของมุมโค้งที่ต่อเนียนจากเส้นตรง)
   * คืน { path: [จุดสำหรับ preview/tabs], arcRanges: [{startIdx,endIdx,cx,cy,r,ccw}] }
   * ------------------------------------------------------------------------- */
  function offsetMixedPath(segmentsIn, dist, outward) {
    const verts = segmentsIn.map(s => s.p0);
    let segs = segmentsIn;
    if (signedArea(verts) < 0) {
      segs = segmentsIn.slice().reverse().map(s => s.type === 'line'
        ? { type: 'line', p0: s.p1, p1: s.p0 }
        : { type: 'arc', p0: s.p1, p1: s.p0, cx: s.cx, cy: s.cy, r: s.r, ccw: !s.ccw });
    }
    const sign = outward ? 1 : -1;
    const n = segs.length;

    const offsetSegs = segs.map(s => {
      if (s.type === 'line') {
        let dx = s.p1.x - s.p0.x, dy = s.p1.y - s.p0.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const nx = dy * sign, ny = -dx * sign;
        return {
          type: 'line',
          p0: { x: s.p0.x + nx * dist, y: s.p0.y + ny * dist },
          p1: { x: s.p1.x + nx * dist, y: s.p1.y + ny * dist }
        };
      }
      // ส่วนโค้งนูนออก (กรณีทั่วไปของ "มุมโค้งที่ถูกลบ"): offset ออกนอก = รัศมีเพิ่ม,
      // offset เข้าใน = รัศมีลด (เหมือนหลักการเดียวกับวงกลมเต็มวง)
      const newR = s.r + sign * dist;
      return { type: 'arc', cx: s.cx, cy: s.cy, r: newR, ccw: s.ccw, origP0: s.p0, origP1: s.p1 };
    });

    // หามุมต่อ (จุดเชื่อม) ระหว่าง segment ที่ offset แล้วแต่ละคู่
    const corners = [];
    for (let i = 0; i < n; i++) {
      const prev = offsetSegs[(i - 1 + n) % n];
      const cur = offsetSegs[i];
      if (prev.type === 'line' && cur.type === 'line') {
        const p = lineIntersect(prev.p0.x, prev.p0.y, prev.p1.x, prev.p1.y, cur.p0.x, cur.p0.y, cur.p1.x, cur.p1.y);
        corners.push(p || cur.p0);
      } else if (cur.type === 'arc') {
        const a0 = Math.atan2(cur.origP0.y - cur.cy, cur.origP0.x - cur.cx);
        corners.push({ x: cur.cx + cur.r * Math.cos(a0), y: cur.cy + cur.r * Math.sin(a0) });
      } else {
        const a1 = Math.atan2(prev.origP1.y - prev.cy, prev.origP1.x - prev.cx);
        corners.push({ x: prev.cx + prev.r * Math.cos(a1), y: prev.cy + prev.r * Math.sin(a1) });
      }
    }

    const path = [];
    const arcRanges = [];
    for (let i = 0; i < n; i++) {
      const cur = offsetSegs[i];
      const startCorner = corners[i];
      const endCorner = corners[(i + 1) % n];
      if (cur.type === 'line') {
        path.push(startCorner);
      } else {
        const startIdx = path.length;
        path.push(startCorner);
        const a0 = Math.atan2(startCorner.y - cur.cy, startCorner.x - cur.cx);
        const a1 = Math.atan2(endCorner.y - cur.cy, endCorner.x - cur.cx);
        let sweep = a1 - a0;
        if (cur.ccw && sweep < 0) sweep += 2 * Math.PI;
        if (!cur.ccw && sweep > 0) sweep -= 2 * Math.PI;
        const segCount = 8;
        for (let k = 1; k <= segCount; k++) {
          const a = a0 + sweep * (k / segCount);
          path.push({ x: cur.cx + cur.r * Math.cos(a), y: cur.cy + cur.r * Math.sin(a) });
        }
        arcRanges.push({ startIdx, endIdx: path.length - 1, cx: cur.cx, cy: cur.cy, r: cur.r, ccw: cur.ccw });
      }
    }
    path.push({ x: path[0].x, y: path[0].y });
    return { path, arcRanges };
  }

  function pathLength(pts) {
    let L = 0;
    for (let i = 0; i < pts.length - 1; i++)
      L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    return L;
  }

  /* ---------------------------------------------------------------------------
   * กลับทิศทาง path ให้ตรงกับ Climb (CW) / Conventional (CCW) ที่ตั้งไว้
   * (offsetPolygon และ circlePoints คืนผลลัพธ์เป็น CCW เสมอโดยธรรมชาติ)
   * ------------------------------------------------------------------------- */
  function applyCutDirection(path, cutDirection) {
    if (cutDirection === 'climb') return path.slice().reverse();
    return path;
  }

  function centroid(pts) {
    let sx = 0, sy = 0;
    for (const p of pts) { sx += p.x; sy += p.y; }
    return { x: sx / pts.length, y: sy / pts.length };
  }

  /* ---------------------------------------------------------------------------
   * point-in-polygon (ray casting) — ใช้ตรวจการซ้อนกันของเส้นปิดหลายเส้นในเลเยอร์เดียวกัน
   * ------------------------------------------------------------------------- */
  function pointInPolygon(pt, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if (((yi > pt.y) !== (yj > pt.y)) &&
          (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi + 1e-12) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /* ---------------------------------------------------------------------------
   * คำนวณ "ระดับการซ้อน" ของเส้นปิดแต่ละเส้นในเลเยอร์เดียวกัน (กี่เส้นที่ครอบมันอยู่)
   * ใช้จุด centroid ของแต่ละเส้นเป็นตัวแทน เช็คว่าอยู่ในเส้นอื่นกี่เส้น
   * ระดับ 0 = วงนอกสุด, 1 = ซ้อนชั้นแรก (รู), 2 = ซ้อนอีกชั้น (ชิ้นแทรก), ...
   *
   * สำคัญ: ต้องเช็คพื้นที่ประกอบด้วย ไม่ใช่แค่จุด centroid อยู่ในรูปหรือไม่ —
   * เพราะถ้าเส้นซ้อนกันแบบ "ศูนย์กลางตรงกันพอดี" (concentric) จุด centroid ของ
   * ทุกเส้นจะอยู่ที่จุดเดียวกัน ทำให้ point-in-polygon บอกไม่ได้ว่าวงไหนอยู่ใน
   * วงไหนจริง ๆ (centroid อาจ "อยู่ใน" ทั้งวงแม่และวงลูกพร้อมกัน) ต้องใช้พื้นที่
   * เป็นตัวตัดสินทิศทาง: "j ครอบ i" ได้ก็ต่อเมื่อ j มีพื้นที่ใหญ่กว่า i เท่านั้น
   * ------------------------------------------------------------------------- */
  function computeNestingDepths(closedPointArrays) {
    const n = closedPointArrays.length;
    const polys = closedPointArrays.map(p => stripClosing(p));
    const centroids = polys.map(centroid);
    const areas = polys.map(p => Math.abs(signedArea(p)));
    const depths = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (areas[j] > areas[i] && pointInPolygon(centroids[i], polys[j])) depths[i]++;
      }
    }
    return depths;
  }

  /* ---------------------------------------------------------------------------
   * ตรวจจับว่าเส้นปิดนี้ "เป็นวงกลม" หรือไม่ (fit หาจุดศูนย์กลาง+รัศมี)
   * เช็คทั้งจุดมุม (vertex) และจุดกึ่งกลางขอบ (mid-edge) เพื่อกันเข้าใจผิดว่า
   * รูปสี่เหลี่ยม/หลายเหลี่ยมน้อยเหลี่ยมเป็นวงกลม (จุดมุมของสี่เหลี่ยมก็ห่างจาก
   * ศูนย์กลางเท่ากันได้ แต่จุดกึ่งกลางขอบจะห่างจากศูนย์กลางน้อยกว่ามากแทน)
   * ------------------------------------------------------------------------- */
  function fitCircle(ptsIn) {
    const pts = stripClosing(ptsIn);
    const n = pts.length;
    if (n < 8) return null; // จุดน้อยเกินไป ไม่น่าใช่วงกลมที่ tessellate มา
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= n; cy /= n;
    const rs = pts.map(p => Math.hypot(p.x - cx, p.y - cy));
    const avgR = rs.reduce((a, b) => a + b, 0) / n;
    if (avgR < 1e-6) return null;
    let maxDevVertex = 0;
    for (const r of rs) maxDevVertex = Math.max(maxDevVertex, Math.abs(r - avgR) / avgR);
    let maxDevMid = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const rm = Math.hypot(mx - cx, my - cy);
      maxDevMid = Math.max(maxDevMid, Math.abs(rm - avgR) / avgR);
    }
    const TOL = 0.06; // ยอมรับความเพี้ยนได้ 6% (ครอบคลุมวงกลมที่ tessellate มาแค่ 10-12 เหลี่ยม
                      // แต่ยังกันรูปแปดเหลี่ยม/สี่เหลี่ยมจริงไม่ให้เข้าใจผิดว่าเป็นวงกลม)
    if (maxDevVertex < TOL && maxDevMid < TOL) {
      return { cx, cy, r: avgR, deviation: Math.max(maxDevVertex, maxDevMid) };
    }
    return null;
  }

  // ดึงค่าเส้นผ่านศูนย์กลางจากชื่อ Layer ถ้ามีรูปแบบ D ตามด้วยตัวเลข เช่น ABF_D10_Z12 -> 10
  function diameterFromLayerName(layerName) {
    const m = String(layerName).toUpperCase().match(/D(\d+(\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }

  function circlePoints(cx, cy, r, segments) {
    const n = segments || Math.max(36, Math.ceil((2 * Math.PI * Math.max(r, 0.1)) / 1.5));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = (2 * Math.PI * i) / n;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
  }

  /* ---------------------------------------------------------------------------
   * Multi-pass แบบทั่วไป: เดินจาก "ผิวบนไม้จริง" (startZ) ไปสู่ targetZ ทีละ step
   * ------------------------------------------------------------------------- */
  function buildPasses(startZ, targetZ, passStep) {
    const passes = [];
    const totalDist = targetZ - startZ;
    const step = Math.abs(passStep) || Math.abs(totalDist) || 1;
    const sign = totalDist < 0 ? -1 : 1;
    let z = startZ;
    while (Math.abs(z - startZ) + step < Math.abs(totalDist) - 1e-6) {
      z += sign * step;
      passes.push(z);
    }
    passes.push(targetZ);
    return passes;
  }

  function buildTabs(pts, count, width) {
    const tabs = [];
    const L = pathLength(pts);
    if (count <= 0 || L <= 0 || width <= 0) return tabs;
    for (let i = 0; i < count; i++) {
      const center = (L * i) / count + L / (2 * count);
      let s = center - width / 2;
      let e = center + width / 2;
      tabs.push({ start: Math.max(0, s), end: Math.min(L, e) });
    }
    return tabs;
  }

  /* ===== Pocket ===== */
  function makePocket(pts, toolDia, stepoverPct) {
    const stepover = Math.max(0.1, toolDia * (stepoverPct / 100));
    const rings = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    const maxDist = Math.min(maxX - minX, maxY - minY) / 2;
    let dist = toolDia / 2;
    let prevArea = Infinity;
    let guard = 0;
    while (guard++ < 500 && dist <= maxDist + stepover) {
      const ring = offsetPolygon(pts, dist, false);
      if (!ring || ring.length < 4) break;
      const area = Math.abs(signedArea(stripClosing(ring)));
      if (area > prevArea + 1e-6) break;
      rings.push(ring);
      if (area < (toolDia * toolDia)) break;
      prevArea = area;
      dist += stepover;
    }
    return rings;
  }

  /* ---------------------------------------------------------------------------
   * Pocket วงกลม (เมื่อตรวจพบว่ารูปร่างเป็นวงกลมจริง) — สร้างวงซ้อนกันหลายชั้นโดย
   * คำนวณรัศมีตรง ๆ (ไม่ต้อง offsetPolygon) ผลคือเรียบจริง ไม่ใช่ polygon approximation
   * คืนอาเรย์ [{cx,cy,r}, ...] ลำดับจากวงนอกสุด(ใกล้ขอบ)ไปวงในสุด(ใกล้ศูนย์กลาง)
   * ------------------------------------------------------------------------- */
  function makeCirclePocket(cx, cy, r, toolDia, stepoverPct) {
    const stepover = Math.max(0.1, toolDia * (stepoverPct / 100));
    const rings = [];
    let dist = toolDia / 2;
    let guard = 0;
    while (guard++ < 500 && dist <= r + stepover) {
      const ringR = r - dist;
      if (ringR < toolDia / 2 - 1e-6) { if (ringR > 0.05) rings.push({ cx, cy, r: ringR }); break; }
      rings.push({ cx, cy, r: ringR });
      dist += stepover;
    }
    return rings;
  }

  /* ---------------------------------------------------------------------------
   * คำนวณ path ของ Profile Outside/Inside หนึ่งเส้น โดยพิจารณาทั้ง:
   *   - effectiveOutward (สลับทิศตามระดับการซ้อน — XOR กับ base direction)
   *   - การตรวจจับวงกลม (ใช้ G2/G3 ได้ถ้าตรวจพบ + ไม่มี tabs)
   * คืน { path, circleMeta|null }
   * ------------------------------------------------------------------------- */
  // กลับทิศ arcRanges ให้ตรงกับการกลับทิศ path (ใช้ตอน cutDirection='climb' ที่ reverse path)
  function reverseArcRanges(arcRanges, pathLen) {
    return arcRanges.map(r => ({
      startIdx: pathLen - 1 - r.endIdx,
      endIdx: pathLen - 1 - r.startIdx,
      cx: r.cx, cy: r.cy, r: r.r, ccw: !r.ccw
    }));
  }

  // หมุน "จุดเริ่มต้น" ของเส้นปิดที่มีส่วนโค้ง ให้ไปเริ่มที่ต้นด้านตรงที่ยาวที่สุด
  // เหตุผล: ตอนออก G-code มีโซน ramp 45° ที่ช่วงต้นเส้น ถ้าจุดเริ่มดันตกที่มุมโค้ง
  // ส่วนโค้งจะอยู่ในโซน ramp แล้วถูก fallback เป็นจุด (G1) — หยัก. การย้ายจุดเริ่มไปอยู่
  // บนด้านตรงยาว ๆ ทำให้ ramp จบบนเส้นตรง และส่วนโค้งทั้งหมดอยู่นอกโซน ramp = ออก G2/G3 ได้
  // (เป็นแนวปฏิบัติมาตรฐานของ CAM อยู่แล้ว: ไม่ดิ่งมีดลงที่มุม/ส่วนโค้ง)
  function rotateStartToLongestStraight(path, arcRanges) {
    if (!path || path.length < 4 || !arcRanges || !arcRanges.length) return { path, arcRanges };
    const closedDup = Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y) < 1e-6;
    const core = closedDup ? path.slice(0, -1) : path.slice();
    const n = core.length;
    if (n < 4) return { path, arcRanges };
    // ทำเครื่องหมายจุดที่เป็น "จุดของส่วนโค้ง" (อยู่ในช่วง arc ใด ๆ)
    const isArcVtx = new Array(n).fill(false);
    arcRanges.forEach(a => { for (let i = a.startIdx; i <= a.endIdx; i++) if (i >= 0 && i < n) isArcVtx[i] = true; });
    // หาด้านตรงที่ยาวที่สุดที่ปลายทั้งสองข้าง "ไม่ใช่จุดของส่วนโค้ง"
    let bestK = -1, bestLen = -1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (isArcVtx[i] || isArcVtx[j]) continue;
      const L = Math.hypot(core[j].x - core[i].x, core[j].y - core[i].y);
      if (L > bestLen) { bestLen = L; bestK = i; }
    }
    if (bestK <= 0) return { path, arcRanges }; // เริ่มต้นที่ดีอยู่แล้ว หรือหาเส้นตรงสะอาดไม่เจอ
    const k = bestK;
    const newCore = core.slice(k).concat(core.slice(0, k));
    const newPath = newCore.concat([{ x: newCore[0].x, y: newCore[0].y }]);
    const remap = old => ((old - k) % n + n) % n;
    const newArcs = arcRanges.map(a => {
      const s = remap(a.startIdx), e = remap(a.endIdx);
      return { startIdx: Math.min(s, e), endIdx: Math.max(s, e), cx: a.cx, cy: a.cy, r: a.r, ccw: a.ccw };
    });
    return { path: newPath, arcRanges: newArcs };
  }

  function buildProfilePath(entPoints, toolRadius, effectiveOutward, cutDirection, layerName, warnings, willHaveTabs, entSegments) {
    if (!willHaveTabs) {
      const fit = fitCircle(entPoints);
      if (fit) {
        const nameD = diameterFromLayerName(layerName);
        let r = fit.r;
        if (nameD && Math.abs(nameD - 2 * fit.r) / nameD < 0.08) r = nameD / 2; // ชื่อ layer ยืนยันตรงกัน ใช้ค่าจากชื่อแม่นยำกว่า
        const newR = r + (effectiveOutward ? toolRadius : -toolRadius);
        if (newR > 0.05) {
          const pts = circlePoints(fit.cx, fit.cy, newR);
          return { path: applyCutDirection(pts, cutDirection), circleMeta: { cx: fit.cx, cy: fit.cy, r: newR } };
        }
        warnings.push(`วงกลมใน layer "${layerName}" เล็กเกินไปสำหรับมีดนี้ (offset เข้าในแล้วรัศมีติดลบ) — ใช้เส้นจุดแทน`);
      }
      // ไม่ใช่วงกลมเต็มวง แต่มีส่วนโค้งผสมอยู่ในเส้น (เช่น มุมที่ถูกลบเป็นโค้ง) — offset
      // แบบรักษาความเป็นโค้งไว้จริง แล้วใช้ G2/G3 เฉพาะช่วงนั้นตอนออก G-code
      if (entSegments && entSegments.length) {
        const mixed = offsetMixedPath(entSegments, toolRadius, effectiveOutward);
        if (mixed.arcRanges.every(r => r.r > 0.05)) {
          let path = mixed.path, arcRanges = mixed.arcRanges;
          if (cutDirection === 'climb') {
            arcRanges = reverseArcRanges(arcRanges, path.length);
            path = path.slice().reverse();
          }
          // ย้ายจุดเริ่มไปบนด้านตรงยาวสุด เพื่อให้ ramp ไม่ทับส่วนโค้ง (ออก G2/G3 ได้จริง)
          const rot = rotateStartToLongestStraight(path, arcRanges);
          return { path: rot.path, circleMeta: null, arcRanges: rot.arcRanges };
        }
        warnings.push(`มุมโค้งใน layer "${layerName}" เล็กเกินไปสำหรับมีดนี้ (offset แล้วรัศมีติดลบ) — ใช้เส้นจุดแทน`);
      }
    }
    const path = applyCutDirection(offsetPolygon(entPoints, toolRadius, effectiveOutward), cutDirection);
    return { path, circleMeta: null };
  }

  /* ---------------------------------------------------------------------------
   * จัดกลุ่มเส้นที่ซ้อนกัน (เช่น ชิ้นงานที่มีรูกลม/ช่องว่างข้างใน) ให้เป็น "ชิ้นเดียวกัน"
   * แล้วเรียงกลุ่มตามความยาวเส้นรอบรูปของ "วงนอกสุด" (root) จากเล็กไปใหญ่ — เส้นที่ซ้อน
   * อยู่ข้างในชิ้นเดียวกัน (รู/ชิ้นแทรก) จะอยู่ติดกับวงนอกสุดของชิ้นนั้นเสมอ ไม่ถูกแยก
   * ไปเรียงปนกับชิ้นงานอื่นตามขนาดของตัวเอง
   * ------------------------------------------------------------------------- */
  function groupAndSortBySize(ents) {
    const closedIdx = [];
    ents.forEach((e, i) => { if (e.closed && e.points.length >= 4) closedIdx.push(i); });
    if (closedIdx.length < 2) {
      return ents.slice().sort((a, b) => pathLength(a.points) - pathLength(b.points));
    }

    const n = closedIdx.length;
    const polys = closedIdx.map(i => stripClosing(ents[i].points));
    const areas = polys.map(p => Math.abs(signedArea(p)));
    const centroids = polys.map(centroid);

    // หา parent ตรง (วงที่เล็กที่สุดในบรรดาวงที่ใหญ่กว่าและครอบมันอยู่)
    const parent = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      let bestArea = Infinity, bestJ = -1;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (areas[j] > areas[i] && areas[j] < bestArea && pointInPolygon(centroids[i], polys[j])) {
          bestArea = areas[j]; bestJ = j;
        }
      }
      parent[i] = bestJ;
    }
    // ไล่ขึ้นไปหา root (วงนอกสุดของชิ้นนั้น) ของแต่ละวง + นับ "ระดับการซ้อน" (depth)
    // จากวงนอกสุด (depth 0) ลงไปข้างใน (1, 2, ...) — ใช้จัดลำดับการตัดภายในกลุ่ม
    const rootOf = new Array(n);
    const depthOf = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let cur = i, guard = 0, d = 0;
      while (parent[cur] !== -1 && guard++ < 30) { cur = parent[cur]; d++; }
      rootOf[i] = cur;
      depthOf[i] = d;
    }
    // ความยาวรอบรูปของแต่ละ root (ใช้จัดลำดับกลุ่ม)
    const rootPerimeter = {};
    for (let i = 0; i < n; i++) {
      const r = rootOf[i];
      if (rootPerimeter[r] === undefined) rootPerimeter[r] = pathLength(polys[r]);
    }
    const rootsSorted = Object.keys(rootPerimeter).map(Number).sort((a, b) => rootPerimeter[a] - rootPerimeter[b]);
    const rootRank = {}; rootsSorted.forEach((r, k) => { rootRank[r] = k; });
    // เรียงลำดับการตัด:
    //   1) ตามกลุ่ม (root) — ชิ้นเล็กก่อน
    //   2) ภายในกลุ่มเดียวกัน: วงในสุด (depth มากสุด) ตัดก่อน → ไล่ออกมาวงนอกสุด (root) ตัดท้ายสุด
    //      เพื่อให้วงนอกที่ยึดชิ้นงานไว้ ถูกตัดเป็นอันดับสุดท้าย (ชิ้นในยังไม่หลุดก่อนเสร็จ)
    //   3) depth เท่ากัน: ใช้ลำดับเดิมในไฟล์เป็นตัวตัดสิน
    const localOrder = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => (rootRank[rootOf[a]] - rootRank[rootOf[b]]) || (depthOf[b] - depthOf[a]) || (a - b));
    const sortedClosed = localOrder.map(li => ents[closedIdx[li]]);
    const openEnts = ents.filter(e => !(e.closed && e.points.length >= 4));
    return sortedClosed.concat(openEnts);
  }


  /* ===========================================================================
   * โหมด "ตีบัวหน้าบาน" (Door Profile) — แยกเป็นเอนจินคนละชุดจากระบบ Layer Mapping
   * ปกติ เพราะใช้ 2 มีดทำงานต่อเนื่องจากเส้นกรอบเส้นเดียว ไม่ใช่ 1 มีดต่อ 1 เลเยอร์
   * ========================================================================= */

  // แปลง entity ที่ไม่มี segments (ไม่มีมุมโค้งเลย) ให้เป็นรูปแบบเดียวกับ entity.segments
  // (อาเรย์ {type:'line',p0,p1} หรือ {type:'arc',p0,p1,cx,cy,r,ccw}) เพื่อส่งเข้า offsetMixedPath ได้
  function entityToSegments(ent) {
    if (ent.segments) return ent.segments;
    let pts = stripClosing(ent.points);
    // กันจุดซ้ำติดกัน (บางโปรแกรมส่งออกจุดปิดซ้ำสองชั้น) ก่อนสร้าง segment — ถ้าไม่กัน
    // จะเกิดเส้นความยาว 0 แทรกที่มุมนั้น ทำให้ทิศทาง offset เพี้ยนตรงมุมที่ซ้ำ
    const orig = pts;
    pts = pts.filter((p, i) => {
      const prev = orig[(i - 1 + orig.length) % orig.length];
      return Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-6;
    });
    const n = pts.length;
    const segs = [];
    for (let i = 0; i < n; i++) segs.push({ type: 'line', p0: pts[i], p1: pts[(i + 1) % n] });
    return segs;
  }

  // แปลงผลลัพธ์ {path, arcRanges} จาก offsetMixedPath กลับเป็นรูปแบบ segments เพื่อ
  // offset ต่อเนื่องเป็นชั้น ๆ ได้ (V-line -> toolpath V-bit -> toolpath FormTool)
  // จำนวน "เส้นทาง/ส่วนโค้งย่อย" (logical segment) จะเท่ากับรอบก่อนหน้าเสมอ ทำให้ดัชนี
  // ของมุมแต่ละจุดตรงกันทุกชั้น offset — ใช้จับคู่จุดมุมจริงกับจุด offset ตอนเก็บมุมคมได้
  function segmentsFromPathAndArcs(path, arcRanges) {
    const core = path.slice(0, -1);
    const n = core.length;
    const arcAtStart = {};
    arcRanges.forEach(a => { arcAtStart[a.startIdx] = a; });
    const segs = [];
    let i = 0;
    while (i < n) {
      const a = arcAtStart[i];
      if (a) {
        const p0 = core[a.startIdx], p1 = core[(a.endIdx + 1) % n];
        segs.push({ type: 'arc', p0, p1, cx: a.cx, cy: a.cy, r: a.r, ccw: a.ccw });
        i = a.endIdx + 1;
      } else {
        const p0 = core[i], p1 = core[(i + 1) % n];
        segs.push({ type: 'line', p0, p1 });
        i++;
      }
    }
    return segs;
  }

  // หาเส้นกรอบ "หน้าบาน" ในไฟล์ — ข้ามเส้นกรอบแผ่นไม้เต็มแผ่น (เส้นรอบรูปยาวที่สุด)
  // ที่เหลือทุกวงปิดถือเป็นหน้าบานแยกชิ้น (ไม่สนใจชื่อ Layer เลย ตามที่ตกลงกันไว้)
  function findDoorEntities(dxf) {
    const EXCLUDED = (global.MachineConfig && global.MachineConfig.EXCLUDED_LAYERS) || [];
    const closed = dxf.entities.filter(e => EXCLUDED.indexOf(e.layer) === -1 && e.closed && e.points && e.points.length >= 4);
    if (closed.length < 2) return closed;
    let maxLen = -1, maxIdx = -1;
    closed.forEach((e, i) => { const L = pathLength(stripClosing(e.points)); if (L > maxLen) { maxLen = L; maxIdx = i; } });
    return closed.filter((_, i) => i !== maxIdx);
  }

  /* ---------------------------------------------------------------------------
   * สร้าง toolpath โหมดตีบัวหน้าบาน ต่อ 1 ไฟล์ (อาจมีหลายหน้าบานในไฟล์เดียว)
   *   doorMode = { offset, depth, vbitTool, formtoolTool } (ดู defaultDoorMode)
   * คืน { operations, warnings, doors }
   *   doors = [{ vLine, vbitPath, formtoolPath }, ...] เส้นทั้ง 3 ของแต่ละหน้าบาน
   *   (Z=0/พิกัดผิวไม้) ไว้ใช้วาดพรีวิวแยกจาก toolpath จริง
   * ------------------------------------------------------------------------- */
  function generateDoorProfile(dxf, doorMode, tools, machine, toRealZ) {
    const operations = [];
    const warnings = [];
    const doors = [];

    const vbitTool = tools[doorMode.vbitTool];
    const formtoolTool = tools[doorMode.formtoolTool];
    if (!vbitTool) { warnings.push('โหมดตีบัวหน้าบาน: ยังไม่ได้เลือกมีด V-bit'); return { operations, warnings, doors }; }
    if (!formtoolTool) { warnings.push('โหมดตีบัวหน้าบาน: ยังไม่ได้เลือกมีด FormTool'); return { operations, warnings, doors }; }
    // มีดเดินตาม V-line และมีดตัดขอบออกจากแผ่น เป็นตัวเลือกเสริม (ไม่บังคับเลือก)
    const vlineTool = doorMode.vlineTool ? tools[doorMode.vlineTool] : null;
    const borderTool = doorMode.borderTool ? tools[doorMode.borderTool] : null;

    const doorEnts = findDoorEntities(dxf);
    if (!doorEnts.length) {
      warnings.push('โหมดตีบัวหน้าบาน: ไม่พบกรอบหน้าบานในไฟล์นี้ (เจอแต่กรอบแผ่นไม้ หรือไม่มีเส้นปิดเลย)');
      return { operations, warnings, doors };
    }

    const offsetEdge = Math.max(0, parseFloat(doorMode.offset) || 0);
    const depth = Math.max(0, parseFloat(doorMode.depth) || 0);
    const surfaceZ = toRealZ(0);
    const targetZ = toRealZ(depth);
    const startZ = (machine.z0Mode === 'table') ? (parseFloat(machine.woodThickness) || 0) : 0;

    const vbitAngleRad = ((parseFloat(vbitTool.vbitAngle) || 90) * Math.PI) / 180;
    const vbitTipD = parseFloat(vbitTool.vbitTipDiameter) || 0;
    // offset เพิ่มจากเส้น V-line เข้าไปเป็น toolpath จริงของ V-bit (ดูที่มาในแชท):
    // (รัศมีปลายดอก) + (ความลึก × tan(ครึ่งมุมดอก))
    const vbitExtra = (vbitTipD / 2) + depth * Math.tan(vbitAngleRad / 2);
    const formtoolExtra = (parseFloat(formtoolTool.diameter) || 0) / 2;

    // ตัวเลือกเสริม: ความลึกของรอยตาม V-line (ตัวเลขตรง ๆ ไม่มีนิพจน์) +
    // ระยะ offset ออกของมีดตัดขอบ (ครึ่งรัศมี ออกด้านนอกจากเส้นกรอบจริง เหมือน Profile Outside)
    // ความลึกของมีดตัดขอบ (doorMode.borderDepth) ผู้เรียกต้อง "คำนวณนิพจน์เป็นตัวเลขแล้ว"
    // ก่อนส่งเข้าฟังก์ชันนี้เสมอ (ดู resolveDoorModeForGenerate ใน app.js) — เอนจินนี้ไม่ยุ่ง
    // กับการตีความนิพจน์เอง เพื่อแยกหน้าที่ UI/เอนจินให้ชัด
    const vlineDepthZ = vlineTool ? toRealZ(Math.max(0, parseFloat(doorMode.vlineDepth) || 0)) : null;
    const borderDepthZ = borderTool ? toRealZ(Math.max(0, parseFloat(doorMode.borderDepth) || 0)) : null;
    const borderExtra = borderTool ? (parseFloat(borderTool.diameter) || 0) / 2 : 0;

    // เก็บ operation แยกเป็น 4 กลุ่มก่อน แล้วค่อยให้เลขลำดับทีหลัง เพื่อ "ล็อก" ลำดับมีด
    // ให้ใช้ V-bit ให้ครบทุกหน้าบานก่อน แล้วค่อย FormTool ครบทุกหน้าบาน แล้วค่อย V-line
    // แล้วค่อยตัดขอบออกจากแผ่นทีหลังสุดเสมอ (กันชิ้นงานหลุดก่อนทำงานอื่นเสร็จ) — ไม่ใช่
    // สลับมีดไปมาทีละหน้าบานแบบเดิม
    const vbitOps = [], formtoolOps = [], vlineOps = [], borderOps = [];

    doorEnts.forEach((ent, doorIdx) => {
      const baseSegs = entityToSegments(ent);
      if (baseSegs.length < 3) { warnings.push(`หน้าบาน #${doorIdx + 1}: จุดไม่พอสร้างรูปทรง ข้ามไป`); return; }
      const baseArea = Math.abs(signedArea(stripClosing(ent.points)));

      // ตรวจจับ "รูปทรงพลิกกลับด้านใน-นอก" (self-intersect) หลัง offset แต่ละชั้น — เกิดเมื่อ
      // ระยะ offset สะสมมากกว่าครึ่งความกว้าง/สูงของรูปทรงตรงนั้น ๆ จุดที่ได้จะยังมีครบ
      // (ไม่ใช่ < 4 จุด) แต่ตำแหน่งเพี้ยนไปคนละทาง — สัญญาณที่เชื่อถือได้คือพื้นที่รูปทรง
      // ใหม่ต้อง "เล็กลงกว่าเดิมจริง" และพื้นที่ต้องไม่กลับเครื่องหมาย (ไม่ติดลบ)
      function checkCollapse(path, label, prevArea) {
        const a = signedArea(stripClosing(path));
        if (a <= 1e-6 || a >= prevArea) {
          warnings.push(`หน้าบาน #${doorIdx + 1}: ระยะ offset รวมของ ${label} มากเกินไปจนรูปทรงพลิกกลับ (เกินครึ่งความกว้าง/สูงของหน้าบาน) ข้ามหน้าบานนี้ไป — ลองลดระยะ offset/ความลึก หรือใช้มีดที่มีมุม/ขนาดเล็กลง`);
          return false;
        }
        return true;
      }

      const vLine = offsetMixedPath(baseSegs, offsetEdge, false);
      if (vLine.path.length < 4 || !checkCollapse(vLine.path, 'V-line', baseArea)) { return; }
      const vLineArea = Math.abs(signedArea(stripClosing(vLine.path)));
      const vLineSegs = segmentsFromPathAndArcs(vLine.path, vLine.arcRanges);

      const vbit = offsetMixedPath(vLineSegs, vbitExtra, false);
      if (vbit.path.length < 4 || !checkCollapse(vbit.path, 'V-bit', vLineArea)) { return; }
      const vbitArea = Math.abs(signedArea(stripClosing(vbit.path)));
      const vbitSegs = segmentsFromPathAndArcs(vbit.path, vbit.arcRanges);

      const formtool = offsetMixedPath(vbitSegs, formtoolExtra, false);
      if (formtool.path.length < 4 || !checkCollapse(formtool.path, 'FormTool', vbitArea)) { return; }

      // หามุมแหลมจริงของเส้น toolpath V-bit (จุดที่ไม่ได้อยู่ในส่วนโค้งใด ๆ และไม่ใช่จุดที่
      // ส่วนโค้งจบแล้วต่อเข้าเส้นตรงทันที — จุดนั้นสัมผัสเนียนกับอาร์ค ไม่ใช่มุมแหลม)
      const n = vbit.path.length - 1;
      const excluded = new Array(n).fill(false);
      vbit.arcRanges.forEach(a => {
        for (let i = a.startIdx; i <= a.endIdx; i++) excluded[i] = true;
        excluded[(a.endIdx + 1) % n] = true;
      });
      const spikeIndices = [];
      for (let i = 0; i < n; i++) if (!excluded[i]) spikeIndices.push(i);

      const vbitPasses = buildPasses(startZ, targetZ, vbitTool.passDepth);
      const formtoolPasses = buildPasses(startZ, targetZ, formtoolTool.passDepth);

      vbitOps.push({
        kind: 'doorprofile', layer: `(หน้าบาน #${doorIdx + 1}) V-bit`,
        toolNumber: doorMode.vbitTool, tool: vbitTool,
        path: vbit.path, arcRanges: vbit.arcRanges, passes: vbitPasses,
        spikeIndices, surfacePath: vLine.path, surfaceZ
      });
      formtoolOps.push({
        kind: 'doorprofile', layer: `(หน้าบาน #${doorIdx + 1}) FormTool`,
        toolNumber: doorMode.formtoolTool, tool: formtoolTool,
        path: formtool.path, arcRanges: formtool.arcRanges, passes: formtoolPasses,
        spikeIndices: null, surfacePath: null, surfaceZ
      });

      // เดินตาม V-line พอดีกึ่งกลางเส้น (ไม่ offset เพิ่ม) — เพิ่มมิติให้งานด้วยรอยตื้น ๆ
      if (vlineTool) {
        const vlinePasses = buildPasses(startZ, vlineDepthZ, vlineTool.passDepth);
        vlineOps.push({
          kind: 'doorprofile', layer: `(หน้าบาน #${doorIdx + 1}) V-line`,
          toolNumber: doorMode.vlineTool, tool: vlineTool,
          path: vLine.path, arcRanges: vLine.arcRanges, passes: vlinePasses,
          spikeIndices: null, surfacePath: null, surfaceZ
        });
      }

      // ตัดขอบออกจากแผ่นจริง — offset ออกด้านนอกจากเส้นกรอบเดิม (ไม่ใช่ V-line) ครึ่งรัศมี
      // มีด เหมือน Profile Outside ปกติ ทำทีหลังสุดเสมอกันชิ้นงานหลุดก่อนงานอื่นเสร็จ
      if (borderTool) {
        const border = offsetMixedPath(baseSegs, borderExtra, true);
        if (border.path.length >= 4) {
          const borderPasses = buildPasses(startZ, borderDepthZ, borderTool.passDepth);
          borderOps.push({
            kind: 'doorprofile', layer: `(หน้าบาน #${doorIdx + 1}) ตัดขอบ`,
            toolNumber: doorMode.borderTool, tool: borderTool,
            path: border.path, arcRanges: border.arcRanges, passes: borderPasses,
            spikeIndices: null, surfacePath: null, surfaceZ
          });
        } else {
          warnings.push(`หน้าบาน #${doorIdx + 1}: คำนวณเส้นตัดขอบไม่สำเร็จ ข้ามไป`);
        }
      }

      doors.push({ vLine: vLine.path, vbitPath: vbit.path, formtoolPath: formtool.path });
    });

    // ให้เลขลำดับทีหลัง เป็น 4 ชุดติดกัน — ล็อกลำดับมีด: V-bit ครบก่อน > FormTool ครบ >
    // V-line ครบ > ตัดขอบครบ (ทีหลังสุดเสมอ)
    let orderSeq = 1;
    [vbitOps, formtoolOps, vlineOps, borderOps].forEach(group => {
      group.forEach(op => { op.order = orderSeq++; operations.push(op); });
    });

    return { operations, warnings, doors };
  }

  function generate(dxf, mappings, tools, machine, toRealZ) {
    const operations = [];
    const warnings = [];

    const EXCLUDED = (global.MachineConfig && global.MachineConfig.EXCLUDED_LAYERS) || ['_ABF_SHEET_BORDER'];

    const byLayer = {};
    for (const e of dxf.entities) {
      if (EXCLUDED.indexOf(e.layer) !== -1) continue;
      (byLayer[e.layer] = byLayer[e.layer] || []).push(e);
    }

    const startZ = (machine.z0Mode === 'table') ? (parseFloat(machine.woodThickness) || 0) : 0;

    for (const layerName of Object.keys(byLayer)) {
      const map = mappings[layerName];
      if (!map || map.enabled === false || map.operation === 'None') continue;
      const tool = tools[map.toolNumber];
      if (!tool) { warnings.push(`Layer "${layerName}" ไม่ได้กำหนด Tool ที่ใช้ได้`); continue; }

      let ents = byLayer[layerName];
      // เลเยอร์ที่ล็อกท้ายสุด (เช่น _ABF_CUTTING_LINES) เรียงตัดชิ้นเล็กก่อนเสมอ
      // วัดขนาดจาก "ความยาวเส้นรอบรูปเดิมในไฟล์ DXF" (ก่อน offset) — สำคัญ: ต้องจัดกลุ่ม
      // เส้นที่ซ้อนกัน (เช่น ชิ้นงานที่มีรูกลมข้างใน) ให้เป็น "ชิ้นเดียวกัน" ก่อน แล้วเรียง
      // ตามขนาดของวงนอกสุดของแต่ละชิ้น ไม่ใช่เรียงทุกเส้นแยกกันเอง (ไม่งั้นรูจะถูกแยกไป
      // เรียงปนกับชิ้นอื่นตามขนาดของรูเอง ทำให้รูหลุดจากชิ้นงานเดิม)
      const lockedLayerName = (global.MachineConfig && global.MachineConfig.LOCKED_LAST_LAYER) || '_ABF_CUTTING_LINES';
      if (layerName === lockedLayerName && ents.length > 1) {
        ents = groupAndSortBySize(ents);
      }
      const op = map.operation;
      const targetZ = toRealZ(parseFloat(map.depth) || 0);
      const passes = buildPasses(startZ, targetZ, tool.passDepth);
      const orderInfo = { order: (map.order === null || map.order === undefined || map.order === '') ? null : Number(map.order), toolNumber: map.toolNumber };

      let depths = null;
      const isProfileOffsetOp = (op === 'Profile Outside' || op === 'Profile Inside');
      if (isProfileOffsetOp) {
        const closedPts = ents.map(e => (e.closed && e.points.length >= 4) ? e.points : null);
        const validIdx = closedPts.map((p, i) => p ? i : -1).filter(i => i !== -1);
        if (validIdx.length > 1) {
          const arrs = validIdx.map(i => closedPts[i]);
          const d = computeNestingDepths(arrs);
          depths = {};
          validIdx.forEach((entIdx, k) => { depths[entIdx] = d[k]; });
        }
      }
      const baseOutward = (op === 'Profile Outside');

      ents.forEach((ent, entIdx) => {
        if (op === 'Drill') {
          const c = (ent.type === 'CIRCLE') ? { x: ent.cx, y: ent.cy } : centroid(ent.points);
          operations.push({ kind: 'drill', layer: layerName, toolNumber: map.toolNumber, point: c, targetZ, passes, tool, ...orderInfo });
          return;
        }

        const closed = ent.closed && ent.points.length >= 4;
        let path, circleMeta = null, arcRanges = null;
        let pocketRings = null, pocketCircleRings = null;

        if (op === 'Pocket') {
          if (!closed) { warnings.push(`Pocket ต้องเป็นรูปปิด (layer "${layerName}")`); return; }
          const fit = fitCircle(ent.points);
          if (fit) {
            const nameD = diameterFromLayerName(layerName);
            let r = fit.r;
            if (nameD && Math.abs(nameD - 2 * fit.r) / nameD < 0.08) r = nameD / 2;
            pocketCircleRings = makeCirclePocket(fit.cx, fit.cy, r, tool.diameter, machine.pocketStepover || 40);
            if (pocketCircleRings.length) pocketRings = pocketCircleRings.map(cr => circlePoints(cr.cx, cr.cy, cr.r));
          }
          if (!pocketRings) pocketRings = makePocket(ent.points, tool.diameter, machine.pocketStepover || 40);
          if (!pocketRings.length) { warnings.push(`Pocket เล็กเกินไปสำหรับมีด Ø${tool.diameter} (layer "${layerName}")`); return; }
        } else if (isProfileOffsetOp) {
          if (!closed) {
            warnings.push(`${op} ต้องเป็นรูปปิด — ใช้ On Line แทน (layer "${layerName}")`);
            path = ent.points.slice();
          } else {
            const depth = (depths && depths[entIdx] !== undefined) ? depths[entIdx] : 0;
            const effectiveOutward = (depth % 2 === 1) ? !baseOutward : baseOutward;
            const willHaveTabs = !!(map.tabsEnabled && closed);
            const built = buildProfilePath(ent.points, tool.diameter / 2, effectiveOutward, machine.cutDirection, layerName, warnings, willHaveTabs, ent.segments);
            path = built.path; circleMeta = built.circleMeta; arcRanges = built.arcRanges || null;
          }
        } else {
          path = ent.points.slice();
        }

        let tabs = [];
        const tabsOn = map.tabsEnabled && closed && isProfileOffsetOp;
        if (tabsOn && path) tabs = buildTabs(path, machine.tabCount || 4, machine.tabWidth || 6);
        const tabTop = targetZ < 0 ? targetZ + Math.abs(machine.tabHeight || 0) : targetZ - Math.abs(machine.tabHeight || 0);

        if (pocketRings) {
          operations.push({ kind: 'pocket', layer: layerName, toolNumber: map.toolNumber, rings: pocketRings, circleRings: pocketCircleRings, targetZ, passes, tool, ...orderInfo });
        } else {
          operations.push({
            kind: 'contour', layer: layerName, toolNumber: map.toolNumber,
            path, closed, targetZ, passes, tool, circleMeta, arcRanges,
            tabs, tabTopZ: tabTop, cutType: op, ...orderInfo
          });
        }
      });
    }

    return { operations, warnings };
  }

  global.ToolpathGenerator = {
    generate, offsetPolygon, offsetMixedPath, buildPasses, buildTabs, makePocket,
    signedArea, pathLength, fitCircle, diameterFromLayerName,
    computeNestingDepths, pointInPolygon,
    generateDoorProfile, findDoorEntities, entityToSegments, segmentsFromPathAndArcs
  };

})(typeof window !== 'undefined' ? window : globalThis);
