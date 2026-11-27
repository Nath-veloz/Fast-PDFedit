import { state, els, normalizeFieldValueForCompare } from "./state.js";
import { renderPdfPage } from "./api.js";
import { scheduleAutosave, saveProgress } from "./draft.js";
import { scheduleEvaluate, evaluateWithEngine } from "./engine-sync.js";
import { recordFieldChange } from "./main.js";

function getStageElements(pageNum) {
  const container = els.pagesContainer || document.getElementById("pagesContainer");
  const stage = container?.querySelector(`[data-page-num="${pageNum}"]`);
  if (!stage) return null;

  const divs = stage.querySelectorAll("div");
  return {
    stage,
    pageImage: stage.querySelector("img"),
    widgetsLayer: divs[0] || null,
    drawCanvas: stage.querySelector("canvas"),
    freeTextsLayer: divs[1] || null,
  };
}

export function getTargetRenderDpi() {
  return state.zoom > 1.25 ? 190 : 115;
}

export function revokeAllPageUrls() {
  for (const url of Object.values(state.pageUrls || {})) {
    if (url) URL.revokeObjectURL(url);
  }
  state.pageUrls = {};
  state.pageRenderMeta = {};
}

export async function loadAndRenderPage(pageNum = state.currentPage, { force = false } = {}) {
  if (!state.fileId) return;
  const target = getStageElements(pageNum);
  if (!target?.pageImage) return;

  const dpi = getTargetRenderDpi();
  state.pageRenderMeta = state.pageRenderMeta || {};
  const prevMeta = state.pageRenderMeta[pageNum];

  if (!force && prevMeta && prevMeta.fileId === state.fileId && prevMeta.dpi === dpi && state.pageUrls[pageNum]) {
    if (target.pageImage.src !== state.pageUrls[pageNum]) {
      target.pageImage.src = state.pageUrls[pageNum];
    }
    applyStageLayout(pageNum);
    return;
  }

  const blob = await renderPdfPage(state.fileId, pageNum, dpi);
  if (!blob || !state.fileId) return;

  const nextUrl = URL.createObjectURL(blob);
  const prevUrl = state.pageUrls[pageNum];
  state.pageUrls[pageNum] = nextUrl;
  state.pageRenderMeta[pageNum] = { fileId: state.fileId, dpi };

  target.pageImage.onload = () => {
    applyStageLayout(pageNum);
    if (prevUrl && prevUrl !== nextUrl) {
      URL.revokeObjectURL(prevUrl);
    }
  };
  target.pageImage.src = nextUrl;
}

export async function loadAndRenderAllPages(options = {}) {
  if (!state.fileId) return;
  const concurrency = 3;
  let nextPage = 1;
  const workerCount = Math.min(concurrency, state.totalPages);

  async function worker() {
    while (nextPage <= state.totalPages) {
      const p = nextPage++;
      await loadAndRenderPage(p, options);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
}

export function applyStageLayout(pageNum = state.currentPage) {
  const target = getStageElements(pageNum);
  if (!target?.stage || !target.pageImage || !target.drawCanvas) return;

  const pageObj = state.pages.find((p) => p.page === pageNum);
  const baseWidth = pageObj?.width || 595;
  const baseHeight = pageObj?.height || 842;

  const renderedW = Math.round(baseWidth * state.zoom);
  const renderedH = Math.round(baseHeight * state.zoom);

  target.stage.style.width = `${renderedW}px`;
  target.stage.style.height = `${renderedH}px`;
  target.pageImage.style.width = `${renderedW}px`;
  target.pageImage.style.height = `${renderedH}px`;

  target.drawCanvas.width = renderedW;
  target.drawCanvas.height = renderedH;

  renderWidgetsOverlay(pageNum, renderedW, renderedH, pageObj?.fields || []);
  renderFreeTextsOverlay(pageNum);
  redrawStrokesCanvas(pageNum);
}

function isFieldInteractive(f, width, height) {
  if (!f) return false;
  if (f.hidden || f.read_only) return false;
  if (width < 2 || height < 2) return false;
  return true;
}

function positionWidgetElement(el, f, left, top, width, height) {
  if (f.type === "CheckBox") {
    const boxSize = Math.min(20, Math.max(12, Math.min(width, height)));
    el.style.left = `${left + Math.max(0, (width - boxSize) / 2)}px`;
    el.style.top = `${top + Math.max(0, (height - boxSize) / 2)}px`;
    el.style.width = `${boxSize}px`;
    el.style.height = `${boxSize}px`;
    el.checked = Boolean(state.fieldValues[f.id]);
    return;
  }

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${Math.max(10, width)}px`;
  el.style.height = `${Math.max(10, height)}px`;
  el.style.lineHeight = `${Math.max(10, height - 2)}px`;
  el.style.fontSize = `${Math.max(8, Math.min(13.5, height * 0.62))}px`;
  el.style.textAlign = width <= 45 ? "center" : "left";

  const isFocused = document.activeElement === el;
  if (!isFocused) {
    const nextVal = String(state.fieldValues[f.id] ?? "");
    if (el.value !== nextVal) {
      el.value = nextVal;
    }
    el.style.color = "transparent";
  } else {
    el.style.color = "#0f172a";
  }
}

function renderWidgetsOverlay(pageNum, w, h, fields) {
  const target = getStageElements(pageNum);
  if (!target?.widgetsLayer) return;

  target.widgetsLayer.classList.toggle("show-field-hints", Boolean(state.showFieldHints));

  const existingById = new Map();
  for (const child of target.widgetsLayer.querySelectorAll("[data-field-id]")) {
    existingById.set(child.dataset.fieldId, child);
  }

  const activeEl = document.activeElement;
  const activeFieldId =
    activeEl && target.widgetsLayer.contains(activeEl) ? activeEl.dataset.fieldId : null;

  const nextFragment = document.createDocumentFragment();
  const seenIds = new Set();

  for (const f of fields) {
    const [x0, y0, x1, y1] = f.rect || [0, 0, 0, 0];
    const left = Math.round(x0 * w);
    const top = Math.round(y0 * h);
    const width = Math.round((x1 - x0) * w);
    const height = Math.round((y1 - y0) * h);

    if (!isFieldInteractive(f, width, height)) {
      continue;
    }

    seenIds.add(f.id);
    const existing = existingById.get(f.id);

    if (f.type === "CheckBox") {
      const cb = existing && existing.type === "checkbox" ? existing : document.createElement("input");
      if (!existing || existing.type !== "checkbox") {
        cb.type = "checkbox";
        cb.className = "pdf-widget-checkbox";
        cb.dataset.fieldId = f.id;
        cb.addEventListener("change", () => {
          const prevVal = normalizeFieldValueForCompare(f.type, state.fieldValues[f.id]);
          const nextVal = normalizeFieldValueForCompare(f.type, cb.checked);
          state.fieldValues[f.id] = nextVal;
          recordFieldChange(f.id, prevVal, nextVal);
          saveProgress(false);
          scheduleEvaluate({ delayMs: 40, rerenderPage: true }, () =>
            loadAndRenderAllPages({ force: true })
          );
        });
      }
      positionWidgetElement(cb, f, left, top, width, height);
      nextFragment.appendChild(cb);
    } else {
      const inp =
        existing && existing.type === "text" ? existing : document.createElement("input");
      if (!existing || existing.type !== "text") {
        inp.type = "text";
        inp.className = "pdf-widget-input";
        inp.dataset.fieldId = f.id;
        inp.value = String(state.fieldValues[f.id] ?? "");
        inp.title = f.label || f.name;
        inp.style.color = "transparent";

        let focusStartVal = normalizeFieldValueForCompare(f.type, state.fieldValues[f.id]);
        let submittingEnter = false;

        inp.addEventListener("focus", () => {
          focusStartVal = normalizeFieldValueForCompare(f.type, state.fieldValues[f.id]);
          inp.style.color = "#0f172a";
        });

        inp.addEventListener("input", () => {
          state.fieldValues[f.id] = normalizeFieldValueForCompare(f.type, inp.value);
          scheduleAutosave();
          scheduleEvaluate({ delayMs: 220, rerenderPage: false });
        });

        inp.addEventListener("blur", () => {
          const nextVal = normalizeFieldValueForCompare(f.type, inp.value);
          state.fieldValues[f.id] = nextVal;
          recordFieldChange(f.id, focusStartVal, nextVal);
          focusStartVal = nextVal;
          inp.style.color = "transparent";
          saveProgress(false);

          if (submittingEnter) {
            submittingEnter = false;
            return;
          }

          scheduleEvaluate({ delayMs: 0, rerenderPage: true }, () =>
            loadAndRenderAllPages({ force: true })
          );
        });

        // Suporte a Enter e Escape nos campos de formulário
        inp.addEventListener("keydown", async (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            clearTimeout(state.evalTimer);
            state.evalTimer = null;
            clearTimeout(state.autosaveTimer);
            state.autosaveTimer = null;

            const nextVal = normalizeFieldValueForCompare(f.type, inp.value);
            state.fieldValues[f.id] = nextVal;
            recordFieldChange(f.id, focusStartVal, nextVal);
            focusStartVal = nextVal;
            saveProgress(false);

            submittingEnter = true;
            inp.blur();

            await evaluateWithEngine(
              { rerenderPage: true, onlyDirty: false },
              () => loadAndRenderAllPages({ force: true })
            );
            saveProgress(false);
          } else if (e.key === "Escape") {
            e.preventDefault();
            inp.blur();
          }
        });
      } else {
        inp.title = f.label || f.name;
      }

      positionWidgetElement(inp, f, left, top, width, height);
      nextFragment.appendChild(inp);
    }
  }

  for (const [fid, el] of existingById.entries()) {
    if (!seenIds.has(fid) && fid !== activeFieldId) {
      el.remove();
    }
  }

  target.widgetsLayer.replaceChildren(nextFragment);
}

function getClientPoint(e) {
  if (e.touches && e.touches.length > 0) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  if (e.changedTouches && e.changedTouches.length > 0) {
    return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

function getStrokeBoundsNorm(stroke) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of stroke.points || []) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return null;
  const pad = 0.012;
  return {
    x0: Math.max(0, minX - pad),
    y0: Math.max(0, minY - pad),
    x1: Math.min(1, maxX + pad),
    y1: Math.min(1, maxY + pad),
  };
}

export function hitTestStroke(pageNum, xNorm, yNorm, w, h, tolPx = 10) {
  const px = xNorm * w;
  const py = yNorm * h;
  const pageStrokes = (state.strokes || []).filter((s) => s.page === pageNum);

  for (let i = pageStrokes.length - 1; i >= 0; i--) {
    const stk = pageStrokes[i];
    const pts = stk.points || [];
    if (!pts.length) continue;

    for (let j = 0; j < pts.length; j++) {
      const ax = pts[j].x * w;
      const ay = pts[j].y * h;
      if (Math.hypot(px - ax, py - ay) <= tolPx) {
        return stk;
      }
      if (j > 0) {
        const bx = pts[j - 1].x * w;
        const by = pts[j - 1].y * h;
        const dx = ax - bx;
        const dy = ay - by;
        const lenSq = dx * dx + dy * dy;
        const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - bx) * dx + (py - by) * dy) / lenSq)) : 0;
        const projX = bx + t * dx;
        const projY = by + t * dy;
        if (Math.hypot(px - projX, py - projY) <= tolPx) {
          return stk;
        }
      }
    }
  }
  return null;
}

export function renderFreeTextsOverlay(pageNum = state.currentPage) {
  const target = getStageElements(pageNum);
  if (!target?.freeTextsLayer) return;

  target.freeTextsLayer.innerHTML = "";
  const items = (state.freeTexts || []).filter((t) => t.page === pageNum);

  for (const t of items) {
    const isSelected =
      state.selectedOverlay?.kind === "text" && state.selectedOverlay?.id === t.id;

    const el = document.createElement("div");
    el.dataset.textId = t.id;
    el.style.position = "absolute";
    el.style.left = `${t.x * 100}%`;
    el.style.top = `${t.y * 100}%`;
    el.style.fontSize = `${Math.max(9, t.font_size * state.zoom)}px`;
    el.style.pointerEvents = state.tool === "draw" ? "none" : "auto";
    el.style.touchAction = "none";
    el.style.cursor = isSelected ? "grabbing" : "grab";
    el.className = `text-blue-900 font-medium whitespace-nowrap leading-none select-none ${
      isSelected
        ? "ring-1 ring-violet-500 bg-violet-500/10 rounded px-1 py-0.5 z-20"
        : "hover:ring-1 hover:ring-violet-400/60 rounded px-0.5"
    }`;
    el.textContent = t.text;

    if (isSelected) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.textContent = "×";
      delBtn.title = "Apagar texto";
      delBtn.style.position = "absolute";
      delBtn.style.top = "-10px";
      delBtn.style.right = "-10px";
      delBtn.style.width = "18px";
      delBtn.style.height = "18px";
      delBtn.style.lineHeight = "16px";
      delBtn.className =
        "rounded-full bg-rose-600 hover:bg-rose-500 text-white text-[11px] font-bold flex items-center justify-center shadow pointer-events-auto";

      const triggerDelete = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("fastpdf:delete-overlay", {
            detail: { kind: "text", id: t.id, page: pageNum },
          })
        );
      };
      delBtn.addEventListener("mousedown", triggerDelete);
      delBtn.addEventListener("touchstart", triggerDelete, { passive: false });
      el.appendChild(delBtn);
    }

    const startDragText = (ev) => {
      if (state.tool === "draw") return;
      if (ev.target && ev.target.closest && ev.target.closest("button")) return;
      ev.preventDefault();
      ev.stopPropagation();

      state.selectedOverlay = { kind: "text", id: t.id };
      renderFreeTextsOverlay(pageNum);
      redrawStrokesCanvas(pageNum);

      const stageRect = target.stage.getBoundingClientRect();
      if (!stageRect.width || !stageRect.height) return;

      const startPt = getClientPoint(ev);
      const origX = t.x;
      const origY = t.y;
      let moved = false;

      const onMove = (moveEv) => {
        const curPt = getClientPoint(moveEv);
        const dxNorm = (curPt.x - startPt.x) / stageRect.width;
        const dyNorm = (curPt.y - startPt.y) / stageRect.height;
        if (Math.abs(dxNorm) > 0.002 || Math.abs(dyNorm) > 0.002) {
          moved = true;
          if (moveEv.cancelable) moveEv.preventDefault();
        }
        t.x = Math.max(0, Math.min(0.96, origX + dxNorm));
        t.y = Math.max(0, Math.min(0.96, origY + dyNorm));
        renderFreeTextsOverlay(pageNum);
      };

      const onEnd = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onEnd);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onEnd);

        if (moved && (t.x !== origX || t.y !== origY)) {
          window.dispatchEvent(
            new CustomEvent("fastpdf:move-overlay", {
              detail: {
                kind: "text",
                id: t.id,
                page: pageNum,
                prevPos: { x: origX, y: origY },
                nextPos: { x: t.x, y: t.y },
              },
            })
          );
          scheduleAutosave();
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onEnd);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onEnd);
    };

    el.addEventListener("mousedown", startDragText);
    el.addEventListener("touchstart", startDragText, { passive: false });

    target.freeTextsLayer.appendChild(el);
  }
}

export function getStrokeDeleteBadgeHit(stroke, w, h) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  for (const p of stroke.points || []) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
  }
  if (!Number.isFinite(minX)) return null;
  const pad = 0.012;
  const bx = Math.max(0, minX - pad) * w;
  const by = Math.max(0, minY - pad) * h;
  const bw = Math.max(12, (Math.min(1, maxX + pad) - Math.max(0, minX - pad)) * w);
  const badgeR = 13;
  return {
    cx: Math.min(w - badgeR - 2, bx + bw),
    cy: Math.max(badgeR + 2, by),
    badgeR,
    hitR: 22,
  };
}

export function redrawStrokesCanvas(pageNum = state.currentPage) {
  const target = getStageElements(pageNum);
  if (!target?.drawCanvas) return;

  const ctx = target.drawCanvas.getContext("2d");
  const w = target.drawCanvas.width;
  const h = target.drawCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const pageStrokes = (state.strokes || []).filter((s) => s.page === pageNum);
  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = Math.max(1.5, 2 * state.zoom);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stk of pageStrokes) {
    if (!stk.points?.length) continue;
    ctx.beginPath();
    ctx.moveTo(stk.points[0].x * w, stk.points[0].y * h);
    for (let i = 1; i < stk.points.length; i++) {
      ctx.lineTo(stk.points[i].x * w, stk.points[i].y * h);
    }
    ctx.stroke();

    if (state.selectedOverlay?.kind === "stroke" && state.selectedOverlay?.id === stk.id) {
      const b = getStrokeBoundsNorm(stk);
      if (b) {
        const bx = b.x0 * w;
        const by = b.y0 * h;
        const bw = Math.max(12, (b.x1 - b.x0) * w);
        const bh = Math.max(12, (b.y1 - b.y0) * h);

        ctx.save();
        ctx.strokeStyle = "#8b5cf6";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.setLineDash([]);

        const badge = getStrokeDeleteBadgeHit(stk, w, h);
        if (badge) {
          ctx.fillStyle = "#e11d48";
          ctx.beginPath();
          ctx.arc(badge.cx, badge.cy, badge.badgeR, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(badge.cx - 5, badge.cy - 5);
          ctx.lineTo(badge.cx + 5, badge.cy + 5);
          ctx.moveTo(badge.cx + 5, badge.cy - 5);
          ctx.lineTo(badge.cx - 5, badge.cy + 5);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }
}

export function renderAllOverlays() {
  for (let p = 1; p <= state.totalPages; p++) {
    renderFreeTextsOverlay(p);
    redrawStrokesCanvas(p);
  }
}