/* =============================================================================
 * machine-config.js (v2)
 * -----------------------------------------------------------------------------
 * สถานะกลางของแอป + ค่าตั้งต้น
 *   - Machine Setup: units, safeZ, rapidClearance, pocketStepover,
 *     woodThickness, originCorner (มุมอ้างอิง X0Y0 จาก _ABF_SHEET_BORDER),
 *     z0Mode ('top' ผิวไม้ / 'table' พื้นโต๊ะตัด), cutDeeper
 *   - Tool Library: เพิ่ม isOutsideTool (ทูลหลักสำหรับตัดนอก)
 *   - Layer Mapping: จดจำถาวรผูกกับชื่อ Layer ข้ามไฟล์ (เก็บใน savedMappings)
 *   - ลำดับการตัด (cutOrder): ลำดับกลุ่มมีดสำหรับเฟส 1 (Pocket/Drill/Engrave)
 * ========================================================================== */

(function (global) {
  'use strict';

  const OPERATIONS = [
    'None',
    'Profile Outside',
    'Profile Inside',
    'Profile On Line',
    'Pocket',
    'Drill',
    'Engrave'
  ];

  // เลเยอร์อ้างอิงจาก ABF/SketchUp ที่ไม่ใช่งานตัด — ไม่แสดงในหน้า Layer และไม่นำไปสร้าง toolpath
  // _ABF_SHEET_BORDER ยังใช้เป็นกรอบอ้างอิงจุด (0,0) ได้ (และตอนนี้แสดงในพรีวิวด้วย)
  // แต่ _ABF_SHEET_ID / _ABF_SHEET_MATERIAL เป็นแค่ข้อความกำกับ ไม่เกี่ยวกับการตัดเลย
  const EXCLUDED_LAYERS = ['_ABF_SHEET_BORDER', '_ABF_SHEET_ID', '_ABF_SHEET_MATERIAL'];
  // เลเยอร์ที่ล็อกลำดับให้อยู่ท้ายสุดเสมอ (แก้ไขลำดับไม่ได้)
  const LOCKED_LAST_LAYER = '_ABF_CUTTING_LINES';

  function defaultMachine() {
    return {
      units: 'mm',
      safeZ: 25,
      rapidClearance: 3,
      pocketStepover: 40,
      woodThickness: 18,       // ความหนาไม้ (mm)
      originCorner: 'bottom-left', // มุมของ _ABF_SHEET_BORDER ที่ใช้เป็น (0,0): bottom-left/bottom-right/top-left/top-right
      z0Mode: 'top',           // 'top' = ผิวไม้, 'table' = พื้นโต๊ะตัด (สเปกบอร์ด)
      cutDeeper: 0.3,          // ระยะกัดเลยเผื่อ (ใช้เมื่อ z0Mode = 'table')
      cutDirection: 'climb',   // ทิศทางตัด: 'climb' (ตามเข็มนาฬิกา) | 'conventional' (สวนเข็มนาฬิกา)
                               // ใช้ร่วมกันทั้ง Profile Outside และ Profile Inside
      tabWidth: 6,             // ค่ากลาง Tab — ใช้ร่วมกันทุกทูล (ย้ายมาจาก Tool Library เดิม)
      tabHeight: 4,
      tabCount: 4,
      smallPartThreshold: 150, // ด้านแคบที่สุดของ bounding box (mm) ที่ถือว่าเป็น "ชิ้นงานขนาดเล็ก"
                               // ใช้กับ layer ที่ขึ้นต้นด้วย cut_outside_ เท่านั้น
                               // 0 = ปิดฟีเจอร์ (ไม่แบ่งกลุ่มเล็ก/ใหญ่)
      smallPartFinalPass: 2    // ความหนาของรอบตัดก่อนสุดท้ายสำหรับชิ้นเล็ก (mm)
                               // เช่น 2 → แทรก pass ที่ความสูง realZ_final+2 ก่อน pass จริง
                               // 0 = ไม่เพิ่มรอบพิเศษ
    };
  }

  function makeTool(number, over) {
    return Object.assign({
      number: number,
      name: number + ' Tool',
      diameter: 6,             // เส้นผ่านศูนย์กลางก้านมีด — ใช้ร่วมกันทั้ง Endmill/V-bit/Formtool
      spindle: 18000,
      feedXY: 4000,
      feedZ: 1000,
      passDepth: 5,
      safeHeight: 25,
      isOutsideTool: false,  // ทูลหลักสำหรับตัดนอก (ใช้เป็น default tool ของ mapping ที่เลือก Profile Outside)
      toolType: 'endmill',   // ชนิดทูล: 'endmill' | 'vbit' | 'formtool' — ตอนนี้เป็นแค่ข้อมูลกำกับ
                             // ยังไม่ผูกกับการคำนวณ G-code/offset ใด ๆ (รอเฟสถัดไป)
      vbitAngle: 90,         // องศาดอก — ใช้เฉพาะ toolType==='vbit'
      vbitTipDiameter: 0     // ขนาดปลายดอก (mm) — ใช้เฉพาะ toolType==='vbit', แก้ไขได้ (0 = ปลายแหลม)
    }, over || {});
  }

  function defaultTools() {
    return {
      1: makeTool(1, { name: '6mm Compression', diameter: 6, spindle: 18000, feedXY: 5000, feedZ: 1500, passDepth: 5, isOutsideTool: true }),
      2: makeTool(2, { name: '3mm Endmill',     diameter: 3, spindle: 22000, feedXY: 3000, feedZ: 800,  passDepth: 2 }),
      3: makeTool(3, { name: '5mm Drill',       diameter: 5, spindle: 12000, feedXY: 1000, feedZ: 500,  passDepth: 6 })
    };
  }

  const defaultToolChange =
`M5
G0 Z50
G0 X0 Y0
M6 T{tool}`;

  function defaultHeader(units) {
    return [units === 'inch' ? 'G20' : 'G21', 'G17', 'G90', 'G40', 'G49', 'G80'].join('\n');
  }
  const defaultFooter =
`M5
G0 Z50
G0 X0 Y0
M30`;

  // หา "ทูลหลักสำหรับตัดนอก" ตัวแรกที่ตั้งไว้ ถ้าไม่มีให้ใช้ทูลแรกสุด
  function findOutsideTool(tools) {
    const keys = Object.keys(tools).map(Number).sort((a, b) => a - b);
    const found = keys.find(n => tools[n].isOutsideTool);
    return found || keys[0] || 1;
  }

  // หาทูลตัวแรกที่ตั้ง toolType ตรงกับที่ต้องการ (เช่น 'vbit', 'formtool') ใช้เป็นค่าเริ่มต้น
  // ของโหมดตีบัวหน้าบาน — ถ้าไม่เจอคืน null (ให้ผู้ใช้เลือกเอง)
  function findToolByType(tools, type) {
    const keys = Object.keys(tools).map(Number).sort((a, b) => a - b);
    const found = keys.find(n => (tools[n].toolType || 'endmill') === type);
    return found || null;
  }

  // ค่าตั้งต้นของโหมด "ตีบัวหน้าบาน" — เก็บแยกต่อแท็บไฟล์ (ไม่ใช้ร่วมกันข้ามไฟล์)
  function defaultDoorMode(tools) {
    return {
      enabled: false,
      offset: 10,          // ระยะ V-line จากขอบหน้าบาน (mm)
      depth: 5,            // ความลึกตัด ใช้ร่วมกันทั้ง V-bit และ FormTool (mm)
      vbitTool: findToolByType(tools, 'vbit'),
      formtoolTool: findToolByType(tools, 'formtool'),
      vlineTool: null,     // มีดเดินตามเส้น V-line เพิ่มมิติให้งาน (ไม่บังคับเลือก)
      vlineDepth: 1,       // ความลึกของรอยตาม V-line — ตัวเลขตรง ๆ ไม่มีนิพจน์ (mm)
      borderTool: null,    // มีดตัดขอบออกจากแผ่นจริง (ไม่บังคับเลือก, ทำทีหลังสุดเสมอ)
      borderDepth: 'pt+cd' // ความลึกตัดขอบ — เป็นนิพจน์ได้ (pt=ความหนาไม้, cd=Cut Deeper)
    };
  }

  /* ---------------------------------------------------------------------------
   * สร้าง mapping เริ่มต้นสำหรับชื่อ layer ที่ "ไม่เคยเจอมาก่อน"
   * ถ้าเคยบันทึกไว้แล้ว (savedMappings) ให้ใช้ของเดิมเสมอ — ฟังก์ชันนี้จะถูกเรียก
   * เฉพาะกรณีที่ไม่มีค่าบันทึกไว้ (ดู resolveMapping ใน app.js)
   * ------------------------------------------------------------------------- */
  function guessMapping(layerName, tools, machine) {
    const up = layerName.toUpperCase();
    let operation = 'Profile Outside';
    if (up.includes('POCKET')) operation = 'Pocket';
    else if (up.includes('DRILL') || up.includes('BORE') || up.includes('HOLE')) operation = 'Drill';
    else if (up.includes('ENGRAVE') || up.includes('VCARVE') || up.includes('SCORE')) operation = 'Engrave';
    else if (up.includes('INSIDE')) operation = 'Profile Inside';
    else if (up.includes('ONLINE') || up.includes('ON_LINE') || up.includes('ON-LINE')) operation = 'Profile On Line';

    let toolNumber;
    let depth;
    if (operation.indexOf('Profile') === 0) {
      // งานตัด: default tool = ทูลหลักสำหรับตัดนอก (ใช้ตัวเดียวกันเป็น default ของทุก Profile ชนิด)
      toolNumber = findOutsideTool(tools);
      // depth เก็บเป็น "นิพจน์" ไม่ใช่ตัวเลขตายตัว — pt = ความหนาไม้, cd = Cut Deeper
      // คำนวณสดทุกครั้งจากค่าปัจจุบัน ไม่ต้องคอยแก้มือเวลาเปิดไฟล์ที่หนาต่างกันแต่ใช้ชื่อ Layer เดิม
      depth = 'pt+cd';
    } else {
      // Pocket/Drill/Engrave: default tool = ทูลแรกสุด, depth = 0 (ให้ผู้ใช้กรอกเอง)
      const keys = Object.keys(tools).map(Number).sort((a, b) => a - b);
      toolNumber = keys[0] || 1;
      depth = 0;
    }
    return {
      operation, toolNumber, depth, enabled: true,
      tabsEnabled: false,   // default ไม่ใส่ tab เสมอ (ขนาด/จำนวน tab ใช้ค่ากลางจาก Machine Setup)
      order: null           // ลำดับการตัด (null = ไม่กรอก ใช้กฎ default ตามเลขมีด)
    };
  }

  function defaultState() {
    return {
      machine: defaultMachine(),
      tools: defaultTools(),
      savedMappings: {},   // { [layerName]: {operation,toolNumber,depth,enabled,tabsEnabled,tabCount} } — จดจำถาวร
      toolChange: defaultToolChange,
      header: defaultHeader('mm'),
      footer: defaultFooter,
      version: 2
    };
  }

  global.MachineConfig = {
    OPERATIONS, EXCLUDED_LAYERS, LOCKED_LAST_LAYER,
    defaultMachine, defaultTools, makeTool, defaultState,
    defaultToolChange, defaultHeader, defaultFooter,
    guessMapping, findOutsideTool, findToolByType, defaultDoorMode
  };

})(typeof window !== 'undefined' ? window : globalThis);
