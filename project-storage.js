/* =============================================================================
 * project-storage.js (v2)
 * -----------------------------------------------------------------------------
 * เปลี่ยนจากเดิม: ตัดฟังก์ชัน deserializeProject/โหลดโปรเจกต์ออก (ระบบดึงค่าจาก
 * server อัตโนมัติแล้ว) เหลือไว้แค่:
 *   - downloadText: ดาวน์โหลดข้อความเป็นไฟล์เดียว
 *   - downloadZip: รวมหลายไฟล์ G-code เป็น .zip เดียว (ใช้ JSZip จาก CDN)
 *   - readFileAsText: อ่านไฟล์ DXF ที่ผู้ใช้เลือก
 * ========================================================================== */

(function (global) {
  'use strict';

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------------------------------------------------------------------------
   * รวมไฟล์ G-code หลายไฟล์เป็น .zip เดียว
   * files = [{ name: 'side-panel.nc', content: '...gcode...' }, ...]
   * ต้องโหลด JSZip จาก CDN ไว้ก่อน (ดู index.html) — ถ้าโหลดไม่ทันจะ throw error
   * ------------------------------------------------------------------------- */
  async function downloadZip(zipFilename, files) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip ยังโหลดไม่สำเร็จ ลองเปิดหน้าใหม่อีกครั้ง');
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f.content);
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = zipFilename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
      reader.readAsText(file);
    });
  }

  global.ProjectStorage = { downloadText, downloadZip, readFileAsText };

})(typeof window !== 'undefined' ? window : globalThis);
