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

export function renderFreeTextsOverlay(pageNum = state.currentPage) {
  const target = getStageElements(pageNum);
  if (!target?.freeTextsLayer) return;

  target.freeTextsLayer.innerHTML = "";
  const items = state.freeTexts.filter((t) => t.page === pageNum);
  for (const t of items) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.left = `${t.x * 100}%`;
    el.style.top = `${t.y * 100}%`;
    el.style.fontSize = `${Math.max(9, t.font_size * state.zoom)}px`;
    el.className = "text-blue-900 font-medium whitespace-nowrap leading-none";
    el.textContent = t.text;
    target.freeTextsLayer.appendChild(el);
  }
}

export function redrawStrokesCanvas(pageNum = state.currentPage) {
  const target = getStageElements(pageNum);
  if (!target?.drawCanvas) return;

  const ctx = target.drawCanvas.getContext("2d");
  const w = target.drawCanvas.width;
  const h = target.drawCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const pageStrokes = state.strokes.filter((s) => s.page === pageNum);
  ctx.strokeStyle = "#1d4ed8";
  ctx.lineWidth = Math.max(1.5, 2 * state.zoom);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const stk of pageStrokes) {
    if (!stk.points.length) continue;
    ctx.beginPath();
    ctx.moveTo(stk.points[0].x * w, stk.points[0].y * h);
    for (let i = 1; i < stk.points.length; i++) {
      ctx.lineTo(stk.points[i].x * w, stk.points[i].y * h);
    }
    ctx.stroke();
  }
}

export function renderAllOverlays() {
  for (let p = 1; p <= state.totalPages; p++) {
    renderFreeTextsOverlay(p);
    redrawStrokesCanvas(p);
  }
}