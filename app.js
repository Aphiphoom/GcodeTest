! function() {
    "use strict";
    const e = window.DXFReader,
        t = window.MachineConfig,
        o = window.ToolpathGenerator,
        n = window.GCodeGenerator,
        a = window.ProjectStorage,
        s = window.AuthClient,
        l = e => document.getElementById(e);
    let i = t.defaultState(),
        r = [],
        c = null,
        d = 0,
        u = null;
    const p = ["#f5a623", "#34d2c0", "#7c9cff", "#ff8ac4", "#9ad14e", "#ffd24d", "#ff7a5c", "#56c2e6", "#c08bff", "#8de0b0"],
        f = (t.EXCLUDED_LAYERS || []).filter(e => "_ABF_SHEET_BORDER" !== e),
        m = "_ABF_SHEET_BORDER";
    let h = null;
    const layerColorRegistry = new Map;
    let nextLayerColorIndex = 0;

    function resetLayerColorRegistry() {
        layerColorRegistry.clear(), nextLayerColorIndex = 0
    }

    function colorForLayerName(e) {
        const t = String(e || "");
        return layerColorRegistry.has(t) || (layerColorRegistry.set(t, p[nextLayerColorIndex % p.length]), nextLayerColorIndex++), layerColorRegistry.get(t)
    }

    function b() {
        clearTimeout(h), g("กำลังจะบันทึก..."), h = setTimeout(y, 900)
    }
    async function y() {
        clearTimeout(h), g("กำลังบันทึก...");
        try {
            const {
                error: e
            } = await s.sb.from("user_settings").upsert({
                user_id: u,
                machine: i.machine,
                tools: i.tools,
                saved_mappings: i.savedMappings,
                tool_change: i.toolChange,
                header: i.header,
                footer: i.footer,
                updated_at: (new Date).toISOString()
            });
            g(e ? "⚠ บันทึกไม่สำเร็จ" : "✓ บันทึกแล้ว")
        } catch (e) {
            g("⚠ บันทึกไม่สำเร็จ (เครือข่าย)")
        }
    }

    function g(e) {
        const t = l("saveIndicator");
        t && (t.textContent = e), setTimeout(() => {
            t && t.textContent === e && (t.textContent = "")
        }, 2500)
    }

    function v(e) {
        return i.savedMappings[e] || (i.savedMappings[e] = t.guessMapping(e, i.tools, i.machine), b()), i.savedMappings[e]
    }

    function T() {
        return r.find(e => e.id === c) || null
    }

    function k(e, t) {
        const o = parseFloat(t.woodThickness) || 0,
            n = parseFloat(t.cutDeeper) || 0,
            a = null == e ? "" : String(e).trim();
        if ("" === a) return 0;
        const s = a.replace(/\bpt\b/g, "").replace(/\bcd\b/g, "");
        if (!/^[0-9+\-*/().\s]*$/.test(s)) return NaN;
        try {
            const e = new Function("pt", "cd", `return (${a});`)(o, n);
            return "number" == typeof e && isFinite(e) ? e : NaN
        } catch (e) {
            return NaN
        }
    }
    async function x(o) {
        const n = await a.readFileAsText(o);
        let s;
        try {
            s = e.parse(n)
        } catch (e) {
            return void he(["อ่านไฟล์ " + o.name + " ไม่สำเร็จ: " + e.message])
        }
        const l = function(e, t) {
            switch (t) {
                case "bottom-right":
                    return {
                        x: e.maxX, y: e.minY
                    };
                case "top-left":
                    return {
                        x: e.minX, y: e.maxY
                    };
                case "top-right":
                    return {
                        x: e.maxX, y: e.maxY
                    };
                default:
                    return {
                        x: e.minX, y: e.minY
                    }
            }
        }(e.computeBounds(s.entities), i.machine.originCorner);
        ! function(e, t, o) {
            for (const n of e) {
                for (const e of n.points) e.x -= t, e.y -= o;
                void 0 !== n.cx && (n.cx -= t, n.cy -= o)
            }
        }(s.entities, l.x, l.y), s.bounds = e.computeBounds(s.entities);
        const u = "tab" + ++d,
            h = {},
            b = {};
        s.layers.forEach((e, o) => {
            if (e === m || -1 !== f.indexOf(e)) return;
            h[e] = colorForLayerName(e), b[e] = !0;
            const n = v(e);
            e === t.LOCKED_LAST_LAYER && (n.depth = "pt+cd")
        });
        const y = ne(o.name),
            g = null !== y.thickness ? y.thickness : i.machine.woodThickness,
            T = {
                id: u,
                fileName: o.name,
                dxf: s,
                layerColor: h,
                layerVisible: b,
                lastJob: null,
                gcode: "",
                stats: null,
                doorMode: t.defaultDoorMode(i.tools),
                lastDoors: null,
                isBottom: y.isBottom !== undefined ? y.isBottom : /bottom/i.test(o.name),
                woodThickness: g,
                woodColor: y.color || ""
            };
        r.push(T), c = u, E(), q(), W(), N(), ce(), oe(), fe()
    }

    function w(e) {
        r = r.filter(t => t.id !== e), c === e && (c = r.length ? r[r.length - 1].id : null), E(), q(), W(), P(), ce()
    }

    function E() {
        const e = l("fileTabs");
        e.innerHTML = "", r.forEach(t => {
            const o = document.createElement("div");
            o.className = "filetab" + (t.id === c ? " active" : ""), o.innerHTML = `<span>${t.fileName}${t.isBottom?' <span class="badge-bottom" title="Bottom file — cut_outside_ จะถูกข้าม">[B]</span>':""}</span><span class="ft-close" title="ปิดไฟล์นี้">✕</span>`, o.querySelector("span").addEventListener("click", () => {
                pe() || (c = t.id, E(), q(), X(), N(), P(), fe(), oe())
            }), o.querySelector(".ft-close").addEventListener("click", e => {
                e.stopPropagation(), pe() || w(t.id)
            }), e.appendChild(o)
        })
    }
    function isSketchUpHtmlDialog() {
        return "object" == typeof window.sketchup || /SketchUp/i.test(navigator.userAgent || "")
    }

    function readFileAsArrayBuffer(e) {
        if (e && "function" == typeof e.arrayBuffer) return e.arrayBuffer().catch(() => readFileWithFileReader(e));
        return readFileWithFileReader(e)
    }

    function readFileWithFileReader(e) {
        return new Promise((t, o) => {
            const n = new FileReader;
            n.onload = () => t(n.result), n.onerror = () => o(n.error || new Error("ไม่สามารถอ่านไฟล์ได้")), n.onabort = () => o(new Error("ยกเลิกการอ่านไฟล์")), n.readAsArrayBuffer(e)
        })
    }

    function classifyInputFiles(e) {
        const t = [],
            o = [];
        for (const n of e) /\.zip$/i.test(n.name) ? t.push({
            _zip: !0,
            file: n
        }) : /\.dxf$/i.test(n.name) ? t.push(n) : o.push(n.name || "ไฟล์ไม่มีชื่อ");
        return {
            accepted: t,
            rejected: o
        }
    }

    async function L(e) {
        const t = [];
        for (const o of e)
            if (o._zip) try {
                if (!window.JSZip) throw new Error("JSZip โหลดไม่สำเร็จ กรุณาตรวจการเชื่อมต่ออินเทอร์เน็ต");
                const e = await readFileAsArrayBuffer(o.file),
                    n = await window.JSZip.loadAsync(e);
                let a = 0;
                for (const [e, o] of Object.entries(n.files))
                    if (/\.dxf$/i.test(e) && !o.dir) {
                        const n = await o.async("string");
                        t.push(new File([n], e.split("/").pop(), {
                            type: "text/plain"
                        })), a++
                    }
                a || he(["ZIP " + o.file.name + " ไม่มีไฟล์ DXF"])
            } catch (e) {
                he(["เปิด ZIP " + o.file.name + " ไม่สำเร็จ: " + e.message])
            } else t.push(o);
        if (t.length) {
            resetLayerColorRegistry();
            r.length && [...r].forEach(e => w(e.id));
            for (const e of t) await x(e)
        }
    }
    const dxfInput = l("dxfInput");
    isSketchUpHtmlDialog() && dxfInput.removeAttribute("accept");
    l("btnOpenDxfLabel").addEventListener("click", e => {
        pe() && e.preventDefault()
    }), dxfInput.addEventListener("change", async e => {
        if (pe()) return void(e.target.value = "");
        const t = Array.from(e.target.files || []);
        if (!t.length) return void(e.target.value = "");
        const o = classifyInputFiles(t);
        o.rejected.length && he(["ไม่รองรับไฟล์: " + o.rejected.join(", ")]), await L(o.accepted), e.target.value = ""
    });
    const $ = l("preview"),
        D = $.getContext("2d"),
        M = l("preview3d");
    let S = !1,
        C = {
            scale: 1,
            ox: 50,
            oy: 50
        };

    function F(e, t) {
        return {
            x: e * C.scale + C.ox,
            y: $.clientHeight - (t * C.scale + C.oy)
        }
    }

    function _(e, t) {
        return {
            x: (e - C.ox) / C.scale,
            y: ($.clientHeight - t - C.oy) / C.scale
        }
    }

    function O() {
        const e = window.devicePixelRatio || 1,
            t = $.clientWidth,
            o = $.clientHeight;
        0 !== t && 0 !== o && ($.width = Math.round(t * e), $.height = Math.round(o * e), D.setTransform(e, 0, 0, e, 0, 0), P())
    }

    function H(e) {
        return Math.round(e) + .5
    }

    function N() {
        const e = T();
        if (!e) return C = {
            scale: 1,
            ox: 50,
            oy: 50
        }, void P();
        const t = e.dxf.bounds,
            o = $.clientWidth - 80,
            n = $.clientHeight - 80,
            a = o / (t.width || 1),
            s = n / (t.height || 1);
        C.scale = Math.min(a, s), C.ox = 40 + (o - t.width * C.scale) / 2 - t.minX * C.scale, C.oy = 40 + (n - t.height * C.scale) / 2 - t.minY * C.scale, P()
    }

    function P() {
        const e = $.clientWidth,
            t = $.clientHeight;
        D.clearRect(0, 0, e, t),
            function(e, t) {
                let o = 10;
                const n = 28;
                for (; o * C.scale < n;) o *= 5;
                for (; o * C.scale > 6 * n;) o /= 5;
                const a = o * C.scale;
                D.lineWidth = 1;
                const s = (C.ox % a + a) % a,
                    l = (C.oy % a + a) % a;
                D.strokeStyle = "rgba(255,255,255,0.035)", D.beginPath();
                for (let o = s; o < e; o += a) {
                    const e = H(o);
                    D.moveTo(e, 0), D.lineTo(e, t)
                }
                for (let o = t - l; o > 0; o -= a) {
                    const t = H(o);
                    D.moveTo(0, t), D.lineTo(e, t)
                }
                D.stroke()
            }(e, t),
            function() {
                const e = F(0, 0),
                    t = H(e.x),
                    o = H(e.y);
                D.lineWidth = 1.2, D.strokeStyle = "rgba(255,107,94,0.5)", D.beginPath(), D.moveTo(t, o), D.lineTo(t + 34, o), D.stroke(), D.strokeStyle = "rgba(78,208,122,0.5)", D.beginPath(), D.moveTo(t, o), D.lineTo(t, o - 34), D.stroke(), D.fillStyle = "#e6edf3", D.beginPath(), D.arc(e.x, e.y, 2.5, 0, 2 * Math.PI), D.fill()
            }();
        const o = T();
        o && (function(e) {
            D.strokeStyle = "rgba(180,190,200,0.55)", D.lineWidth = 1.2, D.setLineDash([6, 4]);
            for (const t of e.dxf.entities) t.layer === m && A(t.points, t.closed);
            D.setLineDash([])
        }(o), function(e) {
            for (const t of e.dxf.entities) t.layer !== m && -1 === f.indexOf(t.layer) && !1 !== e.layerVisible[t.layer] && (D.strokeStyle = e.layerColor[t.layer] || "#cccccc", D.lineWidth = 1.4, A(t.points, t.closed))
        }(o), o.doorMode && o.doorMode.enabled && function(e) {
            e.lastDoors || le(e);
            if (!e.lastDoors) return;
            D.lineWidth = 1.3, e.lastDoors.forEach(e => {
                D.strokeStyle = "#f5a623", D.setLineDash([5, 3]), A(e.vLine), D.setLineDash([]), D.strokeStyle = "#34d2c0", A(e.vbitPath), D.strokeStyle = "#ff6b5e", A(e.formtoolPath)
            })
        }(o), l("chkToolpath").checked && function(e) {
            e.lastJob || le(e);
            if (!e.lastJob) return;
            D.lineWidth = 1.1;
            for (const t of e.lastJob.operations)
                if ("drill" === t.kind) {
                    const e = F(t.point.x, t.point.y);
                    D.strokeStyle = "#34d2c0", D.beginPath(), D.arc(e.x, e.y, 4, 0, 2 * Math.PI), D.stroke(), D.beginPath(), D.moveTo(e.x - 6, e.y), D.lineTo(e.x + 6, e.y), D.moveTo(e.x, e.y - 6), D.lineTo(e.x, e.y + 6), D.stroke()
                } else if ("pocket" === t.kind) {
                D.strokeStyle = "rgba(52,210,192,0.55)";
                for (const e of t.rings) A(e)
            } else if (D.strokeStyle = "#34d2c0", D.setLineDash([4, 3]), A(t.path), D.setLineDash([]), t.tabs && t.tabs.length) {
                D.fillStyle = "#ff6b5e";
                for (const e of t.tabs) {
                    const o = (e.start + e.end) / 2,
                        n = V(t.path, o),
                        a = F(n.x, n.y);
                    D.fillRect(a.x - 3, a.y - 3, 6, 6)
                }
            }
        }(o), l("chkStartPoints").checked && function(e) {
            D.fillStyle = "#f5a623";
            for (const t of e.dxf.entities) {
                if (t.layer === m || -1 !== f.indexOf(t.layer)) continue;
                if (!1 === e.layerVisible[t.layer]) continue;
                const o = t.points[0],
                    n = F(o.x, o.y);
                D.beginPath(), D.arc(n.x, n.y, 3, 0, 2 * Math.PI), D.fill()
            }
        }(o))
    }

    function A(e, closed) {
        if (!e || e.length < 2) return;
        D.beginPath();
        const t = F(e[0].x, e[0].y);
        D.moveTo(t.x, t.y);
        for (let t = 1; t < e.length; t++) {
            const o = F(e[t].x, e[t].y);
            D.lineTo(o.x, o.y)
        }
        if (closed) D.closePath();
        D.stroke()
    }

    function V(e, t) {
        let o = 0;
        for (let n = 0; n < e.length - 1; n++) {
            const a = Math.hypot(e[n + 1].x - e[n].x, e[n + 1].y - e[n].y);
            if (o + a >= t) {
                const s = (t - o) / a;
                return {
                    x: e[n].x + s * (e[n + 1].x - e[n].x),
                    y: e[n].y + s * (e[n + 1].y - e[n].y)
                }
            }
            o += a
        }
        return e[e.length - 1]
    }
    window.ResizeObserver && new ResizeObserver(() => O()).observe($.parentElement);
    let B = !1,
        j = null;

    function q() {
        const e = l("layerList"),
            t = T();
        if (!t) return e.innerHTML = '<p class="empty-hint">เปิดไฟล์ DXF เพื่อแสดงรายการ Layer</p>', void R();
        const o = t.dxf.layers.filter(e => e !== m && -1 === f.indexOf(e));
        if (!o.length) return void(e.innerHTML = '<p class="empty-hint">ไม่พบ Layer ในไฟล์นี้</p>');
        e.innerHTML = "";
        const n = {};
        t.dxf.entities.forEach(e => n[e.layer] = (n[e.layer] || 0) + 1), o.forEach(o => {
            const a = document.createElement("div");
            a.className = "layer-row" + (!1 === t.layerVisible[o] ? " hidden" : ""), a.innerHTML = `\n        <span class="layer-swatch" style="background:${t.layerColor[o]}"></span>\n        <span class="layer-name" title="${o}">${o}</span>\n        <span class="layer-count">${n[o]||0}</span>\n        <span class="layer-eye" title="แสดง/ซ่อน">${!1===t.layerVisible[o]?"◌":"◉"}</span>`, a.querySelector(".layer-eye").addEventListener("click", e => {
                e.stopPropagation(), t.layerVisible[o] = !(!1 !== t.layerVisible[o]), q(), P()
            }), a.addEventListener("click", () => {
                ue("mapping"),
                    function(e) {
                        const t = document.querySelector(`.mapping-row[data-layer="${CSS.escape(e)}"]`);
                        t && (t.scrollIntoView({
                            behavior: "smooth",
                            block: "center"
                        }), t.style.outline = "1px solid var(--amber)", setTimeout(() => t.style.outline = "", 1200))
                    }(o)
            }), e.appendChild(a)
        }), R()
    }

    function R() {
        l("legend").innerHTML = '\n      <div class="lg"><span class="dot" style="background:#f5a623"></span> จุดเริ่ม Path</div>\n      <div class="lg"><span class="dot" style="background:#34d2c0"></span> Toolpath</div>\n      <div class="lg"><span class="dot" style="background:#ff6b5e"></span> Tab</div>'
    }

    function X() {
        const e = T(),
            t = !!(e && e.doorMode && e.doorMode.enabled),
            o = l("btnDoorMode");
        o.textContent = t ? "ออกจากโหมดตีบัวหน้าบาน · กลับไปหน้า Layer ปกติ" : "เข้าโหมดตีบัวหน้าบาน", o.classList.toggle("active", t), o.disabled = !e, l("doorModeForm").style.display = t ? "" : "none", l("mappingTableHead").style.display = t ? "none" : "", l("mappingList").style.display = t ? "none" : "", t ? function(e) {
            const t = e.doorMode;
            l("doorOffset").value = t.offset, l("doorDepth").value = t.depth;
            const o = (e, t, o, n) => {
                const a = t.map(e => `<option value="${e}" ${e===o?"selected":""}>T${e} · ${i.tools[e].name}</option>`);
                n && a.unshift(`<option value="" ${o?"":"selected"}>— ไม่ใช้ —</option>`), e.innerHTML = a.length ? a.join("") : '<option value="">— ไม่มีมีดชนิดนี้ใน Tool Library —</option>'
            };
            o(l("doorVbitTool"), J("vbit"), t.vbitTool, !1), o(l("doorFormtoolTool"), J("formtool"), t.formtoolTool, !1), o(l("doorVlineTool"), Y(), t.vlineTool, !0), o(l("doorBorderTool"), Y(), t.borderTool, !0), l("doorVlineDepth").value = t.vlineDepth;
            const n = l("doorBorderDepth");
            n.value = String(t.borderDepth), I(n), t.vbitTool = l("doorVbitTool").value ? Number(l("doorVbitTool").value) : null, t.formtoolTool = l("doorFormtoolTool").value ? Number(l("doorFormtoolTool").value) : null, t.vlineTool = l("doorVlineTool").value ? Number(l("doorVlineTool").value) : null, t.borderTool = l("doorBorderTool").value ? Number(l("doorBorderTool").value) : null
        }(e) : W()
    }

    function J(e) {
        return Object.keys(i.tools).map(Number).sort((e, t) => e - t).filter(t => (i.tools[t].toolType || "endmill") === e)
    }

    function Y() {
        return Object.keys(i.tools).map(Number).sort((e, t) => e - t)
    }

    function I(e) {
        const t = k(e.value, i.machine),
            o = !isFinite(t);
        e.classList.toggle("invalid", o), e.title = o ? "นิพจน์ไม่ถูกต้อง — ใช้ได้แค่ตัวเลข, pt (ความหนาไม้), cd (Cut Deeper) และ + - * / ( )" : `= ${t.toFixed(2)} mm`
    }
    $.addEventListener("mousedown", e => {
        B = !0, j = {
            x: e.offsetX,
            y: e.offsetY,
            ox: C.ox,
            oy: C.oy
        }
    }), window.addEventListener("mouseup", () => {
        B = !1
    }), $.addEventListener("mousemove", e => {
        B && (C.ox = j.ox + (e.offsetX - j.x), C.oy = j.oy - (e.offsetY - j.y), P());
        const t = _(e.offsetX, e.offsetY);
        l("coordReadout").textContent = `X ${t.x.toFixed(2)}　Y ${t.y.toFixed(2)}`
    }), $.addEventListener("wheel", e => {
        e.preventDefault();
        const t = _(e.offsetX, e.offsetY),
            o = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        C.scale *= o, C.ox = e.offsetX - t.x * C.scale, C.oy = $.clientHeight - e.offsetY - t.y * C.scale, P()
    }, {
        passive: !1
    }), l("btnShowAll").addEventListener("click", () => {
        const e = T();
        e && e.dxf.layers.forEach(t => e.layerVisible[t] = !0), q(), P()
    }), l("btnHideAll").addEventListener("click", () => {
        const e = T();
        e && e.dxf.layers.forEach(t => e.layerVisible[t] = !1), q(), P()
    }), l("btnDoorMode").addEventListener("click", () => {
        const e = T();
        e && (e.doorMode.enabled = !e.doorMode.enabled, e.lastJob = null, e.lastDoors = null, X(), P())
    }), l("doorBorderDepth").addEventListener("input", () => I(l("doorBorderDepth"))), ["doorOffset", "doorDepth", "doorVbitTool", "doorFormtoolTool", "doorVlineTool", "doorVlineDepth", "doorBorderTool", "doorBorderDepth"].forEach(e => {
        l(e).addEventListener("change", () => {
            const e = T();
            e && (e.doorMode.offset = parseFloat(l("doorOffset").value) || 0, e.doorMode.depth = parseFloat(l("doorDepth").value) || 0, e.doorMode.vbitTool = l("doorVbitTool").value ? Number(l("doorVbitTool").value) : null, e.doorMode.formtoolTool = l("doorFormtoolTool").value ? Number(l("doorFormtoolTool").value) : null, e.doorMode.vlineTool = l("doorVlineTool").value ? Number(l("doorVlineTool").value) : null, e.doorMode.vlineDepth = parseFloat(l("doorVlineDepth").value) || 0, e.doorMode.borderTool = l("doorBorderTool").value ? Number(l("doorBorderTool").value) : null, e.doorMode.borderDepth = l("doorBorderDepth").value.trim() || "0", e.lastJob = null, e.lastDoors = null, P())
        })
    });
    let z = null,
        G = 1;

    function Z(e, t) {
        const o = v(e);
        switch (t) {
            case "enabled":
                return o.enabled ? 1 : 0;
            case "layer":
                return e.toLowerCase();
            case "operation":
                return (o.operation || "").toLowerCase();
            case "tool":
                return Number(o.toolNumber) || 0;
            case "depth": {
                const e = k(o.depth, i.machine);
                return isFinite(e) ? e : -1 / 0
            }
            case "order":
                return null === o.order || void 0 === o.order ? 1 / 0 : Number(o.order);
            case "tabs":
                return o.tabsEnabled ? 1 : 0;
            default:
                return 0
        }
    }

    function W() {
        const e = l("mappingList"),
            o = function(e) {
                if (!z) return e;
                const t = z,
                    o = G;
                return e.slice().sort((e, n) => {
                    const a = Z(e, t),
                        s = Z(n, t);
                    return a < s ? -1 * o : a > s ? 1 * o : e.localeCompare(n)
                })
            }(function() {
                const e = new Set;
                return r.forEach(t => t.dxf.layers.forEach(t => {
                    t !== m && -1 === f.indexOf(t) && e.add(t)
                })), Array.from(e)
            }());
        if (!o.length) return void(e.innerHTML = '<p class="empty-hint">เปิด DXF แล้วกำหนดงานให้แต่ละ Layer</p>');
        e.innerHTML = "";
        const n = Object.keys(i.tools).map(Number).sort((e, t) => e - t).map(e => `<option value="${e}">T${e} · ${i.tools[e].name}</option>`).join("");
        o.forEach(o => {
            const a = v(o),
                s = document.createElement("div");
            s.className = "mapping-row" + (a.enabled ? "" : " disabled"), s.dataset.layer = o;
            const i = 0 === a.operation.indexOf("Profile"),
                c = o === t.LOCKED_LAST_LAYER;
            s.innerHTML = `\n        <span class="mr-enable"><input type="checkbox" class="m-enabled" ${a.enabled?"checked":""}></span>\n        <span class="mr-name" title="${o}"><span class="layer-swatch" style="background:${function(e){for(const t of r)if(t.layerColor[e])return t.layerColor[e];return"#cccccc"}(o)}"></span>${o}</span>\n        <select class="m-op">${t.OPERATIONS.map(e=>`<option ${e===a.operation?"selected":""}>${e}</option>`).join("")}</select>\n        <select class="m-tool">${n}</select>\n        <input type="text" class="m-depth" placeholder="pt+cd">\n        <input type="number" class="m-order" min="1" step="1" placeholder="${c?"สุดท้าย":"—"}"\n               value="${null===a.order||void 0===a.order?"":a.order}" ${c?'disabled title="เลเยอร์นี้ล็อกให้อยู่ท้ายสุดเสมอ"':""}>\n        <span class="mr-tabs">${i?`<input type="checkbox" class="m-tabs" ${a.tabsEnabled?"checked":""}>`:""}</span>`, s.querySelector(".m-tool").value = a.toolNumber;
            const d = s.querySelector(".m-depth");
            d.value = String(a.depth), U(d);
            const u = () => {
                a.operation = s.querySelector(".m-op").value, a.toolNumber = parseInt(s.querySelector(".m-tool").value, 10), a.depth = s.querySelector(".m-depth").value.trim() || "0", a.enabled = s.querySelector(".m-enabled").checked;
                const e = s.querySelector(".m-order"),
                    t = e ? e.value.trim() : "";
                a.order = "" === t || c ? null : Number(t);
                const o = s.querySelector(".m-tabs");
                a.tabsEnabled = !!o && o.checked, s.classList.toggle("disabled", !a.enabled), K(), W(), l("chkToolpath").checked && P(), b()
            };
            s.querySelectorAll("select, input").forEach(e => e.addEventListener("change", u)), d.addEventListener("input", () => U(d)), e.appendChild(s)
        })
    }

    function U(e) {
        const t = k(e.value, i.machine),
            o = !isFinite(t);
        e.classList.toggle("invalid", o), e.title = o ? "นิพจน์ไม่ถูกต้อง — ใช้ได้แค่ตัวเลข, pt (ความหนาไม้), cd (Cut Deeper) และ + - * / ( )" : `= ${t.toFixed(2)} mm  (pt=ความหนาไม้, cd=Cut Deeper)`
    }

    function K() {
        r.forEach(e => {
            e.lastJob = null, e.gcode = "", e.stats = null
        }), fe()
    }
    document.querySelectorAll(".mh-sort").forEach(e => {
        e.addEventListener("click", () => {
            const t = e.dataset.col;
            z === t ? G *= -1 : (z = t, G = 1), document.querySelectorAll(".mh-sort").forEach(e => e.classList.remove("sort-asc", "sort-desc")), e.classList.add(1 === G ? "sort-asc" : "sort-desc"), W()
        })
    });
    let Q = null;

    function ee() {
        const e = l("toolList");
        e.innerHTML = "";
        const t = Object.keys(i.tools).map(Number).sort((e, t) => e - t);
        null == Q && t.length && (Q = t[0]), t.forEach(t => {
            const o = i.tools[t],
                n = document.createElement("div");
            n.className = "tool-item" + (t === Q ? " selected" : ""), n.innerHTML = `<span class="tool-badge">T${t}</span><span class="ti-name">${o.name}${o.isOutsideTool?" ★":""}</span><span class="ti-dia">Ø${o.diameter}</span><span class="ti-type">${function(e){const t=e.toolType||"endmill";return"vbit"===t?`V-bit ${e.vbitAngle||0}° · Tip Ø${e.vbitTipDiameter||0}`:"formtool"===t?"Formtool":"Endmill"}(o)}</span>`, n.addEventListener("click", () => {
                Q = t, ee(), te()
            }), e.appendChild(n)
        }), te()
    }

    function te() {
        const e = l("toolForm"),
            t = i.tools[Q];
        if (!t) return void(e.innerHTML = "");
        const o = t.toolType || "endmill",
            n = (e, o, n) => `<label class="fld"><span>${o}</span><input type="number" data-k="${e}" step="${n||"any"}" value="${t[e]}"></label>`;
        e.innerHTML = `\n      <div class="tool-form-head">\n        <strong style="font-family:var(--mono)">แก้ไข T${t.number}</strong>\n        <button class="danger" id="btnDelTool">ลบมีด</button>\n      </div>\n      <label class="fld full2"><span>Tool Name</span><input type="text" data-k="name" value="${t.name}"></label>\n      ${n("number","Tool Number","1")}\n      ${n("diameter","Diameter (mm)","0.1")}\n      <label class="fld"><span>ชนิดทูล</span>\n        <select id="selToolType">${[["endmill","Endmill"],["vbit","V-bit"],["formtool","Formtool"]].map(([e,t])=>`<option value="${e}" ${e===o?"selected":""}>${t}</option>`).join("")}</select>\n      </label>\n      <span id="vbitFields" style="display:${"vbit"===o?"contents":"none"}">\n        <label class="fld"><span>องศาดอก (V-bit)</span><input type="number" data-k="vbitAngle" step="1" min="0" max="180" value="${t.vbitAngle||90}"></label>\n        <label class="fld"><span>ขนาดปลายดอก (mm)</span><input type="number" data-k="vbitTipDiameter" step="0.1" min="0" value="${t.vbitTipDiameter||0}"></label>\n      </span>\n      ${n("spindle","Spindle (rpm)","100")}\n      ${n("passDepth","Pass Depth (mm)","0.1")}\n      ${n("feedXY","Feed XY (mm/min)","50")}\n      ${n("feedZ","Feed Z (mm/min)","50")}\n      ${n("safeHeight","Safe Height (mm)","1")}\n      <label class="fld full2 check" style="margin-top:4px">\n        <input type="checkbox" id="chkOutsideTool" ${t.isOutsideTool?"checked":""}>\n        ทูลหลักสำหรับตัดนอก (ใช้เป็น default ของ Profile Outside)\n      </label>`, l("selToolType").addEventListener("change", e => {
            t.toolType = e.target.value, K(), ee(), b()
        }), e.querySelectorAll("input[data-k]").forEach(e => e.addEventListener("change", () => {
            const o = e.dataset.k;
            if ("name" === o) t.name = e.value;
            else if ("number" === o) {
                const o = parseInt(e.value, 10);
                o && o !== t.number && !i.tools[o] && (delete i.tools[t.number], t.number = o, i.tools[o] = t, Q = o)
            } else t[o] = parseFloat(e.value);
            K(), ee(), W(), b()
        })), l("chkOutsideTool").addEventListener("change", e => {
            Object.values(i.tools).forEach(e => e.isOutsideTool = !1), t.isOutsideTool = e.target.checked, K(), ee(), b()
        }), l("btnDelTool").addEventListener("click", () => {
            Object.keys(i.tools).length <= 1 ? alert("ต้องมีมีดอย่างน้อย 1 ดอก") : (delete i.tools[Q], Q = null, K(), ee(), W(), b())
        })
    }

    function oe() {
        const e = l("woodThicknessInput");
        if (!e) return;
        const t = r.find(e => e.id === c);
        e.value = t ? t.woodThickness : i.machine.woodThickness
    }

    function ne(e) {
        // โครงสร้าง 1: [แผ่นที่]-[ด้าน]-[ชื่อสี...]-[ความหนา].dxf
        //   ตัวอย่าง: sheet1-top-Veneer_D02_120cm-19.dxf
        //   เงื่อนไข: ส่วนที่คั่นด้วย - มีอย่างน้อย 3 ส่วน และส่วนท้ายสุดเป็นตัวเลข (ความหนา)
        const stem = e.replace(/\.dxf$/i, "");
        const dashParts = stem.split("-");
        const lastDash = dashParts[dashParts.length - 1];
        if (dashParts.length >= 3 && /^\d+(\.\d+)?$/.test(lastDash)) {
            const hasSide = dashParts.length >= 4;
            const side = hasSide ? dashParts[1] : "";
            const colorStart = hasSide ? 2 : 1;
            const color = dashParts.slice(colorStart, -1).join("-");
            return {
                color: color,
                thickness: parseFloat(lastDash),
                isBottom: /bottom/i.test(side)
            };
        }
        // โครงสร้าง 2: [ชื่อสี...]_[แผ่นที่].dxf  (ไม่มีความหนา)
        //   ตัวอย่าง: WOOD_BOARD_CORK_001.dxf
        //   ชื่อสีคือทุกส่วนยกเว้นส่วนสุดท้ายหลัง _
        const underParts = stem.split("_");
        if (underParts.length >= 2) {
            return {
                color: underParts.slice(0, -1).join("_"),
                thickness: null,
                isBottom: false
            };
        }
        return { color: "", thickness: null, isBottom: false };
    }

    function ae() {
        const e = i.machine,
            t = l("machineForm"),
            o = (t, o, n) => `<label class="fld"><span>${o}</span><input type="number" data-k="${t}" step="${n||"any"}" value="${e[t]}"></label>`;
        t.innerHTML = `\n      <label class="fld"><span>Units</span>\n        <select data-k="units"><option value="mm" ${"mm"===e.units?"selected":""}>mm</option><option value="inch" ${"inch"===e.units?"selected":""}>inch</option></select></label>\n      ${o("safeZ","Safe Z (mm)","1")}\n      ${o("rapidClearance","Rapid Clearance (mm)","0.5")}\n      ${o("pocketStepover","Pocket Stepover (%)","5")}\n      ${o("cutDeeper","Cut Deeper (mm)","0.1")}\n      <label class="fld"><span>จุดอ้างอิง X0Y0 (มุมของ _ABF_SHEET_BORDER)</span>\n        <select data-k="originCorner">\n          <option value="bottom-left">มุมล่างซ้าย</option>\n          <option value="bottom-right">มุมล่างขวา</option>\n          <option value="top-left">มุมบนซ้าย</option>\n          <option value="top-right">มุมบนขวา</option>\n        </select></label>\n      <label class="fld"><span>จุดอ้างอิง Z0</span>\n        <select data-k="z0Mode"><option value="top">ผิวบนของไม้</option><option value="table">พื้น Top โต๊ะตัด (สเปกบอร์ด)</option></select></label>\n      ${o("tabWidth","Tab Width (mm)","0.5")}\n      ${o("tabHeight","Tab Height (mm)","0.5")}\n      ${o("tabCount","Tab Count","1")}\n      <hr class="form-divider">\n      ${o("smallPartThreshold","ชิ้นงานขนาดเล็ก (mm)","1")}\n      <small class="hint" style="grid-column:1/-1">ด้านแคบที่สุดของ bounding box ที่ถือว่า "เล็ก" (0 = ปิด) — ใช้กับ layer ที่ขึ้นต้นด้วย cut_outside_</small>\n      ${o("smallPartFinalPass","ความหนาตัดรอบสุดท้าย (mm)","0.5")}\n      <small class="hint" style="grid-column:1/-1">รอบพิเศษก่อนตัดขาด สำหรับชิ้นเล็กเท่านั้น (0 = ไม่เพิ่มรอบพิเศษ)</small>\n      ${o("smallPartFinalFeed","ความเร็วตัดรอบสุดท้าย (mm/min)","10")}\n      <small class="hint" style="grid-column:1/-1">feed rate เฉพาะ pass สุดท้ายของชิ้นเล็ก (0 = ใช้ค่าเดิมของดอก)</small>`, t.querySelector('[data-k="originCorner"]').value = e.originCorner, t.querySelector('[data-k="z0Mode"]').value = e.z0Mode, t.querySelectorAll("input, select").forEach(t => t.addEventListener("change", () => {
            const o = t.dataset.k;
            e[o] = "SELECT" === t.tagName ? t.value : parseFloat(t.value), K(), "originCorner" === o && r.length && he(["เปลี่ยนจุดอ้างอิง X0Y0 แล้ว — กรุณาเปิดไฟล์ DXF ที่เปิดอยู่ใหม่อีกครั้งเพื่อคำนวณตำแหน่งใหม่"]), b()
        }))
    }

    function se() {
        const e = l("taToolChange"),
            t = l("taHeader"),
            o = l("taFooter");
        e && (e.value = i.toolChange), t && (t.value = i.header), o && (o.value = i.footer)
    }

    function le(e) {
        const t = Object.assign({}, i.machine, {
                woodThickness: e.woodThickness || i.machine.woodThickness
            }),
            n = e => {
                const o = Math.abs(parseFloat(e) || 0);
                return "table" === t.z0Mode ? (t.woodThickness || 0) - o : -o
            };
        if (e.doorMode && e.doorMode.enabled) {
            const a = e.doorMode,
                s = k(a.borderDepth, t),
                l = Object.assign({}, a, {
                    borderDepth: isFinite(s) ? s : 0
                }),
                r = o.generateDoorProfile(e.dxf, l, i.tools, t, n);
            e.lastJob = {
                operations: r.operations,
                warnings: r.warnings
            }, e.lastDoors = r.doors
        } else e.lastJob = o.generate(e.dxf, function(e) {
            const mappings = {};
            return e.dxf.layers.forEach(o => {
                if (o === m || -1 !== f.indexOf(o)) return;
                const n = v(o),
                    a = k(n.depth, t),
                    s = Object.assign({}, n, {
                        depth: isFinite(a) ? a : 0
                    });
                e.isBottom && /^cut_outside_/i.test(o) && (s.enabled = !1), !e.isBottom && /^mark_square/i.test(o) && (s.enabled = !1), mappings[o] = s
            }), mappings
        }(e), i.tools, t, n), e.lastDoors = null;
        return e.lastJob
    }
    async function ie() {
        try {
            const {
                data: e,
                error: t
            } = await s.sb.from("profiles").select("status, expires_at").eq("id", (await s.getUser()).id).single();
            return t || !e ? {
                ok: !1,
                reason: "network"
            } : "pending" === e.status ? {
                ok: !1,
                reason: "pending"
            } : "suspended" === e.status ? {
                ok: !1,
                reason: "suspended"
            } : e.expires_at && new Date(e.expires_at) < new Date ? {
                ok: !1,
                reason: "expired"
            } : "active" !== e.status ? {
                ok: !1,
                reason: "suspended"
            } : {
                ok: !0
            }
        } catch (e) {
            return {
                ok: !1,
                reason: "network"
            }
        }
    }
    l("btnAddTool").addEventListener("click", () => {
        const e = Object.keys(i.tools).map(Number),
            o = (e.length ? Math.max(...e) : 0) + 1;
        i.tools[o] = t.makeTool(o, {
            name: `Tool ${o}`
        }), Q = o, ee(), W(), b()
    });
    const re = {
        pending: "บัญชีของคุณยังรอการอนุมัติจากแอดมิน",
        suspended: "สิทธิ์การใช้งานของคุณถูกระงับ กรุณาติดต่อแอดมิน",
        expired: "สิทธิ์การใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อแอดมิน",
        network: "ไม่สามารถตรวจสอบสิทธิ์ได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ต"
    };

    function ce() {
        const e = l("outputFileSelect");
        e.innerHTML = r.map(e => `<option value="${e.id}">${e.fileName}</option>`).join(""), e.onchange = () => de(e.value);
        const t = e.value || r[0] && r[0].id;
        t && de(t)
    }

    function de(e) {
        const t = r.find(t => t.id === e),
            o = t ? t.gcode : "";
        l("gcodeOut").value = o, o || (l("gStats").innerHTML = "ยังไม่ได้สร้าง G-code")
    }

    function ue(e) {
        document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === e)), document.querySelectorAll(".tab-pane").forEach(t => t.classList.toggle("active", t.dataset.pane === e)), "mapping" === e && X()
    }

    function pe() {
        return !!S && (he(["กรุณาออกจากหน้าพรีวิว 3 มิติก่อน (กดปุ่ม 3D อีกครั้ง) จึงจะใช้งานปุ่มนี้ได้"]), !0)
    }

    function fe() {
        if (!S) return;
        const e = T();
        e && window.Simulate3D && (e.lastJob || le(e), window.Simulate3D.loadJob(e, i.machine))
    }

    function me(e) {
        const t = $.clientWidth / 2,
            o = $.clientHeight / 2,
            n = _(t, o);
        C.scale *= e, C.ox = t - n.x * C.scale, C.oy = $.clientHeight - o - n.y * C.scale, P()
    }

    function he(e, t) {
        l("warnArea").innerHTML = e.map(e => `<div class="${t?"ok":""}">${t?"✓ ":"⚠ "}${e}</div>`).join("")
    }
    l("btnGenerate").addEventListener("click", async () => {
        if (!r.length) return void he(["ยังไม่ได้เปิดไฟล์ DXF"]);
        const e = l("btnGenerate"),
            t = l("btnExportZip"),
            o = e.textContent;
        e.textContent = "กำลังสร้าง G-code...", e.disabled = !0, t && (t.disabled = !0);
        try {
            const e = 3e3 + 1e3 * Math.random(),
                [, t] = await Promise.all([(async () => {
                    for (const e of r) {
                        le(e);
                        const t = n.generate(e.lastJob, {
                            machine: Object.assign({}, i.machine, { woodThickness: e.woodThickness || i.machine.woodThickness }),
                            header: i.header,
                            footer: i.footer,
                            toolChange: i.toolChange
                        });
                        e.gcode = t.gcode, e.stats = t.stats
                    }
                })(), ie(), (a = e, new Promise(e => setTimeout(e, a)))]);
            if (!t.ok) {
                return he([re[t.reason] || re.network]), void await s.logout()
            }
            const o = [];
            let c = 0,
                d = 0,
                u = 0,
                p = 0,
                f = 0;
            for (const e of r) {
                o.push(...e.lastJob.warnings.map(t => `[${e.fileName}] ${t}`));
                const t = e.stats;
                c += t.lineCount, d += t.toolChanges, u += t.cutMM, p += t.rapidMM, f += t.estMinutes
            }
            he(o.length ? o : [`สร้าง G-code สำเร็จ ${r.length} ไฟล์`], 0 === o.length), l("gStats").innerHTML = `รวม ${r.length} ไฟล์ · บรรทัด: <b>${c}</b>　เปลี่ยนมีด: <b>${d}</b><br>ระยะกัด: <b>${u.toFixed(0)}</b> mm　ระยะเร็ว: <b>${p.toFixed(0)}</b> mm<br>เวลาโดยประมาณรวม: <b>${f.toFixed(1)}</b> นาที`, ce(), r.length && (l("outputFileSelect").value = r[0].id, de(r[0].id)), l("chkToolpath").checked = !0, P(), ue("output")
        } finally {
            e.textContent = o, e.disabled = !1, t && (t.disabled = !1)
        }
        var a
    }), l("btnExportZip").addEventListener("click", async () => {
        const e = r.filter(e => e.gcode);
        if (!e.length) return void he(['ยังไม่มี G-code ให้ Export — กด "สร้าง G-code ทุกไฟล์" ก่อน']);
        const t = "Gcode_output",
            o = window.prompt("ชื่อไฟล์ ZIP (ไม่ต้องใส่นามสกุล)", t);
        if (null === o) return;
        const n = (o.trim() || t).replace(/[/\\:*?"<>|]/g, "_"),
            s = e.map(e => {
                const t = e.fileName.replace(/\.dxf$/i, "") + ".nc",
                    o = (e.woodColor || "").replace(/[/\\:*?"<>|]/g, "_"),
                    n = (e.woodThickness || i.machine.woodThickness || "") + "mm";
                return {
                    name: `${o?`${o}_${n}`:"_ungrouped"}/${t}`,
                    content: e.gcode
                }
            });
        try {
            await a.downloadZip(n + ".zip", s)
        } catch (e) {
            he(["สร้างไฟล์ zip ไม่สำเร็จ: " + e.message])
        }
    }), l("btnSave").addEventListener("click", y), document.querySelectorAll(".tab").forEach(e => e.addEventListener("click", () => ue(e.dataset.tab))), l("btnZoomIn").addEventListener("click", () => me(1.2)), l("btnZoomOut").addEventListener("click", () => me(1 / 1.2)), l("btnFit").addEventListener("click", () => {
        pe() || N()
    }), l("btnView3D").addEventListener("click", function() {
        const e = T();
        if (!e) return void he(["ยังไม่ได้เปิดไฟล์ DXF"]);
        if (S = !S, l("btnView3D").classList.toggle("active", S), S) {
            if ($.parentElement.style.display = "none", M.style.display = "", !window.Simulate3D) return void he(["โหลด Three.js ไม่สำเร็จ — ตรวจการเชื่อมต่ออินเทอร์เน็ต"]);
            window.Simulate3D.init(M), e.lastJob || le(e), window.Simulate3D.loadJob(e, i.machine)
        } else M.style.display = "none", $.parentElement.style.display = "", O()
    }), l("chkStartPoints").addEventListener("change", P), l("chkToolpath").addEventListener("change", () => {
        const e = T();
        e && l("chkToolpath").checked && le(e), P()
    }), async function() {
        const e = await s.requireLogin();
        if (!e) return;
        let o;
        u = e.id;
        try {
            if (o = await s.getMyProfile(), !o) throw new Error("no-profile")
        } catch (e) {
            return void(l("accessMsg").textContent = "ตรวจสอบสิทธิ์ไม่สำเร็จ (เครือข่ายมีปัญหา) — ลองโหลดหน้าใหม่อีกครั้ง")
        }
        if (!("admin" === o.role || "active" === o.status && (!o.expires_at || new Date(o.expires_at).getTime() >= Date.now()))) {
            const e = {
                    pending: "บัญชีของคุณรออนุมัติจากแอดมิน กรุณาติดต่อแอดมินเพื่อเปิดสิทธิ์ใช้งาน",
                    suspended: "บัญชีของคุณถูกระงับการใช้งาน กรุณาติดต่อแอดมิน"
                },
                t = "suspended" === o.status ? "suspended" : o.expires_at && new Date(o.expires_at).getTime() < Date.now() ? "expired" : "pending";
            return l("accessMsg").textContent = "expired" === t ? "สิทธิ์การใช้งานของคุณหมดอายุแล้ว กรุณาติดต่อแอดมินเพื่อต่ออายุ" : e[t] || "ไม่สามารถเข้าใช้งานได้ในขณะนี้", l("btnGateLogout").style.display = "", void l("btnGateLogout").addEventListener("click", () => s.logout())
        }(async function() {
            let e = {
                city: "ไม่ทราบ",
                country: "ไม่ทราบ",
                countryCode: "",
                ip: "unknown"
            };
            try {
                const t = await fetch("https://ipapi.co/json/"),
                    o = await t.json();
                e = {
                    city: o.city || "ไม่ทราบ",
                    country: o.country_name || "ไม่ทราบ",
                    countryCode: o.country_code || "",
                    ip: o.ip || "unknown"
                }
            } catch (e) {}
            const t = s.sb;
            let o = !1;
            try {
                const {
                    data: n
                } = await t.from("login_logs").select("*").eq("user_id", u).order("created_at", {
                    ascending: !1
                }).limit(1).single();
                if (n) {
                    const t = Date.now() - new Date(n.created_at).getTime(),
                        a = n.city !== e.city || n.country_code !== e.countryCode;
                    t <= 108e5 && a && (o = !0)
                }
            } catch (e) {}
            await t.from("login_logs").insert({
                user_id: u,
                ip: e.ip,
                city: e.city,
                country: e.country,
                country_code: e.countryCode,
                user_agent: navigator.userAgent,
                flagged: o
            })
        })().catch(() => {});
        try {
            const {
                data: o
            } = await s.sb.from("user_settings").select("*").eq("user_id", e.id).single();
            o && function(e) {
                if (e.machine) {
                    const o = t.defaultMachine(),
                        n = e.machine,
                        a = Object.assign({}, o);
                    Object.keys(n).forEach(e => {
                        void 0 !== n[e] && (a[e] = n[e])
                    }), i.machine = a
                }
                e.tools && Object.keys(e.tools).length && (i.tools = e.tools);
                e.saved_mappings && (i.savedMappings = e.saved_mappings);
                e.tool_change && (i.toolChange = e.tool_change);
                e.header && (i.header = e.header);
                e.footer && (i.footer = e.footer)
            }(o)
        } catch (e) {}
        l("accessGate").style.display = "none", l("appRoot").style.display = "", l("userEmail").textContent = e.email, l("btnLogout").addEventListener("click", () => s.logout()), l("btnBackupSettings").addEventListener("click", () => {
                const e = JSON.stringify({
                        machine: i.machine,
                        tools: i.tools,
                        savedMappings: i.savedMappings,
                        toolChange: i.toolChange,
                        header: i.header,
                        footer: i.footer,
                        version: i.version
                    }, null, 2),
                    t = (new Date).toISOString().slice(0, 16).replace("T", "_").replace(":", "-");
                a.downloadText(`cnc-settings-${t}.json`, e, "application/json")
            }), l("restoreInput").addEventListener("change", async e => {
                const o = e.target.files && e.target.files[0];
                if (o) {
                    try {
                        const e = await a.readFileAsText(o),
                            n = JSON.parse(e);
                        if (!n.machine || !n.tools) throw new Error("ไฟล์ไม่ถูกต้อง");
                        i.machine = Object.assign(t.defaultMachine(), n.machine), i.tools = n.tools, i.savedMappings = n.savedMappings || {}, i.toolChange = n.toolChange || t.defaultToolChange, i.header = n.header || t.defaultHeader("mm"), i.footer = n.footer || t.defaultFooter, K(), ae(), ee(), W(), se(), y(), he(["โหลดการตั้งค่าจากไฟล์สำเร็จ"], !0)
                    } catch (e) {
                        he([`โหลดไฟล์ไม่สำเร็จ: ${e.message}`])
                    }
                    e.target.value = ""
                }
            }), l("btnResetSettings").addEventListener("click", () => {
                if (!confirm("คืนค่าการตั้งค่าทั้งหมดกลับเป็นค่าเริ่มต้น?\n\nการดำเนินการนี้ไม่สามารถยกเลิกได้")) return;
                const e = t.defaultState();
                i.machine = e.machine, i.tools = e.tools, i.savedMappings = {}, i.toolChange = e.toolChange, i.header = e.header, i.footer = e.footer, K(), ae(), ee(), W(), se(), y(), he(["คืนค่าการตั้งค่าเป็นค่าเริ่มต้นแล้ว"], !0)
            }), ee(), l("selCutDirection").value = i.machine.cutDirection || "climb", l("selCutDirection").addEventListener("change", e => {
                i.machine.cutDirection = e.target.value, K(), b()
            }), ae(),
            function() {
                const e = l("woodThicknessInput");
                e.addEventListener("change", () => {
                    const t = parseFloat(e.value) || 0,
                        o = r.find(e => e.id === c);
                    o && (o.woodThickness = t), i.machine.woodThickness = t, K(), W(), l("chkToolpath").checked && P(), b()
                })
            }(), X(), l("taToolChange").value = i.toolChange, l("taHeader").value = i.header, l("taFooter").value = i.footer, l("taToolChange").addEventListener("input", () => {
                i.toolChange = l("taToolChange").value, b()
            }), l("taHeader").addEventListener("input", () => {
                i.header = l("taHeader").value, b()
            }), l("taFooter").addEventListener("input", () => {
                i.footer = l("taFooter").value, b()
            }), R(), O(), N(), ce(),
            function() {
                let e = 0;
                const t = l("dropOverlay");
                document.addEventListener("dragenter", o => {
                    o.dataTransfer.types.includes("Files") && (e++, 1 === e && (t.hidden = !1))
                }), document.addEventListener("dragleave", () => {
                    e = Math.max(0, e - 1), 0 === e && (t.hidden = !0)
                }), document.addEventListener("dragover", e => {
                    e.dataTransfer.types.includes("Files") && (e.preventDefault(), e.dataTransfer.dropEffect = "copy")
                }), document.addEventListener("drop", async o => {
                    if (o.preventDefault(), e = 0, t.hidden = !0, pe()) return;
                    const n = Array.from(o.dataTransfer.items || []),
                        a = [];
                    async function s(e) {
                        e.isFile ? await new Promise(t => e.file(e => {
                            /\.dxf$/i.test(e.name) ? a.push(e) : /\.zip$/i.test(e.name) && a.push({
                                _zip: !0,
                                file: e
                            }), t()
                        })) : e.isDirectory && await new Promise(t => {
                            e.createReader().readEntries(async e => {
                                for (const t of e) await s(t);
                                t()
                            })
                        })
                    }
                    for (const e of n) {
                        if ("file" !== e.kind) continue;
                        const t = e.webkitGetAsEntry ? e.webkitGetAsEntry() : null;
                        if (t) await s(t);
                        else {
                            const t = e.getAsFile();
                            t && /\.dxf$/i.test(t.name) ? a.push(t) : t && /\.zip$/i.test(t.name) && a.push({
                                _zip: !0,
                                file: t
                            })
                        }
                    }
                    await L(a)
                })
            }(), window.addEventListener("resize", O)
    }()
}();
