/* =============================================================================
 * simulate-3d.js (v2 — GPU heightmap)
 * -----------------------------------------------------------------------------
 * พรีวิวผลการตัด 3 มิติ — เวอร์ชัน GPU-based heightmap
 *   - ความสูงของผิวไม้เก็บเป็น "texture" บน GPU (ไม่ใช่ Float32Array บน CPU แบบเดิม)
 *     จึงทำความละเอียดสูงมากได้ (ดีฟอลต์ 1024 จุด/ด้านยาว) โดยไม่หน่วง
 *   - การ "กัด" แต่ละจุดบน toolpath = วาด full-screen pass (ping-pong ระหว่าง
 *     RenderTarget สองตัว) คำนวณความสูงใหม่ตามรูปทรงเครื่องมือจริง (flat/V-bit/
 *     ball-nose) แล้ว min() กับค่าเดิม — ทำเป็นชุด (batch) ต่อ pass เพื่อลดจำนวน
 *     draw call
 *   - mesh ของแผ่นไม้ใช้ความละเอียดปานกลางคงที่ (silhouette เท่านั้น) แล้วให้
 *     vertex shader ไปอ่านความสูงจริงจาก texture มา displace ตำแหน่งจุด — ทำให้
 *     เห็นรายละเอียด/ความเอียงของดอกกัดคมชัดแม้ mesh จะไม่ละเอียดมาก
 *
 * ข้อจำกัดที่ทราบอยู่แล้ว (ตามที่ตกลงไว้ก่อนเริ่มเขียน):
 *   - ต้องการ WebGL2 (เบราว์เซอร์ใหม่ ๆ รองรับเกือบทั้งหมด) — ถ้าไม่รองรับจะแจ้ง
 *     เตือนในแถบควบคุมแทนการ throw error เงียบ ๆ
 *   - toolType ที่มีในระบบตอนนี้คือ endmill/vbit/formtool เท่านั้น (ไม่มี ballnose
 *     ในข้อมูลจริง) shader รองรับโค้ด ballnose ไว้เผื่ออนาคต แต่ยังไม่มีทางเลือกนี้
 *     ในหน้า Tool Library ปัจจุบัน — formtool ยังคงเป็น flat (ค่าประมาณเดิม)
 *   - seekTo() แบบย้อนกลับ (ไปจุดที่ตื้นกว่าจุดปัจจุบัน) ต้อง clear + กัดใหม่ทั้งหมด
 *     ตั้งแต่ต้น อาจหน่วงเล็กน้อยถ้าไฟล์มี action จำนวนมาก (ทำงานครั้งเดียวตอน seek
 *     ไม่ใช่ทุกเฟรม)
 * ========================================================================== */

(function (global) {
  'use strict';

  const TEX_LONG_SIDE = 1280;  // ความละเอียด height texture (ด้านที่ยาวกว่า)
  const TEX_MIN_SIDE = 64;
  // ความละเอียด mesh จริง — สำคัญกว่า TEX_LONG_SIDE ในการ "เห็นร่องคมชัด" เพราะ
  // ตำแหน่งจุดจริงในอวกาศ 3D ถูกจำกัดความละเอียดที่นี่ (texture ละเอียดแค่ไหนก็ตาม
  // แต่ถ้า mesh ห่างกว่าร่องที่กัด ร่องนั้นจะถูกปาดเฉลี่ยจนดูเบลออยู่ดี)
  const MESH_LONG_SIDE = 560;
  const MESH_MIN_SIDE = 24;
  const BATCH = 32;            // จำนวน stamp ต่อ ping-pong pass

  let renderer, scene, camera, group, mesh, toolMesh;
  let containerEl, controlsEl;
  let webgl2ok = true;

  // ----- Solid geometry: แผ่นไม้จริง (ExtrudeGeometry) + รูที่ทะลุ (drill/profile ไม่มี tab) -----
  let slabMesh = null;
  let tableMesh = null;     // พื้นโต๊ะตัด (ระนาบใต้แผ่นไม้) — ให้เห็น "ทะลุถึงพื้น" เวลาตัดขาด แทนรูดำโบ๋
  let revealedHoles = [];   // [[{x,y}...], ...] รายการ polygon ของรูที่ "เผยออกมาแล้ว" ตาม progress
  let slabDirty = false;
  let boardOutline = null;  // [{x,y}x4] กรอบสี่เหลี่ยมของแผ่นไม้เต็ม (จาก bounds)
  let sharedWoodTex = null; // texture ไม้ใช้ร่วมกันทั้ง slab และผิว heightmap (สร้างครั้งเดียวต่อ loadJob)
  // hole mask: canvas 2D วาด polygon รูที่เผยแล้วเป็นสีดำ ใช้ discard ผิว heightmap ทับรูไม่ให้
  // บังรูที่ slab เจาะไว้จริง (ไม่งั้นผิว heightmap แบบ full-plane จะคลุมรูจนมองไม่เห็นความทะลุ)
  let holeMaskCanvas = null, holeMaskCtx = null, holeMaskTex = null;

  // ----- GPU height texture (ping-pong) -----
  let rtA, rtB;              // RenderTarget ปัจจุบัน / scratch
  let stampScene, stampCam, stampMesh, stampMat;
  let clearScene, clearCam, clearMesh, clearMat;
  let texW, texH;

  let boundsW, boundsH, originX, originY, baseThickness;
  let actions = [];
  let actionIdx = 0;
  let playing = false;
  let speed = 3;
  let lastTs = 0;
  let onProgress = null;
  let userSeeking = false;
  let currentToolNumber = null;
  let ro = null;
  let busy = false;        // มี rebuild (seekTo/loadJob) กำลังทำงานอยู่หรือไม่
  let generation = 0;      // เพิ่มทุกครั้งที่เริ่ม rebuild ใหม่ — ใช้ยกเลิกงานเก่าที่ยังค้างอยู่
  const CHUNK_BATCHES = 6; // จำนวน ping-pong batch ต่อเฟรมระหว่าง rebuild (กัน main thread ค้าง)

  const orbit = { theta: Math.PI * 0.25, phi: Math.PI * 0.32, radius: 400, target: new THREE.Vector3(0, 0, 0) };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* =========================================================================
   * Scene setup
   * ====================================================================== */
  function init(container) {
    if (renderer && containerEl === container) return;
    containerEl = container;
    container.innerHTML = '';

    renderer = new THREE.WebGLRenderer({ antialias: true });
    webgl2ok = !!(renderer.capabilities && renderer.capabilities.isWebGL2);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x11161d);
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 8000);

    group = new THREE.Group();
    scene.add(group);

    // ไฟจริงใน scene (ใช้กับ slab ที่เป็น MeshStandardMaterial — ผิว heightmap ใช้ shader
    // คำนวณแสงเองแยกต่างหากอยู่แล้ว ไม่ได้พึ่งไฟพวกนี้)
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dl1 = new THREE.DirectionalLight(0xffffff, 0.9); dl1.position.set(180, 320, 220); scene.add(dl1);
    const dl2 = new THREE.DirectionalLight(0xffffff, 0.25); dl2.position.set(-200, 150, -150); scene.add(dl2);

    initHoleMask();

    buildControlsBar(container);
    if (!webgl2ok) {
      showMessage('เบราว์เซอร์/GPU นี้ไม่รองรับ WebGL2 — โหมดพรีวิว 3 มิติความละเอียดสูงใช้งานไม่ได้ในเครื่องนี้');
      return;
    }

    attachManualOrbit(container);
    initStampPipeline();

    ro = new (window.ResizeObserver || function () { this.observe = function () {}; })(() => onResize());
    ro.observe(container);
    window.addEventListener('resize', onResize);

    requestAnimationFrame(loop);
    onResize();
  }

  function showMessage(text) {
    if (!controlsEl) return;
    const m = document.createElement('div');
    m.className = 'sim3d-msg';
    m.textContent = text;
    controlsEl.parentElement.insertBefore(m, controlsEl);
  }

  function onResize() {
    if (!containerEl || !renderer) return;
    const w = containerEl.clientWidth, h = containerEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /* ----- กล้องลาก-หมุน/ลูกกลิ้ง-ซูม/แพน (เหมือนเวอร์ชันก่อน) ----- */
  function updateCamera() {
    const p = orbit;
    camera.position.set(
      p.target.x + p.radius * Math.sin(p.phi) * Math.sin(p.theta),
      p.target.y + p.radius * Math.cos(p.phi),
      p.target.z + p.radius * Math.sin(p.phi) * Math.cos(p.theta)
    );
    camera.lookAt(p.target);
  }
  function attachManualOrbit(container) {
    let dragging = false, panning = false, last = { x: 0, y: 0 };
    container.addEventListener('mousedown', (e) => {
      if (e.target.closest && e.target.closest('.sim3d-bar')) return;
      dragging = e.button === 0 && !e.shiftKey;
      panning = e.button === 2 || (e.button === 0 && e.shiftKey);
      last = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', () => { dragging = false; panning = false; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging && !panning) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      if (dragging) {
        orbit.theta -= dx * 0.006;
        orbit.phi = clamp(orbit.phi - dy * 0.006, 0.08, Math.PI * 0.49);
        updateCamera();
      } else if (panning) {
        const s = orbit.radius * 0.0015;
        const right = new THREE.Vector3(Math.cos(orbit.theta), 0, -Math.sin(orbit.theta));
        orbit.target.addScaledVector(right, -dx * s);
        orbit.target.y += dy * s;
        updateCamera();
      }
    });
    container.addEventListener('contextmenu', (e) => e.preventDefault());
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      orbit.radius = clamp(orbit.radius * (1 + Math.sign(e.deltaY) * 0.08), 20, 6000);
      updateCamera();
    }, { passive: false });
  }

  function loop(ts) {
    requestAnimationFrame(loop);
    if (!webgl2ok) return;
    if (playing) stepPlayback(ts);
    if (renderer) renderer.render(scene, camera);
  }

  /* =========================================================================
   * แถบควบคุม (เหมือนเวอร์ชันก่อน)
   * ====================================================================== */
  function buildControlsBar(container) {
    controlsEl = document.createElement('div');
    controlsEl.className = 'sim3d-bar';
    controlsEl.innerHTML =
      '<button class="mini" id="sim3dPlay" title="เล่น/หยุด">▶</button>' +
      '<input type="range" id="sim3dSeek" class="sim3d-seek" min="0" max="1000" value="1000">' +
      '<span class="sim3d-label" id="sim3dStatus">ความเร็ว</span>' +
      '<input type="range" id="sim3dSpeed" class="sim3d-speed" min="1" max="12" value="3">' +
      '<button class="mini" id="sim3dReset" title="เริ่มใหม่จากแผ่นไม้เปล่า">⟲</button>';
    container.appendChild(controlsEl);

    const $btnPlay = controlsEl.querySelector('#sim3dPlay');
    const $seek = controlsEl.querySelector('#sim3dSeek');
    const $speed = controlsEl.querySelector('#sim3dSpeed');
    const $reset = controlsEl.querySelector('#sim3dReset');
    const $status = controlsEl.querySelector('#sim3dStatus');

    $btnPlay.addEventListener('click', () => { if (playing) pause(); else play(); });
    $speed.addEventListener('input', () => setSpeed(parseFloat($speed.value)));
    $reset.addEventListener('click', () => { pause(); seekTo(0); });
    $seek.addEventListener('mousedown', () => { userSeeking = true; });
    window.addEventListener('mouseup', () => { userSeeking = false; });
    $seek.addEventListener('input', () => { pause(); seekTo(parseFloat($seek.value) / 1000); });

    setProgressCallback((idx, total) => {
      $btnPlay.textContent = playing ? '⏸' : '▶';
      $btnPlay.disabled = busy;
      $status.textContent = busy ? 'กำลังประมวลผล…' : 'ความเร็ว';
      if (!userSeeking) $seek.value = total ? Math.round((idx / total) * 1000) : 0;
    });
  }

  /* =========================================================================
   * Hole mask: canvas 2D วาด polygon ของรูที่ "ทะลุแล้ว" เป็นสีดำ — ใช้ใน fragment
   * shader ของผิว heightmap เพื่อ discard บริเวณนั้น (กันผิว heightmap แบบ full-plane
   * บังรูที่ slab (ExtrudeGeometry) เจาะไว้จริงจนมองไม่เห็นว่าทะลุ)
   * ====================================================================== */
  function initHoleMask() {
    holeMaskCanvas = document.createElement('canvas');
    holeMaskCanvas.width = 512; holeMaskCanvas.height = 512;
    holeMaskCtx = holeMaskCanvas.getContext('2d');
    holeMaskTex = new THREE.CanvasTexture(holeMaskCanvas);
  }

  function redrawHoleMask() {
    const ctx = holeMaskCtx, SZ = holeMaskCanvas.width;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, SZ, SZ); // ขาว = ผิวไม้ปกติ (ไม่ discard)
    ctx.fillStyle = '#000000'; // ดำ = อยู่ในรู (ให้ fragment shader ของ heightmap discard)
    revealedHoles.forEach((poly) => {
      if (!poly || poly.length < 3) return;
      ctx.beginPath();
      poly.forEach((p, i) => {
        const u = (p.x - originX) / boundsW, v = (p.y - originY) / boundsH;
        const px = u * SZ, py = v * SZ;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
    });
    holeMaskTex.needsUpdate = true;
  }

  /* =========================================================================
   * Slab: แผ่นไม้จริงแบบมีความหนา (ExtrudeGeometry) + รูทะลุจริงตาม revealedHoles
   *   - ขอบนอกของแผ่น = กรอบสี่เหลี่ยมจาก bounds จริง → มีผนังด้านข้างรอบนอกจริง
   *   - รูเจาะ/ร่องตัดที่ "ทะลุและไม่มี tab" (ดู classifyAsHole) = hole ใน ExtrudeGeometry
   *     ได้ผนังด้านในของรูที่เรียบเนียนจาก Three.js เองทั้งหมด ไม่ขึ้นกับความละเอียด mesh
   *     ของบอร์ด (แก้ปัญหาหนามแหลม + ไม่มีความหนา + ไม่ดูขาดออกจากกัน ในจุดเดียว)
   * ====================================================================== */
  function shapePoint(p) {
    return new THREE.Vector2(p.x - centerOffsetX(), p.y - centerOffsetY());
  }

  function buildTableSurface() {
    if (tableMesh) { group.remove(tableMesh); tableMesh.geometry.dispose(); tableMesh.material.dispose(); }
    const geo = new THREE.PlaneGeometry(boundsW * 1.05, boundsH * 1.05);
    geo.rotateX(-Math.PI / 2); // ระนาบนอนในแกน XZ
    const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
    tableMesh = new THREE.Mesh(geo, mat);
    tableMesh.position.y = -0.5; // ต่ำกว่าพื้นโต๊ะเล็กน้อย กัน Z-fight กับหน้าล่างของ slab
    group.add(tableMesh);
  }

  function rebuildSlab() {
    if (slabMesh) { group.remove(slabMesh); slabMesh.geometry.dispose(); slabMesh.material.dispose(); }
    const shape = new THREE.Shape(boardOutline.map(shapePoint));
    revealedHoles.forEach((poly) => {
      if (!poly || poly.length < 3) return;
      shape.holes.push(new THREE.Path(poly.map(shapePoint)));
    });
    let geo;
    try {
      // ปิด bevel (เดิมเปิดไว้เพื่อความสวย) เพราะขัดกับการตัดหน้าบนทิ้งแบบ shader ด้านล่าง —
      // bevel ทำให้ขอบบนสุดเอียงเป็นทางลาด ถ้าตัดทิ้งตามเกณฑ์ความสูงจะเหลือรอยบุ๋มแหว่งที่ขอบ
      geo = new THREE.ExtrudeGeometry(shape, { depth: baseThickness, bevelEnabled: false, curveSegments: 12 });
    } catch (e) {
      // เผื่อ polygon บางอันมีปัญหา self-intersect ที่ earcut คำนวณไม่ได้ — ตัด hole ที่มีปัญหา
      // ออกแล้วลองใหม่ (กันพรีวิวพังทั้งฉาก) — ลองทีละตัวจากท้ายสุด (เพิ่งเผยล่าสุด มักเป็นตัวที่มีปัญหา)
      const safeHoles = shape.holes.slice();
      while (safeHoles.length && !geo) {
        safeHoles.pop();
        const tryShape = new THREE.Shape(boardOutline.map(shapePoint));
        tryShape.holes = safeHoles;
        try { geo = new THREE.ExtrudeGeometry(tryShape, { depth: baseThickness, bevelEnabled: false, curveSegments: 12 }); } catch (e2) { /* ลองตัวต่อไป */ }
      }
      if (!geo) geo = new THREE.ExtrudeGeometry(new THREE.Shape(boardOutline.map(shapePoint)), { depth: baseThickness, bevelEnabled: false });
    }
    geo.rotateX(-Math.PI / 2); // หมุนให้ความหนา (extrude) อยู่ในแกน Y (ขึ้น) ตาม convention ของฉากนี้
    geo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uWoodTex: { value: sharedWoodTex },
        uBaseThickness: { value: baseThickness },
        uKeyDir: { value: new THREE.Vector3(0.45, 1.0, 0.55) },
        uFillDir: { value: new THREE.Vector3(-0.5, 0.4, -0.3) }
      },
      vertexShader:
        'varying vec3 vWorldPos;\n' +
        'varying vec3 vN;\n' +
        'void main(){\n' +
        // geometry ผ่าน rotateX ไปแล้วตอนสร้าง (bake ค่าจริงลงใน position attribute เลย)
        // และ mesh นี้ไม่มี translate/rotate ของตัวเองอีก -> position ที่นี่ = world position ตรง ๆ
        '  vWorldPos = position;\n' +
        '  vN = normalMatrix * normal;\n' +
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n' +
        '}',
      fragmentShader:
        'precision highp float;\n' +
        'varying vec3 vWorldPos;\n' +
        'varying vec3 vN;\n' +
        'uniform sampler2D uWoodTex;\n' +
        'uniform float uBaseThickness;\n' +
        'uniform vec3 uKeyDir;\n' +
        'uniform vec3 uFillDir;\n' +
        'void main(){\n' +
        // ตัดหน้าบนสุด (top cap) ทิ้งทั้งหมด — ให้ผิว heightmap เป็นผู้แสดงผลหน้าบนแต่เพียง
        // ผู้เดียวเสมอทั้งบอร์ด (กัน 2 ผิวซ้อนกันที่ความสูงเดียวกัน = Z-fighting/ลายมั่ว)
        // slab เหลือแสดงแค่ผนังรอบนอก + ผนังในรูจริง + หน้าล่าง ซึ่งคือสิ่งที่ต้องการอยู่แล้ว\n' +
        '  if (vWorldPos.y > uBaseThickness - 0.05) discard;\n' +
        '  vec3 n = normalize(vN);\n' +
        '  float diff = max(dot(n, normalize(uKeyDir)), 0.0) * 0.85 + max(dot(n, normalize(uFillDir)), 0.0) * 0.3 + 0.22;\n' +
        // คำนวณ UV เองจากพิกัดโลกจริง (ไม่พึ่ง UV อัตโนมัติของ ExtrudeGeometry ที่อิงหน่วย mm
        // เป็นพัน ๆ ทำให้ลายไม้ซ้ำถี่จนมั่ว) — สเกลให้ลายไม้กว้างประมาณ 280mm/ลาย\n' +
        '  vec2 uv = vWorldPos.xz * 0.0035;\n' +
        '  vec3 base = texture2D(uWoodTex, uv).rgb;\n' +
        '  vec3 color = base * diff;\n' +
        '  gl_FragColor = vec4(color, 1.0);\n' +
        '}',
      side: THREE.DoubleSide
    });
    slabMesh = new THREE.Mesh(geo, mat);
    group.add(slabMesh);
    redrawHoleMask();
    slabDirty = false;
  }

  let lastSlabRebuildTs = 0;
  const SLAB_REBUILD_INTERVAL = 300; // ms — ห่างขั้นต่ำระหว่าง rebuild แต่ละครั้ง (กันค้าง)
  function rebuildSlabIfDirty(force) {
    if (!slabDirty) return;
    const now = Date.now();
    if (!force && now - lastSlabRebuildTs < SLAB_REBUILD_INTERVAL) return; // ยังไม่ครบเวลา รอรอบหน้า
    rebuildSlab();
    lastSlabRebuildTs = now;
  }

  /* =========================================================================
   * GPU stamp pipeline: render target ping-pong + shader สอง pass
   *   1) clearMat  — เคลียร์ texture เป็นค่าคงที่ (ใช้ตอน seek ย้อนกลับ/เริ่มใหม่)
   *   2) stampMat  — รับ stamp สูงสุด BATCH ตำแหน่งต่อ pass แล้ว min() เข้ากับเดิม
   * ====================================================================== */
  function initStampPipeline() {
    stampScene = new THREE.Scene();
    stampCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    stampMat = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uBoundsMin: { value: new THREE.Vector2(0, 0) },
        uBoundsSize: { value: new THREE.Vector2(1, 1) },
        uCount: { value: 0 },
        uPos: { value: new Array(BATCH).fill(0).map(() => new THREE.Vector2(0, 0)) },
        uRadius: { value: new Float32Array(BATCH) },
        uHeight: { value: new Float32Array(BATCH) },
        uType: { value: new Float32Array(BATCH) },
        uParam: { value: new Float32Array(BATCH) }
      },
      vertexShader:
        'varying vec2 vUv;\n' +
        'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader:
        'precision highp float;\n' +
        'uniform sampler2D uPrev;\n' +
        'uniform vec2 uBoundsMin;\n' +
        'uniform vec2 uBoundsSize;\n' +
        'uniform int uCount;\n' +
        'uniform vec2 uPos[' + BATCH + '];\n' +
        'uniform float uRadius[' + BATCH + '];\n' +
        'uniform float uHeight[' + BATCH + '];\n' +
        'uniform float uType[' + BATCH + '];\n' +
        'uniform float uParam[' + BATCH + '];\n' +
        'varying vec2 vUv;\n' +
        'void main(){\n' +
        '  float h = texture2D(uPrev, vUv).r;\n' +
        '  vec2 world = uBoundsMin + vUv * uBoundsSize;\n' +
        '  for (int i = 0; i < ' + BATCH + '; i++) {\n' +
        '    if (i >= uCount) break;\n' +
        '    float d = distance(world, uPos[i]);\n' +
        '    if (d <= uRadius[i]) {\n' +
        '      float cand;\n' +
        '      if (uType[i] < 0.5) { cand = uHeight[i]; }\n' +
        '      else if (uType[i] < 1.5) { cand = uHeight[i] + d * uParam[i]; }\n' +
        '      else { float R = uParam[i]; float dd = min(d, R); cand = uHeight[i] + R - sqrt(max(R*R - dd*dd, 0.0)); }\n' +
        '      h = min(h, cand);\n' +
        '    }\n' +
        '  }\n' +
        '  gl_FragColor = vec4(h, 0.0, 0.0, 1.0);\n' +
        '}'
    });
    stampMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), stampMat);
    stampScene.add(stampMesh);

    clearScene = new THREE.Scene();
    clearCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    clearMat = new THREE.ShaderMaterial({
      uniforms: { uValue: { value: 18 } },
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'precision highp float;\nuniform float uValue;\nvoid main(){ gl_FragColor = vec4(uValue,0.0,0.0,1.0); }'
    });
    clearMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), clearMat);
    clearScene.add(clearMesh);
  }

  function makeRenderTarget(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false
    });
  }

  // เขียนค่าคงที่ลง rtA ทั้ง texture (ใช้ตอนเริ่มงานใหม่/seek ย้อนกลับ)
  function clearHeight(value) {
    clearMat.uniforms.uValue.value = value;
    renderer.setRenderTarget(rtA);
    renderer.render(clearScene, clearCam);
    renderer.setRenderTarget(null);
  }

  // รัน 1 ping-pong pass: อ่านจาก rtA เขียนไป rtB ตาม batch ที่ส่งมา แล้วสลับ A/B
  function runStampBatch(batchActions) {
    const n = Math.min(batchActions.length, BATCH);
    stampMat.uniforms.uPrev.value = rtA.texture;
    stampMat.uniforms.uBoundsMin.value.set(originX, originY);
    stampMat.uniforms.uBoundsSize.value.set(boundsW, boundsH);
    stampMat.uniforms.uCount.value = n;
    const pos = stampMat.uniforms.uPos.value, rad = stampMat.uniforms.uRadius.value,
          hei = stampMat.uniforms.uHeight.value, typ = stampMat.uniforms.uType.value,
          par = stampMat.uniforms.uParam.value;
    for (let i = 0; i < n; i++) {
      const a = batchActions[i];
      pos[i].set(a.x, a.y);
      rad[i] = a.r; hei[i] = a.h; typ[i] = a.profileType; par[i] = a.profileParam;
    }
    renderer.setRenderTarget(rtB);
    renderer.render(stampScene, stampCam);
    renderer.setRenderTarget(null);
    const tmp = rtA; rtA = rtB; rtB = tmp; // สลับ ping-pong
  }

  /* =========================================================================
   * โหลด job ใหม่ทั้งหมด
   * ====================================================================== */
  function loadJob(tab, machine) {
    if (!renderer || !webgl2ok) return;
    const b = tab.dxf.bounds;
    boundsW = Math.max(b.width, 1);
    boundsH = Math.max(b.height, 1);
    originX = b.minX; originY = b.minY;
    baseThickness = parseFloat(machine.woodThickness) || 18;

    // texture ไม้สร้างครั้งเดียวต่อ loadJob ใช้ร่วมกันทั้ง slab (solid) และผิว heightmap
    // (เดิมแต่ละ mesh สร้าง texture แยกกันเอง สิ้นเปลือง + ลายไม้ไม่ตรงกันระหว่าง 2 ผิว)
    if (sharedWoodTex) sharedWoodTex.dispose();
    sharedWoodTex = woodTexture();

    boardOutline = [
      { x: originX, y: originY },
      { x: originX + boundsW, y: originY },
      { x: originX + boundsW, y: originY + boundsH },
      { x: originX, y: originY + boundsH }
    ];
    revealedHoles = [];
    slabDirty = true;

    sizeTo(boundsW, boundsH, TEX_LONG_SIDE, TEX_MIN_SIDE, (w, h) => { texW = w; texH = h; });
    if (rtA) rtA.dispose(); if (rtB) rtB.dispose();
    rtA = makeRenderTarget(texW, texH);
    rtB = makeRenderTarget(texW, texH);

    let meshW, meshH;
    sizeTo(boundsW, boundsH, MESH_LONG_SIDE, MESH_MIN_SIDE, (w, h) => { meshW = w; meshH = h; });
    buildGeometry(meshW, meshH);
    buildTableSurface();
    rebuildSlab(); // สร้าง slab เริ่มต้น (ยังไม่มีรู) ก่อน seekTo(1) จะค่อยเผยรูตามลำดับจริง

    buildActions(tab.lastJob ? tab.lastJob.operations : [], machine);
    actionIdx = 0;
    currentToolNumber = null;
    pause();
    clearHeight(baseThickness);
    frameCamera();
    // seekTo(1) เป็น async-chunked เอง (ดู comment ที่ตัวฟังก์ชัน) — ไม่บล็อก main thread
    // แม้ไฟล์จะมี action จำนวนมาก, และจะยกเลิกงาน rebuild ค้างจากแท็บ/ไฟล์ก่อนหน้าอัตโนมัติ
    // ผ่าน generation token (เผื่อมีการสลับแท็บ/เปิดไฟล์ใหม่รัว ๆ ระหว่างที่ยังโหลดไม่เสร็จ)
    seekTo(1);
  }

  function sizeTo(w, h, longSide, minSide, cb) {
    let gw, gh;
    if (w >= h) { gw = longSide; gh = Math.max(minSide, Math.round(longSide * h / w)); }
    else { gh = longSide; gw = Math.max(minSide, Math.round(longSide * w / h)); }
    cb(gw, gh);
  }

  function centerOffsetX() { return originX + boundsW / 2; }
  function centerOffsetY() { return originY + boundsH / 2; }

  /* ----- mesh ของแผ่นไม้: สร้างครั้งเดียว ไม่ต้องอัปเดตตำแหน่งจุดอีกเลย
   *       (vertex shader อ่านความสูงจริงจาก height texture ทุกเฟรมเอง) ----- */
  function buildGeometry(gw, gh) {
    if (mesh) { group.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    const verts = new Float32Array(gw * gh * 3);
    const uvs = new Float32Array(gw * gh * 2);
    for (let j = 0; j < gh; j++) {
      for (let i = 0; i < gw; i++) {
        const idx = j * gw + i;
        const u = i / (gw - 1), v = j / (gh - 1);
        verts[idx * 3] = (originX + u * boundsW) - centerOffsetX();
        verts[idx * 3 + 1] = 0; // ถูก override ด้วย vertex shader ทั้งหมด
        // กลับเครื่องหมาย Z ตรงนี้ (เทียบกับเวอร์ชันก่อน) — เพื่อให้ "Y จริงเพิ่มขึ้น"
        // ปรากฏเป็น "ขึ้นบนจอ" ตรงกับทิศทางของ preview 2D เดิม (เข้ากับกล้อง theta=0
        // ที่ปรับไว้ใน frameCamera ด้านล่าง — ถ้าไม่กลับเครื่องหมาย Y จะกลับหัวกับ 2D)
        verts[idx * 3 + 2] = -((originY + v * boundsH) - centerOffsetY());
        uvs[idx * 2] = u; uvs[idx * 2 + 1] = v;
      }
    }
    // ใช้ Uint32Array preallocated เขียนตรงตำแหน่ง แทน plain array + push()
    // (push() ทีละค่าเข้า array ปกติ ~940,000 ครั้ง ช้ากว่านี้มากสำหรับ mesh ความละเอียดสูง
    // ทั้งจากการ realloc ของ array และจาก three.js ต้องแปลงเป็น typed array เองอีกที)
    const nQuads = (gw - 1) * (gh - 1);
    const indices = new Uint32Array(nQuads * 6);
    let p = 0;
    for (let j = 0; j < gh - 1; j++) {
      for (let i = 0; i < gw - 1; i++) {
        const a = j * gw + i, b = j * gw + i + 1, c = (j + 1) * gw + i, d = (j + 1) * gw + i + 1;
        indices[p++] = a; indices[p++] = c; indices[p++] = b;
        indices[p++] = b; indices[p++] = c; indices[p++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uHeightTex: { value: null },
        uWoodTex: { value: sharedWoodTex },
        uHoleMask: { value: holeMaskTex },
        uTexel: { value: new THREE.Vector2(1 / texW, 1 / texH) },
        uCellWorldX: { value: boundsW / texW },
        uCellWorldY: { value: boundsH / texH },
        uBaseThickness: { value: baseThickness },
        // ไฟ 3 จุด: key (หลัก) / fill (เติมเงา ทิศตรงข้ามอ่อน ๆ) / rim (ขอบเรือง ด้านหลัง)
        uKeyDir: { value: new THREE.Vector3(0.45, 1.0, 0.55) },
        uFillDir: { value: new THREE.Vector3(-0.5, 0.4, -0.3) },
        uRimDir: { value: new THREE.Vector3(0.0, 0.25, -1.0) }
      },
      vertexShader:
        'varying vec2 vUv;\n' +
        'varying vec3 vWorldPos;\n' +
        'uniform sampler2D uHeightTex;\n' +
        'uniform vec2 uTexel;\n' +
        'void main(){\n' +
        '  vUv = uv;\n' +
        // sample แบบ box-filter 3x3 รอบจุด แทนการสุ่ม texel เดียวตรง ๆ — ลดปัญหา "หนามแหลม"
        // ที่เกิดจาก vertex หนึ่งบังเอิญตกตรง texel ลึกผิดปกติ ขณะ vertex ข้างเคียง (ซึ่งอยู่ห่าง
        // กันกว่า 1 texel เพราะ mesh หยาบกว่า texture) ไม่ได้ตกตรงจุดนั้น ทำให้ผิวกระโดดเป็นหนาม\n' +
        '  float h = 0.0;\n' +
        '  for (int dx = -1; dx <= 1; dx++) {\n' +
        '    for (int dy = -1; dy <= 1; dy++) {\n' +
        '      h += texture2D(uHeightTex, uv + vec2(float(dx), float(dy)) * uTexel).r;\n' +
        '    }\n' +
        '  }\n' +
        '  h /= 9.0;\n' +
        '  vec3 pos = position;\n' +
        '  pos.y = h;\n' +
        '  vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;\n' +
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);\n' +
        '}',
      fragmentShader:
        'precision highp float;\n' +
        'varying vec2 vUv;\n' +
        'varying vec3 vWorldPos;\n' +
        'uniform sampler2D uHeightTex;\n' +
        'uniform sampler2D uWoodTex;\n' +
        'uniform sampler2D uHoleMask;\n' +
        'uniform vec2 uTexel;\n' +
        'uniform float uCellWorldX;\n' +
        'uniform float uCellWorldY;\n' +
        'uniform float uBaseThickness;\n' +
        'uniform vec3 uKeyDir;\n' +
        'uniform vec3 uFillDir;\n' +
        'uniform vec3 uRimDir;\n' +
        'void main(){\n' +
        // ถ้าจุดนี้อยู่ในรูที่ "เผยออกมาแล้ว" (slab เจาะรูจริงตรงนี้แล้ว) ให้ discard ผิว
        // heightmap ทิ้งไปเลย — ไม่งั้น plane เต็มแผ่นนี้จะทับบังรูที่ slab เจาะไว้จริง
        '  if (texture2D(uHoleMask, vUv).r < 0.5) { discard; }\n' +
        '  float hC = texture2D(uHeightTex, vUv).r;\n' +
        // กัดทะลุพื้นโต๊ะ (height <= 0) = ขาดออกจากกันจริง → discard ให้เห็นทะลุถึงด้านล่าง
        // ใช้กับ Profile/Contour ที่ตัดทะลุไม่มี tab (กัด heightmap ลึกถึง realZ ที่ติดลบ/ใกล้ 0
        // ตาม cutDeeper) แทนการสร้าง slab hole แบบเดิมที่ทำให้ earcut ช้าจนแครช
        '  if (hC <= 0.02) { discard; }\n' +
        '  float hL = texture2D(uHeightTex, vUv - vec2(uTexel.x, 0.0)).r;\n' +
        '  float hR = texture2D(uHeightTex, vUv + vec2(uTexel.x, 0.0)).r;\n' +
        '  float hD = texture2D(uHeightTex, vUv - vec2(0.0, uTexel.y)).r;\n' +
        '  float hU = texture2D(uHeightTex, vUv + vec2(0.0, uTexel.y)).r;\n' +
        '  vec3 n = normalize(vec3((hL - hR) / (2.0*uCellWorldX), 1.0, (hD - hU) / (2.0*uCellWorldY)));\n' +
        // bevel ปลอม ๆ ที่ขอบนอกของแผ่น (ไม่ได้เพิ่ม geometry จริง แค่บิด normal เล็กน้อยใกล้ขอบ
        // ให้แสงตกกระทบต่างจากตรงกลาง ดูมีมุมมน/ลบเหลี่ยมเหมือนวัสดุจริงที่มีความหนา)
        '  float edgeDist = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));\n' +
        '  float edgeBevel = 1.0 - smoothstep(0.0, 0.006, edgeDist);\n' +
        '  vec2 edgeDir = vec2(step(vUv.x, 0.5) - step(0.5, vUv.x), step(vUv.y, 0.5) - step(0.5, vUv.y));\n' +
        '  n = normalize(n + vec3(edgeDir.x, 0.0, edgeDir.y) * edgeBevel * 0.6);\n' +
        // แสง 3 จุด: key (หลัก, สร้างเงา/ทิศหลัก) + fill (เติมเงาให้ไม่มืดดำสนิท) + rim (ไล้ขอบเบา ๆ)
        '  float diffKey = max(dot(n, normalize(uKeyDir)), 0.0);\n' +
        '  float diffFill = max(dot(n, normalize(uFillDir)), 0.0);\n' +
        '  float diffRim = max(dot(n, normalize(uRimDir)), 0.0);\n' +
        // specular แบบ Blinn-Phong อย่างง่าย ให้ผิวไม้มีความเงาเล็กน้อยตามมุมมอง (ไม่ใช่สีทึบแบน ๆ)
        '  vec3 viewDir = normalize(cameraPosition - vWorldPos);\n' +
        '  vec3 halfVec = normalize(normalize(uKeyDir) + viewDir);\n' +
        '  float spec = pow(max(dot(n, halfVec), 0.0), 28.0) * 0.18;\n' +
        // curvature ≈ ความเว้า/นูนรอบจุดนี้ — ใช้ทำ edge-darkening แบบประมาณ AO ขยายระยะให้นุ่มขึ้น
        // (เทียบกับเวอร์ชันก่อนที่แคบและคมเกินไปจนดูเป็นเส้นมากกว่าเงาธรรมชาติ)\n' +
        '  float curvature = hL + hR + hD + hU - 4.0 * hC;\n' +
        '  float ao = 1.0 - clamp(-curvature * 1.6, 0.0, 0.55);\n' +
        // เนื้อไม้ที่ถูกกัดใหม่ (ลึกกว่าผิวบนเดิมพอสมควร) ให้สีอ่อน/อมเหลืองกว่าผิวเดิมเล็กน้อย
        // เหมือนเนื้อไม้สดที่เพิ่งถูกเปิดออก ต่างจากผิวบนที่อาจผ่านการเคลือบ/ผึ่งมาก่อน\n' +
        '  float cutAmount = clamp((uBaseThickness - hC) * 0.4, 0.0, 1.0);\n' +
        '  vec3 freshWood = vec3(0.92, 0.78, 0.56);\n' +
        '  vec3 base = texture2D(uWoodTex, vUv * 10.0).rgb;\n' +
        // เพิ่ม "bump" ปลอมจากลายไม้เอง: ดึงความต่างของความสว่าง texture รอบจุดมาบิด normal อีกชั้น
        // เล็กน้อย (ไม่ต้องมี normal map แยก) ให้เห็นริ้วเสี้ยนไม้นูนขึ้นมาบาง ๆ ตามแสง\n' +
        '  float lumaL = dot(texture2D(uWoodTex, (vUv - vec2(0.003, 0.0)) * 10.0).rgb, vec3(0.299,0.587,0.114));\n' +
        '  float lumaR = dot(texture2D(uWoodTex, (vUv + vec2(0.003, 0.0)) * 10.0).rgb, vec3(0.299,0.587,0.114));\n' +
        '  float grainTilt = (lumaL - lumaR) * 0.4;\n' +
        '  float diff = diffKey + diffFill * 0.35 + diffRim * 0.18 + grainTilt;\n' +
        '  vec3 color = mix(base, freshWood, cutAmount * 0.45) * (0.28 + 0.95 * max(diff, 0.0)) * ao + spec;\n' +
        '  color *= mix(0.55, 1.0, 1.0 - edgeBevel * 0.7);\n' + // เข้มขึ้นเล็กน้อยตรงขอบนอกสุด (เหมือน AO ธรรมชาติของมุมวัสดุ)
        // tone mapping แบบง่าย (Reinhard-lite) กันส่วนสว่างแบนจนดูเป็นพลาสติก\n' +
        '  color = color / (1.0 + color * 0.25);\n' +
        '  gl_FragColor = vec4(color, 1.0);\n' +
        '}',
      side: THREE.DoubleSide
    });
    mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
  }

  /* ----- ลายไม้แบบ procedural: multi-octave value-noise (fBm) เลียนเสี้ยนไม้จริง -----
   * วาดด้วยโค้ดเองทั้งหมด (ไม่โหลดรูปจากเน็ต) ผ่าน ImageData ตรง ๆ เร็วกว่าวาด stroke
   * หลายร้อยเส้น และคุมทิศทาง/ความถี่ของเสี้ยนได้ละเอียดกว่าเดิม */
  function makeValueNoise2D(seed) {
    const size = 64;
    const grid = new Float32Array(size * size);
    let s = seed || 1;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    function sample(x, y) {
      x = ((x % size) + size) % size; y = ((y % size) + size) % size;
      return grid[Math.floor(y) * size + Math.floor(x)];
    }
    return function noise(x, y) {
      const xf = x - Math.floor(x), yf = y - Math.floor(y);
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const v00 = sample(x0, y0), v10 = sample(x0 + 1, y0);
      const v01 = sample(x0, y0 + 1), v11 = sample(x0 + 1, y0 + 1);
      const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
      return v00 * (1 - sx) * (1 - sy) + v10 * sx * (1 - sy) + v01 * (1 - sx) * sy + v11 * sx * sy;
    };
  }

  function woodTexture() {
    const SZ = 512;
    const c = document.createElement('canvas');
    c.width = SZ; c.height = SZ;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(SZ, SZ);
    const noiseA = makeValueNoise2D(11), noiseB = makeValueNoise2D(37), noiseC = makeValueNoise2D(91);

    // สีพื้นไม้อ่อน/เข้ม (ปลายสุดของช่วงสีที่ fBm จะไล่อยู่ระหว่างนี้)
    const lo = [168, 122, 74], hi = [222, 178, 124];

    for (let y = 0; y < SZ; y++) {
      for (let x = 0; x < SZ; x++) {
        // เสี้ยนไม้ยืดตามแกน Y (คูณ y ด้วยค่าน้อย, x ด้วยค่ามาก) ให้เป็นริ้วยาวแนวตั้ง
        // แล้วบวก fBm หลาย octave ซ้อนกันให้ได้ลายที่ไม่ซ้ำซากเหมือน noise ชั้นเดียว
        const nx = x / SZ, ny = y / SZ;
        let f = 0, amp = 1, freq = 1, sum = 0;
        const octaves = [
          { fx: 18, fy: 2.2, noise: noiseA, w: 0.55 },
          { fx: 46, fy: 5.0, noise: noiseB, w: 0.30 },
          { fx: 130, fy: 14.0, noise: noiseC, w: 0.15 }
        ];
        octaves.forEach((o) => { f += o.noise(nx * o.fx, ny * o.fy) * o.w; sum += o.w; });
        f /= sum;
        // เพิ่ม "pore" จุดเล็ก ๆ กระจายแบบสุ่มความถี่สูง ให้พื้นผิวไม่เรียบเนียนเกินไป
        const pore = noiseC(nx * 220 + 50, ny * 220 + 50);
        f = f * 0.85 + pore * 0.15;
        const t = Math.max(0, Math.min(1, f));
        const idx = (y * SZ + x) * 4;
        img.data[idx] = lo[0] + (hi[0] - lo[0]) * t;
        img.data[idx + 1] = lo[1] + (hi[1] - lo[1]) * t;
        img.data[idx + 2] = lo[2] + (hi[2] - lo[2]) * t;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /* =========================================================================
   * แปลง realZ (จาก toRealZ() เดิมใน app.js) -> ความสูงจากพื้นโต๊ะ
   * ====================================================================== */
  function heightFromRealZ(realZ, machine) {
    if (machine.z0Mode === 'table') return realZ;
    return baseThickness + realZ;
  }

  // คืนค่า { profileType, profileParam } ตามชนิดดอก — ใช้ในสมการ shader
  // 0 = flat (endmill/formtool), 1 = V-bit (cone), 2 = ball nose (เผื่ออนาคต)
  function toolProfile(tool) {
    if (!tool) return { profileType: 0, profileParam: 0 };
    if (tool.toolType === 'vbit') {
      const angleRad = ((parseFloat(tool.vbitAngle) || 90) * Math.PI) / 180;
      return { profileType: 1, profileParam: 1 / Math.tan(angleRad / 2) };
    }
    // ballnose: เผื่อไว้ในอนาคตถ้า Tool Library เพิ่มชนิดนี้ (ยังไม่มีในระบบปัจจุบัน)
    if (tool.toolType === 'ballnose') {
      return { profileType: 2, profileParam: (tool.diameter || 6) / 2 };
    }
    return { profileType: 0, profileParam: 0 }; // endmill, formtool (ค่าประมาณ flat)
  }

  // ทะลุหรือไม่: เทียบความสูงของ pass สุดท้ายกับระดับโต๊ะ (0) — เผื่อ cutDeeper เล็กน้อย
  function isThroughOp(op, machine) {
    const passesZ = op.passes && op.passes.length ? op.passes : [op.targetZ];
    const lastH = heightFromRealZ(passesZ[passesZ.length - 1], machine);
    return lastH <= 0.15;
  }

  // เงื่อนไขที่จะให้เป็น "รูทะลุจริง" (ExtrudeGeometry hole ใน slab):
  //   - drill เท่านั้น ที่ทะลุ — เป็นรูกลมเดี่ยว ๆ ไม่กี่รู earcut คำนวณเร็ว ไม่มีปัญหา
  //   - contour/profile: ไม่ใช้ slab hole อีกต่อไป (เดิมทำเป็น kerf quad หลายร้อยชิ้น ทำให้
  //     earcut ช้าจนแครช + winding order ไม่นิ่งจนร่องขาดเป็นช่วง) เปลี่ยนไปกัด heightmap
  //     ลึกทะลุแทน แล้ว fragment shader ของผิว heightmap discard จุดที่ความสูง <= 0 ออกเอง
  //     (เห็นทะลุถึงพื้นโต๊ะ = ขาดจากกันจริง, เรียบตาม texture 1280px, ไม่ผ่าน earcut เลย)
  function classifyAsHole(op, machine) {
    if (op.kind === 'drill') return isThroughOp(op, machine);
    return false;
  }

  function buildHolePolygons(op) {
    // เหลือเฉพาะ drill (วงกลม) — contour ไม่เรียกฟังก์ชันนี้แล้ว
    const r = (op.tool && op.tool.diameter ? op.tool.diameter : 6) / 2;
    const N = 24;
    const poly = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      poly.push({ x: op.point.x + Math.cos(a) * r, y: op.point.y + Math.sin(a) * r });
    }
    return [poly];
  }

  /* =========================================================================
   * สร้างลำดับ "การกัด" ทั้งหมดล่วงหน้า — แบ่งเป็น 2 ชนิด action:
   *   - { type:'hole', polygon, ... }  รูทะลุจริง (เผยเข้า revealedHoles ตอนเล่นถึง)
   *   - { type:'stamp', x,y,r,h,... }  กัด heightmap แบบเดิม (pocket/มี tab/ไม่ทะลุ)
   * ====================================================================== */
  function buildActions(operations, machine) {
    actions = [];
    // ใช้ฟังก์ชันเดียวกับที่ gcode-generator.js ใช้จัดลำดับการตัดจริง (เจาะ/pocket ก่อน,
    // ตัดนอกล็อกท้ายสุดเสมอ ฯลฯ) — ห้ามเขียน logic เรียงลำดับแยกเอง เพราะจะเพี้ยนจาก
    // G-code จริงได้ถ้าอีกฝั่งแก้กฎแล้วลืมอัปเดตที่นี่
    const GG = global.GCodeGenerator;
    let ops;
    if (GG && typeof GG.orderOperations === 'function') {
      const groups = GG.orderOperations(operations || [], machine);
      ops = [];
      groups.forEach((g) => { ops.push.apply(ops, g.ops); });
    } else {
      // fallback เผื่อโหลดสคริปต์ผิดลำดับ (ไม่ควรเกิดขึ้นถ้า index.html โหลด gcode-generator.js
      // มาก่อน simulate-3d.js) — ใช้ลำดับดิบไปก่อน ดีกว่า error
      ops = (operations || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    }
    const sampleStep = Math.max(boundsW / texW, boundsH / texH) * 1.2;

    ops.forEach((op) => {
      const tool = op.tool;

      if (classifyAsHole(op, machine)) {
        const polygons = buildHolePolygons(op);
        const last = op.kind === 'drill' ? op.point : (op.path[op.path.length - 1] || { x: originX, y: originY });
        if (polygons.length) actions.push({ type: 'hole', polygons, x: last.x, y: last.y, h: 0, tool });
        return;
      }

      const radius = (tool && tool.diameter ? tool.diameter : 6) / 2;
      const profile = toolProfile(tool);

      if (op.kind === 'drill') {
        const seq = (op.passes && op.passes.length ? op.passes : [op.targetZ]).map((z) => heightFromRealZ(z, machine));
        seq.forEach((h) => actions.push({ type: 'stamp', x: op.point.x, y: op.point.y, r: radius, h, profileType: profile.profileType, profileParam: profile.profileParam, tool }));
        return;
      }

      const rings = op.kind === 'pocket' ? (op.rings || []) : [op.path];
      const tabSpans = (op.kind === 'contour' && op.tabs) ? op.tabs : [];
      const tabHeight = (op.kind === 'contour' && op.tabTopZ !== undefined) ? heightFromRealZ(op.tabTopZ, machine) : null;
      const passesZ = op.passes && op.passes.length ? op.passes : [op.targetZ];

      rings.forEach((ring) => {
        if (!ring || ring.length < 2) return;
        const samples = samplePath(ring, sampleStep);
        passesZ.forEach((z) => {
          const h = heightFromRealZ(z, machine);
          samples.forEach((s) => {
            let hh = h;
            if (tabSpans.length && tabHeight !== null) {
              const inTab = tabSpans.some((t) => s.dist >= t.start && s.dist <= t.end);
              if (inTab) hh = Math.max(h, tabHeight);
            }
            actions.push({ type: 'stamp', x: s.x, y: s.y, r: radius, h: hh, profileType: profile.profileType, profileParam: profile.profileParam, tool });
          });
        });
      });
    });
  }

  function samplePath(pts, step) {
    const out = [{ x: pts[0].x, y: pts[0].y, dist: 0 }];
    let dist = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-9) continue;
      let travelled = 0;
      while (travelled + step < segLen) {
        travelled += step;
        const t = travelled / segLen;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dist: dist + travelled });
      }
      dist += segLen;
      out.push({ x: b.x, y: b.y, dist });
    }
    return out;
  }

  /* =========================================================================
   * Playback control
   * ====================================================================== */
  function play() {
    if (!actions.length || busy) return;
    if (actionIdx >= actions.length) {
      // เล่นจบไปแล้ว ต้อง rebuild จากศูนย์ก่อน — รอให้ rebuild เสร็จแล้วค่อยเริ่มเล่นจริง
      // (seekTo เป็น async-chunked แล้ว ตั้ง playing=true ทันทีตรงนี้จะเล่นทับ rebuild ที่ยังไม่เสร็จ)
      seekTo(0, () => { playing = true; lastTs = 0; report(); });
      return;
    }
    playing = true; lastTs = 0;
    report();
  }
  function pause() { playing = false; report(); }
  function setSpeed(v) { speed = clamp(v, 0.1, 30); }
  function setProgressCallback(fn) { onProgress = fn; }
  function report() { if (onProgress) onProgress(actionIdx, actions.length); }

  function setBusy(v) { busy = v; report(); }

  function applyToolVisual(a) {
    const num = a.tool ? a.tool.number : undefined;
    if (currentToolNumber !== num) { ensureToolMesh(a.tool); currentToolNumber = num; }
    updateToolMesh(a);
  }

  // ประมวลผล action ช่วงหนึ่ง (mix ของ 'hole' และ 'stamp' ปนกันได้) — 'stamp' รวมเป็น batch
  // ยิง GPU ทีละกลุ่มเหมือนเดิม, 'hole' แค่ push polygon เข้า revealedHoles (ถูกของจริงทีหลัง
  // ครั้งเดียวตอน sync ของแต่ละเฟรม ไม่ใช่ rebuild ทุก action เพื่อกัน rebuild ถี่เกินจำเป็น)
  function processActions(list) {
    let lastAction = null;
    let i = 0;
    while (i < list.length) {
      if (list[i].type === 'hole') {
        revealedHoles.push.apply(revealedHoles, list[i].polygons);
        slabDirty = true;
        lastAction = list[i];
        i++;
      } else {
        let j = i;
        const buf = [];
        while (j < list.length && list[j].type !== 'hole' && buf.length < BATCH) { buf.push(list[j]); j++; }
        if (buf.length) runStampBatch(buf);
        lastAction = buf[buf.length - 1] || lastAction;
        i = j;
      }
    }
    return lastAction;
  }

  function stepPlayback(ts) {
    if (!actions.length) { playing = false; return; }
    if (!lastTs) lastTs = ts;
    const dt = ts - lastTs; lastTs = ts;
    const stepsWanted = Math.max(1, Math.round(speed * dt * 0.1));
    const end = Math.min(actionIdx + stepsWanted, actions.length);
    const lastAction = processActions(actions.slice(actionIdx, end));
    actionIdx = end;
    if (lastAction) applyToolVisual(lastAction);
    syncMeshTexture();
    rebuildSlabIfDirty();
    report();
    if (actionIdx >= actions.length) playing = false;
  }

  /* ---------------------------------------------------------------------------
   * seekTo(fraction, onComplete?) — ไปยังตำแหน่งที่ต้องการบน action queue
   *   - เดินหน้าจากจุดเดิม: stamp/เผยรู แค่ส่วนต่าง (เร็ว)
   *   - ย้อนกลับ: clear heightmap + รีเซ็ต revealedHoles แล้วเล่นใหม่ทั้งหมดตั้งแต่ต้น
   *   - ทำงานแบบ async-chunked เสมอ (ไม่บล็อก main thread แม้ action จะมีหลักแสน)
   *   - มี generation token: ถ้ามีการเรียก seekTo()/loadJob() ใหม่ก่อนงานเก่าจะเสร็จ
   *     (เช่นสลับแท็บไฟล์รัว ๆ, เปิดไฟล์ใหม่ระหว่างกำลัง rebuild) งานเก่าจะถูกทิ้งอัตโนมัติ
   *     ไม่ทำให้ค้างซ้อนกัน และไม่ทำให้ภาพ 3D ไม่ตรงกับแท็บที่เลือกอยู่จริง
   * ------------------------------------------------------------------------- */
  function seekTo(fraction, onComplete) {
    if (!actions.length) {
      actionIdx = 0; report();
      if (onComplete) onComplete();
      return;
    }
    const target = Math.round(clamp(fraction, 0, 1) * actions.length);
    generation++;
    const myGen = generation;
    setBusy(true);

    function finish() {
      if (myGen !== generation) return; // มีงานใหม่แทนที่ไปแล้ว ไม่ finalize ของเก่า
      actionIdx = target;
      if (target > 0) applyToolVisual(actions[target - 1]);
      else if (toolMesh) toolMesh.visible = false;
      syncMeshTexture();
      rebuildSlabIfDirty(true); // บังคับให้ตรงกับ progress สุดท้ายเสมอ (ไม่ปล่อยให้ throttle ข้าม)
      setBusy(false);
      lastTs = 0;
      if (onComplete) onComplete();
    }

    if (target < actionIdx) {
      clearHeight(baseThickness);
      currentToolNumber = null;
      revealedHoles = [];     // ย้อนกลับ = ต้องล้างรูที่เผยไว้ทั้งหมดด้วย ไม่ใช่แค่ heightmap
      slabDirty = true;
      actionIdx = 0;
      runRangeAsync(0, target, myGen, finish);
    } else if (target > actionIdx) {
      runRangeAsync(actionIdx, target, myGen, finish);
    } else {
      finish();
    }
  }

  // รัน action ตั้งแต่ index [from, to) แบบแบ่งเป็น chunk ต่อเฟรม (กัน main thread ค้าง)
  // เช็ค generation token ทุกเฟรมก่อนทำงาน — ถ้าถูกแทนที่ด้วยงานใหม่แล้วจะหยุดทันที
  function runRangeAsync(from, to, myGen, onDone) {
    let i = from;
    function step() {
      if (myGen !== generation) return; // ถูกยกเลิก (มีงาน rebuild ใหม่กว่าเข้ามาแล้ว)
      const end = Math.min(i + BATCH * CHUNK_BATCHES, to);
      processActions(actions.slice(i, end));
      i = end;
      actionIdx = i;
      syncMeshTexture();
      rebuildSlabIfDirty();
      report();
      if (i < to) requestAnimationFrame(step);
      else onDone();
    }
    step();
  }

  function syncMeshTexture() {
    if (mesh) mesh.material.uniforms.uHeightTex.value = rtA.texture;
  }

  /* =========================================================================
   * หัวเครื่องมือ (เหมือนเวอร์ชันก่อน — ยังเป็น CPU mesh ธรรมดา เบาอยู่แล้ว)
   * ====================================================================== */
  function ensureToolMesh(tool) {
    if (toolMesh) {
      group.remove(toolMesh);
      toolMesh.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    }
    const dia = (tool && tool.diameter) || 6;
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa7b4, metalness: 0.65, roughness: 0.3 });
    const shaftLen = Math.max(baseThickness * 2.5, 40);
    const grp = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2, dia / 2, shaftLen, 16), mat);
    shaft.position.y = shaftLen / 2;
    grp.add(shaft);
    if (tool && tool.toolType === 'vbit') {
      const angle = (tool.vbitAngle || 90) * Math.PI / 180;
      const tipLen = (dia / 2) / Math.tan(angle / 2);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(dia / 2, tipLen, 16), mat);
      tip.position.y = -tipLen / 2;
      grp.add(tip);
    }
    toolMesh = grp;
    group.add(toolMesh);
  }

  function updateToolMesh(action) {
    if (!toolMesh) return;
    toolMesh.visible = true;
    // กลับเครื่องหมาย Z เหมือนกับใน buildGeometry (ต้องสอดคล้องกันเสมอ ไม่งั้นหัวมีด
    // จะไปอยู่ตำแหน่งสมมาตรตรงข้ามกับร่องที่กัดจริงบน mesh)
    toolMesh.position.set(action.x - centerOffsetX(), action.h, -(action.y - centerOffsetY()));
  }

  function frameCamera() {
    const span = Math.max(boundsW, boundsH, baseThickness * 3);
    orbit.target.set(0, baseThickness / 2, 0);
    orbit.radius = span * 1.25;
    // theta = 0: กล้องอยู่บนแกน Z ล้วน ๆ (ไม่ผสมแกน X) -> แกน X จริงแม็พเป็นซ้าย-ขวา
    // บนจอแบบล้วน ๆ ไม่ปนกับแกน Y จริง (ดู comment ที่ buildGeometry/updateToolMesh
    // เรื่องการกลับเครื่องหมายแกน Z เพื่อให้ Y จริง = บน-ล่าง ตรงกับ preview 2D เดิม)
    orbit.theta = 0;
    orbit.phi = Math.PI * 0.32;
    updateCamera();
  }

  function dispose() {
    playing = false;
  }

  global.Simulate3D = { init, loadJob, play, pause, setSpeed, seekTo, setProgressCallback, dispose };

})(typeof window !== 'undefined' ? window : globalThis);
