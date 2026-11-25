import { state, els } from "./state.js";
import { renderPdfPage } from "./api.js";
import { scheduleAutosave } from "./draft.js";
import { scheduleEvaluate } from "./engine-sync.js";

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

export function revokeAllPageUrls() {
  for (const url of Object.values(state.pageUrls || {})) {
    if (url) URL.revokeObjectURL(url);
  }
  state.pageUrls = {};
}

export async function loadAndRenderPage(pageNum = state.currentPage) {
  if (!state.fileId) return;
  const target = getStageElements(pageNum);
  if (!target?.pageImage) return;

  const dpi = state.zoom > 1.25 ? 200 : 150;
  const blob = await renderPdfPage(state.fileId, pageNum, dpi);
  if (!blob) return;

  const nextUrl = URL.createObjectURL(blob);
  target.pageImage.onload = () => {
    applyStageLayout(pageNum);
    const prevUrl = state.pageUrls[pageNum];
    if (prevUrl && prevUrl !== nextUrl) {
      URL.revokeObjectURL(prevUrl);
    }
    state.pageUrls[pageNum] = nextUrl;
  };
  target.pageImage.src = nextUrl;
}

export async function loadAndRenderAllPages() {
  if (!state.fileId) return;
  for (let p = 1; p <= state.totalPages; p++) {
    await loadAndRenderPage(p);
  }
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

function renderWidgetsOverlay(pageNum, w, h, fields) {
  const target = getStageElements(pageNum);
  if (!target?.widgetsLayer) return;

  target.widgetsLayer.classList.toggle("show-field-hints", Boolean(state.showFieldHints));
  target.widgetsLayer.innerHTML = "";

  for (const f of fields) {
    const [x0, y0, x1, y1] = f.rect || [0, 0, 0, 0];
    const left = Math.round(x0 * w);
    const top = Math.round(y0 * h);
    const width = Math.round((x1 - x0) * w);
    const height = Math.round((y1 - y0) * h);

    if (!isFieldInteractive(f, width, height)) {
      continue;
    }

    if (f.type === "CheckBox") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "pdf-widget-checkbox";
      cb.dataset.fieldId = f.id;
      cb.checked = Boolean(state.fieldValues[f.id]);
      const boxSize = Math.min(20, Math.max(12, Math.min(width, height)));
      cb.style.left = `${left + Math.max(0, (width - boxSize) / 2)}px`;
      cb.style.top = `${top + Math.max(0, (height - boxSize) / 2)}px`;
      cb.style.width = `${boxSize}px`;
      cb.style.height = `${boxSize}px`;
      cb.addEventListener("change", () => {
        state.fieldValues[f.id] = cb.checked;
        scheduleAutosave();
        scheduleEvaluate({ delayMs: 40, rerenderPage: true }, loadAndRenderAllPages);
      });
      target.widgetsLayer.appendChild(cb);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "pdf-widget-input";
      inp.dataset.fieldId = f.id;
      inp.value = state.fieldValues[f.id] ?? "";
      inp.title = f.label || f.name;
      inp.style.left = `${left}px`;
      inp.style.top = `${top}px`;
      inp.style.width = `${Math.max(10, width)}px`;
      inp.style.height = `${Math.max(10, height)}px`;
      inp.style.lineHeight = `${Math.max(10, height - 2)}px`;
      inp.style.fontSize = `${Math.max(8, Math.min(13.5, height * 0.62))}px`;
      inp.style.textAlign = width <= 45 ? "center" : "left";
      inp.style.color = "transparent";

      inp.addEventListener("focus", () => {
        inp.style.color = "#0f172a";
      });
      inp.addEventListener("input", () => {
        state.fieldValues[f.id] = inp.value;
        scheduleAutosave();
        scheduleEvaluate({ delayMs: 220, rerenderPage: false });
      });
      inp.addEventListener("blur", () => {
        inp.style.color = "transparent";
        scheduleEvaluate({ delayMs: 0, rerenderPage: true }, loadAndRenderAllPages);
      });
      target.widgetsLayer.appendChild(inp);
    }
  }
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