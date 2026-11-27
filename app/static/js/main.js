import { initHomeWarpGrid, renderHomeWarpGrid } from "./warp-grid.js";
import {
  state,
  els,
  indexFieldsMetadata,
  buildPayloadByFieldName,
  normalizeFieldValueForCompare,
} from "./state.js";
import { closeServerSession, inspectPdfFile, exportFilledPdf } from "./api.js";
import { showToast, saveProgress, scheduleAutosave, loadSavedProgress } from "./draft.js";
import { evaluateWithEngine } from "./engine-sync.js";
import {
  loadAndRenderPage,
  applyStageLayout,
  renderFreeTextsOverlay,
  redrawStrokesCanvas,
  revokeAllPageUrls,
  hitTestStroke,
  getStrokeDeleteBadgeHit,
} from "./stage.js";

let historyBusy = false;
const pendingHistorySteps = [];

function getPagesContainer() {
  return document.getElementById("pagesContainer") || els.pageStage;
}

function setHeaderMode(mode) {
  const homeHeader = document.getElementById("homeHeader");
  const editorHeader = document.getElementById("editorHeader");
  const isEditor = mode === "editor";

  if (homeHeader) {
    homeHeader.classList.toggle("hidden", isEditor);
  }
  if (editorHeader) {
    editorHeader.classList.toggle("hidden", !isEditor);
    editorHeader.classList.toggle("flex", isEditor);
  }
}

function cloneStrokeSnapshot(stroke) {
  if (!stroke) return null;
  return {
    ...stroke,
    points: Array.isArray(stroke.points) ? stroke.points.map((pt) => ({ ...pt })) : [],
  };
}

function cloneActionSnapshot(action) {
  if (!action) return null;
  return {
    ...action,
    item: action.item ? { ...action.item } : null,
    stroke: action.stroke ? cloneStrokeSnapshot(action.stroke) : null,
  };
}

function isSameAction(a, b) {
  if (!a || !b || a.type !== b.type || (a.subType || null) !== (b.subType || null)) return false;
  if (a.type === "field") {
    return a.fid === b.fid && a.prevVal === b.prevVal && a.nextVal === b.nextVal;
  }
  if ((a.type === "text" || a.type === "stroke") && !a.subType) {
    return a.id && a.id === b.id;
  }
  return false;
}

export function pushHistory(action) {
  if (!action) return;
  if (!Array.isArray(state.history)) {
    state.history = [];
  }
  const prevTop = state.history[state.history.length - 1];
  if (isSameAction(prevTop, action)) {
    updateUndoState();
    return;
  }
  state.redoStack = [];
  state.history.push(cloneActionSnapshot(action));
  updateUndoState();
}

export function recordFieldChange(fid, prevVal, nextVal) {
  if (!fid || !Object.prototype.hasOwnProperty.call(state.fieldMeta || {}, fid)) return;
  const meta = state.fieldMeta[fid];
  const normPrev = normalizeFieldValueForCompare(meta?.type, prevVal);
  const normNext = normalizeFieldValueForCompare(meta?.type, nextVal);
  if (normPrev === normNext) return;

  pushHistory({
    type: "field",
    fid,
    prevVal: normPrev,
    nextVal: normNext,
    page: meta?.page,
  });
}

function updateUndoState() {
  const undoDisabled = !Array.isArray(state.history) || state.history.length === 0;
  const redoDisabled = !Array.isArray(state.redoStack) || state.redoStack.length === 0;
  if (els.undoBtn) els.undoBtn.disabled = undoDisabled;
  if (els.mUndo) els.mUndo.disabled = undoDisabled;
  if (els.redoBtn) els.redoBtn.disabled = redoDisabled;
  if (els.mRedo) els.mRedo.disabled = redoDisabled;
}

function syncFieldDomElement(fid, val) {
  const root = getPagesContainer() || document;
  const el = root.querySelector(`[data-field-id="${CSS.escape(String(fid))}"]`);
  if (!el) return;

  if (el.type === "checkbox") {
    el.checked = Boolean(val);
  } else {
    const nextStr = String(val ?? "");
    if (el.value !== nextStr) {
      el.value = nextStr;
    }
  }
}

function buildPageStages() {
  const container = getPagesContainer();
  if (!container) return;

  container.innerHTML = "";
  for (let pageNum = 1; pageNum <= state.totalPages; pageNum++) {
    const stage = document.createElement("div");
    stage.dataset.pageNum = String(pageNum);
    stage.className = "relative bg-white shadow-2xl mx-auto shrink-0";

    const img = document.createElement("img");
    img.alt = `Página ${pageNum}`;
    img.className = "block select-none pointer-events-none";

    const widgetsLayer = document.createElement("div");
    widgetsLayer.className = "absolute inset-0";

    const drawCanvas = document.createElement("canvas");
    drawCanvas.className = "absolute inset-0";

    const freeTextsLayer = document.createElement("div");
    freeTextsLayer.className = "absolute inset-0 pointer-events-none";

    stage.append(img, widgetsLayer, drawCanvas, freeTextsLayer);

    stage.addEventListener("click", (e) => {
      if (!state.fileId || state.tool !== "text") return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const xNorm = (e.clientX - rect.left) / rect.width;
      const yNorm = (e.clientY - rect.top) / rect.height;

      const text = prompt("Digite o texto:");
      if (!text || !text.trim()) return;

      const id = `txt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const item = {
        id,
        page: pageNum,
        x: Math.max(0, Math.min(1, xNorm)),
        y: Math.max(0, Math.min(1, yNorm)),
        text: text.trim(),
        font_size: 11,
      };
      state.freeTexts.push(item);
      pushHistory({ type: "text", id, page: pageNum, item });
      renderAllPagesOverlays();
      scheduleAutosave();
    });

    drawCanvas.addEventListener("mousedown", (e) => startDraw(e, pageNum, drawCanvas));
    drawCanvas.addEventListener("touchstart", (e) => startDraw(e, pageNum, drawCanvas), {
      passive: false,
    });

    container.appendChild(stage);
  }
}

function getStageEls(pageNum) {
  const container = getPagesContainer();
  const stage = container?.querySelector(`[data-page-num="${pageNum}"]`);
  if (!stage) return null;

  return {
    stage,
    pageImage: stage.querySelector("img"),
    widgetsLayer: stage.querySelector("div"),
    drawCanvas: stage.querySelector("canvas"),
    freeTextsLayer: stage.querySelectorAll("div")[1],
  };
}

function withPageContext(pageNum, fn) {
  const pageEls = getStageEls(pageNum);
  if (!pageEls) return;

  const prevPage = state.currentPage;
  const savedRefs = {
    pageStage: els.pageStage,
    pageImage: els.pageImage,
    widgetsLayer: els.widgetsLayer,
    drawCanvas: els.drawCanvas,
    freeTextsLayer: els.freeTextsLayer,
  };

  state.currentPage = pageNum;
  els.pageStage = pageEls.stage;
  els.pageImage = pageEls.pageImage;
  els.widgetsLayer = pageEls.widgetsLayer;
  els.drawCanvas = pageEls.drawCanvas;
  els.freeTextsLayer = pageEls.freeTextsLayer;

  try {
    return fn(pageEls);
  } finally {
    els.pageStage = savedRefs.pageStage;
    els.pageImage = savedRefs.pageImage;
    els.widgetsLayer = savedRefs.widgetsLayer;
    els.drawCanvas = savedRefs.drawCanvas;
    els.freeTextsLayer = savedRefs.freeTextsLayer;
    state.currentPage = prevPage;
  }
}

async function renderAllPages(options = {}, concurrency = 3) {
  if (!state.fileId) return;
  const force = Boolean(options?.force);

  if (state.totalPages >= 1) {
    await withPageContext(1, () => loadAndRenderPage(1, { force }));
    withPageContext(1, () => applyStageLayout(1));
  }

  let nextPage = 2;
  const workerCount = Math.min(concurrency, Math.max(0, state.totalPages - 1));

  async function worker() {
    while (nextPage <= state.totalPages) {
      const p = nextPage++;
      await withPageContext(p, () => loadAndRenderPage(p, { force }));
    }
  }

  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  applyAllPagesLayout();
}

function applyAllPagesLayout() {
  for (let p = 1; p <= state.totalPages; p++) {
    withPageContext(p, () => applyStageLayout(p));
  }
  syncToolPointersOnStages();
}

function renderAllPagesOverlays() {
  for (let p = 1; p <= state.totalPages; p++) {
    withPageContext(p, () => {
      renderFreeTextsOverlay(p);
      redrawStrokesCanvas(p);
    });
  }
}

function syncToolPointersOnStages() {
  const container = getPagesContainer();
  if (!container) return;

  const isFields = state.tool === "fields";
  const isText = state.tool === "text";
  const isDraw = state.tool === "draw";

  container.querySelectorAll("[data-page-num]").forEach((stage) => {
    const widgetsLayer = stage.querySelector("div");
    const drawCanvas = stage.querySelector("canvas");
    if (widgetsLayer) {
      const hasSelectedStroke = state.selectedOverlay?.kind === "stroke";
      widgetsLayer.style.pointerEvents = isFields && !hasSelectedStroke ? "auto" : "none";
    }
    if (drawCanvas) {
      drawCanvas.style.pointerEvents = isDraw || isFields ? "auto" : "none";
      drawCanvas.style.touchAction = isDraw ? "none" : "auto";
    }
    stage.style.cursor = isText ? "text" : isDraw ? "crosshair" : "default";
  });
}



async function applySingleUndo() {
  if (!Array.isArray(state.history) || state.history.length === 0) {
    updateUndoState();
    return;
  }

  const last = state.history.pop();
  if (!last) {
    updateUndoState();
    return;
  }

  if (!Array.isArray(state.redoStack)) {
    state.redoStack = [];
  }

  if (last.type === "text" && last.subType === "move") {
    const targetText = (state.freeTexts || []).find((t) => t.id === last.id);
    if (targetText && last.prevPos) {
      targetText.x = last.prevPos.x;
      targetText.y = last.prevPos.y;
    }
    state.redoStack.push(cloneActionSnapshot(last));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Movimento do texto desfeito");
    return;
  }

  if (last.type === "text" && last.subType === "delete" && last.item) {
    state.freeTexts = (state.freeTexts || []).filter((t) => t.id !== last.item.id);
    state.freeTexts.push({ ...last.item });
    state.redoStack.push(cloneActionSnapshot(last));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Exclusão do texto desfeita");
    return;
  }

  if (last.type === "stroke" && last.subType === "move") {
    const targetStroke = (state.strokes || []).find((s) => s.id === last.id);
    if (targetStroke && Array.isArray(last.prevPoints)) {
      targetStroke.points = last.prevPoints.map((p) => ({ ...p }));
    }
    state.redoStack.push(cloneActionSnapshot(last));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Movimento do desenho desfeito");
    return;
  }

  if (last.type === "stroke" && last.subType === "delete" && last.stroke) {
    const restored = cloneStrokeSnapshot(last.stroke);
    state.strokes = (state.strokes || []).filter((s) => s.id !== restored.id);
    state.strokes.push(restored);
    state.redoStack.push(cloneActionSnapshot(last));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Exclusão do desenho desfeita");
    return;
  }

  if (last.type === "text") {
    const existing = (state.freeTexts || []).find((t) => t.id === last.id);
    const snapshotItem = last.item ? { ...last.item } : existing ? { ...existing } : null;
    state.freeTexts = (state.freeTexts || []).filter((t) => t.id !== last.id);
    state.redoStack.push(cloneActionSnapshot({ ...last, item: snapshotItem }));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Texto desfeito");
  } else if (last.type === "stroke") {
    if (state.currentStroke && state.currentStroke.id === last.id) {
      state.currentStroke = null;
      state.isDrawing = false;
    }
    const existing = (state.strokes || []).find((s) => s.id === last.id);
    const snapshotStroke = last.stroke
      ? cloneStrokeSnapshot(last.stroke)
      : existing
        ? cloneStrokeSnapshot(existing)
        : null;
    state.strokes = (state.strokes || []).filter((s) => s.id !== last.id);
    state.redoStack.push(cloneActionSnapshot({ ...last, stroke: snapshotStroke }));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Traço desfeito");
  } else if (last.type === "field" && last.fid) {
    clearTimeout(state.evalTimer);
    state.evalTimer = null;

    state.redoStack.push(cloneActionSnapshot(last));
    updateUndoState();

    const meta = state.fieldMeta?.[last.fid];
    const revertedVal = normalizeFieldValueForCompare(meta?.type, last.prevVal);
    state.fieldValues[last.fid] = revertedVal;
    syncFieldDomElement(last.fid, revertedVal);
    scheduleAutosave();
    showToast("Campo desfeito");

    await evaluateWithEngine(
      { rerenderPage: true, onlyDirty: false },
      () => renderAllPages({ force: true })
    );
  } else {
    updateUndoState();
  }
}

async function applySingleRedo() {
  if (!Array.isArray(state.redoStack) || state.redoStack.length === 0) {
    updateUndoState();
    return;
  }

  const next = state.redoStack.pop();
  if (!next) {
    updateUndoState();
    return;
  }

  if (!Array.isArray(state.history)) {
    state.history = [];
  }

  if (next.type === "text" && next.subType === "move") {
    const targetText = (state.freeTexts || []).find((t) => t.id === next.id);
    if (targetText && next.nextPos) {
      targetText.x = next.nextPos.x;
      targetText.y = next.nextPos.y;
    }
    state.history.push(cloneActionSnapshot(next));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Movimento do texto refeito");
    return;
  }

  if (next.type === "text" && next.subType === "delete" && next.item) {
    state.freeTexts = (state.freeTexts || []).filter((t) => t.id !== next.item.id);
    if (state.selectedOverlay?.kind === "text" && state.selectedOverlay?.id === next.item.id) {
      state.selectedOverlay = null;
    }
    state.history.push(cloneActionSnapshot(next));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Exclusão do texto refeita");
    return;
  }

  if (next.type === "stroke" && next.subType === "move") {
    const targetStroke = (state.strokes || []).find((s) => s.id === next.id);
    if (targetStroke && Array.isArray(next.nextPoints)) {
      targetStroke.points = next.nextPoints.map((p) => ({ ...p }));
    }
    state.history.push(cloneActionSnapshot(next));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Movimento do desenho refeito");
    return;
  }

  if (next.type === "stroke" && next.subType === "delete" && next.stroke) {
    state.strokes = (state.strokes || []).filter((s) => s.id !== next.stroke.id);
    if (state.selectedOverlay?.kind === "stroke" && state.selectedOverlay?.id === next.stroke.id) {
      state.selectedOverlay = null;
    }
    state.history.push(cloneActionSnapshot(next));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Exclusão do desenho refeita");
    return;
  }

  if (next.type === "text" && next.item) {
    const restored = { ...next.item };
    state.freeTexts = (state.freeTexts || []).filter((t) => t.id !== restored.id);
    state.freeTexts.push(restored);
    state.history.push(cloneActionSnapshot({ ...next, item: restored }));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Texto refeito");
  } else if (next.type === "stroke" && next.stroke) {
    const restored = cloneStrokeSnapshot(next.stroke);
    state.strokes = (state.strokes || []).filter((s) => s.id !== restored.id);
    state.strokes.push(restored);
    state.history.push(cloneActionSnapshot({ ...next, stroke: restored }));
    updateUndoState();
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Traço refeito");
  } else if (next.type === "field" && next.fid) {
    clearTimeout(state.evalTimer);
    state.evalTimer = null;

    state.history.push(cloneActionSnapshot(next));
    updateUndoState();

    const meta = state.fieldMeta?.[next.fid];
    const appliedVal = normalizeFieldValueForCompare(meta?.type, next.nextVal);
    state.fieldValues[next.fid] = appliedVal;
    syncFieldDomElement(next.fid, appliedVal);
    scheduleAutosave();
    showToast("Campo refeito");

    await evaluateWithEngine(
      { rerenderPage: true, onlyDirty: false },
      () => renderAllPages({ force: true })
    );
  } else {
    updateUndoState();
  }
}

async function drainHistoryQueue() {
  if (historyBusy) return;
  historyBusy = true;
  try {
    while (pendingHistorySteps.length > 0) {
      const step = pendingHistorySteps.shift();
      if (step === "undo") {
        await applySingleUndo();
      } else if (step === "redo") {
        await applySingleRedo();
      }
    }
  } finally {
    historyBusy = false;
    updateUndoState();
  }
}

function enqueueHistoryStep(step) {
  if (!state.fileId) return;
  if (step === "undo" && (!Array.isArray(state.history) || state.history.length === 0)) {
    updateUndoState();
    return;
  }
  if (step === "redo" && (!Array.isArray(state.redoStack) || state.redoStack.length === 0)) {
    updateUndoState();
    return;
  }
  pendingHistorySteps.push(step);
  void drainHistoryQueue();
}

function undoLastAction() {
  enqueueHistoryStep("undo");
}

function redoLastAction() {
  enqueueHistoryStep("redo");
}

async function handleFileSelected(file) {
  if (!file) return;
  pendingHistorySteps.length = 0;
  historyBusy = false;
  clearTimeout(state.evalTimer);
  revokeAllPageUrls();
  if (state.fileId) {
    closeServerSession(state.fileId);
    state.fileId = null;
  }

  els.statusText.textContent = "Carregando documento...";
  els.exportBtn.disabled = true;

  try {
    const data = await inspectPdfFile(file);

    state.fileId = data.file_id;
    state.filename = data.filename;
    state.totalPages = data.total_pages || 1;
    state.currentPage = 1;
    state.pages = data.pages || [];
    state.docScripts = data.doc_scripts || [];
    state.fieldValues = {};
    state.freeTexts = [];
    state.strokes = [];
    state.history = [];
    state.redoStack = [];
    state.isDrawing = false;
    state.currentStroke = null;
    updateUndoState();

    indexFieldsMetadata();
    const restored = loadSavedProgress();

    setHeaderMode("editor");
    els.fileNameLabel.textContent = state.filename;
    els.backBtn.classList.remove("hidden");
    els.toolbarCenter.classList.remove("hidden");
    els.mobileSubbar.classList.remove("hidden");
    els.actionsRight.classList.remove("hidden");
    els.actionsRight.classList.add("flex");
    els.flattenWrap.classList.remove("hidden");
    els.emptyState.classList.add("hidden");
    renderHomeWarpGrid();

    const container = getPagesContainer();
    container.classList.remove("hidden");
    container.classList.add("flex");
    buildPageStages();
    applyAllPagesLayout();

    els.exportBtn.disabled = false;
    els.statusText.textContent = "";

    setTool("fields");
    setFieldHints(false);

    if (restored) {
      showToast("Rascunho anterior restaurado.");
      await evaluateWithEngine(
        { rerenderPage: true, onlyDirty: false },
        () => renderAllPages({ force: true })
      );
    } else {
      await renderAllPages({ force: true });
    }
  } catch (err) {
    els.statusText.textContent = `Erro: ${err.message}`;
  }
}

function setFieldHints(enabled) {
  state.showFieldHints = Boolean(enabled);
  const container = getPagesContainer();
  container?.querySelectorAll("[data-page-num] > div:first-of-type").forEach((layer) => {
    layer.classList.toggle("show-field-hints", state.showFieldHints);
  });

  els.toggleHintsBtn.className = state.showFieldHints
    ? "px-2 py-1 rounded text-xs bg-violet-500/30 text-violet-100 border border-violet-400/50"
    : "px-2 py-1 rounded text-xs hover:bg-violet-500/20 text-slate-300 transition";

  els.mToggleHints.className = state.showFieldHints
    ? "px-2 py-1 rounded bg-violet-500/30 text-violet-100 border border-violet-400/40"
    : "px-2 py-1 rounded bg-violet-500/15 hover:bg-violet-500/25";
}

function setTool(newTool) {
  state.tool = newTool;

  const isFields = newTool === "fields";
  const isText = newTool === "text";
  const isDraw = newTool === "draw";

  els.toolCursorBtn.className = isFields
    ? "px-2 py-1 rounded text-xs bg-violet-500/30 text-violet-100 border border-violet-400/50"
    : "px-2 py-1 rounded text-xs hover:bg-violet-500/20 text-slate-300 transition";

  els.toolTextBtn.className = isText
    ? "w-7 h-7 rounded bg-violet-500/30 text-violet-100 border border-violet-400/50 text-sm font-serif font-bold flex items-center justify-center"
    : "w-7 h-7 rounded hover:bg-violet-500/20 text-sm font-serif font-bold flex items-center justify-center transition";

  els.toolDrawBtn.className = isDraw
    ? "w-7 h-7 rounded bg-violet-500/30 text-violet-100 border border-violet-400/50 text-sm flex items-center justify-center"
    : "w-7 h-7 rounded hover:bg-violet-500/20 text-sm flex items-center justify-center transition";

  els.mToolFields.className = isFields
    ? "px-2 py-1 rounded bg-violet-500/30 text-violet-100 border border-violet-400/40"
    : "px-2 py-1 rounded bg-violet-500/15 hover:bg-violet-500/25";
  els.mToolText.className = isText
    ? "px-2 py-1 rounded bg-violet-500/30 text-violet-100 border border-violet-400/40 font-serif font-bold"
    : "px-2 py-1 rounded bg-violet-500/15 hover:bg-violet-500/25 font-serif font-bold";
  els.mToolDraw.className = isDraw
    ? "px-2 py-1 rounded bg-violet-500/30 text-violet-100 border border-violet-400/40"
    : "px-2 py-1 rounded bg-violet-500/15 hover:bg-violet-500/25";

  syncToolPointersOnStages();
}

function setZoom(val) {
  const prevDpi = state.zoom > 1.25 ? 190 : 115;
  state.zoom = Math.max(0.5, Math.min(2.2, Number(val.toFixed(2))));
  const nextDpi = state.zoom > 1.25 ? 190 : 115;
  const pct = `${Math.round(state.zoom * 100)}%`;
  els.zoomLabel.textContent = pct;
  els.mZoomLabel.textContent = pct;
  applyAllPagesLayout();

  if (state.fileId && prevDpi !== nextDpi) {
    renderAllPages({ force: false });
  }
}

function getNormCoords(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches?.[0]?.clientX ?? e.clientX;
  const clientY = e.touches?.[0]?.clientY ?? e.clientY;
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1))),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(rect.height, 1))),
  };
}

let draggingOverlay = null;

function getOverlayClientPoint(e) {
  if (e.touches && e.touches.length > 0) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  if (e.changedTouches && e.changedTouches.length > 0) {
    return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

function getStrokeDeleteBadgeCenter(stroke, w, h) {
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
  const badgeR = 9;
  return {
    cx: Math.min(w - badgeR - 2, bx + bw),
    cy: Math.max(badgeR + 2, by),
    r: badgeR + 5, // margem amigável ao toque no celular
  };
}

function startDraw(e, pageNum, canvas) {
  if (!state.fileId) return;

  if (state.tool !== "draw") {
    const pt = getNormCoords(e, canvas);
    const px = pt.x * canvas.width;
    const py = pt.y * canvas.height;

    if (state.selectedOverlay?.kind === "stroke") {
      const selectedStk = (state.strokes || []).find(
        (s) => s.id === state.selectedOverlay.id && s.page === pageNum
      );
      if (selectedStk) {
        const badge = getStrokeDeleteBadgeHit(selectedStk, canvas.width, canvas.height);
        if (badge && Math.hypot(px - badge.cx, py - badge.cy) <= badge.hitR) {
          e.preventDefault();
          e.stopPropagation();
          deleteOverlayById("stroke", selectedStk.id, true);
          return;
        }
      }
    }

    const hit = hitTestStroke(pageNum, pt.x, pt.y, canvas.width, canvas.height, 12);
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      state.selectedOverlay = { kind: "stroke", id: hit.id };
      renderAllPagesOverlays();

      const clientPt = getOverlayClientPoint(e);
      const rect = canvas.getBoundingClientRect();
      draggingOverlay = {
        kind: "stroke",
        id: hit.id,
        page: pageNum,
        startClientX: clientPt.x,
        startClientY: clientPt.y,
        width: Math.max(rect.width, 1),
        height: Math.max(rect.height, 1),
        origPoints: hit.points.map((p) => ({ x: p.x, y: p.y })),
        moved: false,
      };
      return;
    }

    if (state.selectedOverlay) {
      state.selectedOverlay = null;
      renderAllPagesOverlays();
    }
    return;
  }

  e.preventDefault();
  state.selectedOverlay = null;
  const pt = getNormCoords(e, canvas);
  const id = `stk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  state.currentPage = pageNum;
  state.isDrawing = true;
  state.currentStroke = { id, page: pageNum, points: [pt] };
  state.strokes.push(state.currentStroke);
  pushHistory({ type: "stroke", id, page: pageNum, stroke: state.currentStroke });
}

function moveDraw(e) {
  if (draggingOverlay && draggingOverlay.kind === "stroke") {
    const stk = (state.strokes || []).find((s) => s.id === draggingOverlay.id);
    if (!stk) return;
    const curPt = getOverlayClientPoint(e);
    const dxNorm = (curPt.x - draggingOverlay.startClientX) / draggingOverlay.width;
    const dyNorm = (curPt.y - draggingOverlay.startClientY) / draggingOverlay.height;
    if (Math.abs(dxNorm) > 0.002 || Math.abs(dyNorm) > 0.002) {
      draggingOverlay.moved = true;
      if (e.cancelable) e.preventDefault();
    }
    stk.points = draggingOverlay.origPoints.map((p) => ({
      x: Math.max(0, Math.min(1, p.x + dxNorm)),
      y: Math.max(0, Math.min(1, p.y + dyNorm)),
    }));
    withPageContext(draggingOverlay.page, () => redrawStrokesCanvas(draggingOverlay.page));
    return;
  }

  if (!state.isDrawing || !state.currentStroke) return;
  const pageEls = getStageEls(state.currentStroke.page);
  if (!pageEls?.drawCanvas) return;
  e.preventDefault();
  state.currentStroke.points.push(getNormCoords(e, pageEls.drawCanvas));
  withPageContext(state.currentStroke.page, () => redrawStrokesCanvas(state.currentStroke.page));
}

function endDraw() {
  if (draggingOverlay && draggingOverlay.kind === "stroke") {
    const stk = (state.strokes || []).find((s) => s.id === draggingOverlay.id);
    if (draggingOverlay.moved && stk) {
      window.dispatchEvent(
        new CustomEvent("fastpdf:move-overlay", {
          detail: {
            kind: "stroke",
            id: stk.id,
            page: draggingOverlay.page,
            prevPoints: draggingOverlay.origPoints.map((p) => ({ ...p })),
            nextPoints: stk.points.map((p) => ({ ...p })),
          },
        })
      );
      scheduleAutosave();
    }
    draggingOverlay = null;
  }

  if (state.isDrawing) {
    const finishedStroke = state.currentStroke ? cloneStrokeSnapshot(state.currentStroke) : null;
    if (finishedStroke && Array.isArray(state.history)) {
      const last = state.history[state.history.length - 1];
      if (last && last.type === "stroke" && last.id === finishedStroke.id) {
        last.stroke = finishedStroke;
      }
    }
    state.isDrawing = false;
    state.currentStroke = null;
    scheduleAutosave();
  }
}

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function deleteOverlayById(kind, id, recordUndo = true) {
  if (!kind || !id) return;
  if (kind === "text") {
    const idx = (state.freeTexts || []).findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [removed] = state.freeTexts.splice(idx, 1);
    if (state.selectedOverlay?.kind === "text" && state.selectedOverlay?.id === id) {
      state.selectedOverlay = null;
    }
    if (recordUndo) {
      pushHistory({ type: "text", subType: "delete", id, page: removed.page, item: { ...removed } });
    }
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Texto apagado");
  } else if (kind === "stroke") {
    const idx = (state.strokes || []).findIndex((s) => s.id === id);
    if (idx === -1) return;
    const [removed] = state.strokes.splice(idx, 1);
    if (state.selectedOverlay?.kind === "stroke" && state.selectedOverlay?.id === id) {
      state.selectedOverlay = null;
    }
    if (recordUndo) {
      pushHistory({
        type: "stroke",
        subType: "delete",
        id,
        page: removed.page,
        stroke: cloneStrokeSnapshot(removed),
      });
    }
    renderAllPagesOverlays();
    scheduleAutosave();
    showToast("Desenho apagado");
  }
}

window.addEventListener("fastpdf:delete-overlay", (e) => {
  const { kind, id } = e.detail || {};
  deleteOverlayById(kind, id, true);
});

window.addEventListener("fastpdf:move-overlay", (e) => {
  const { kind, id, page, prevPos, nextPos, prevPoints, nextPoints } = e.detail || {};
  if (kind === "text") {
    pushHistory({
      type: "text",
      subType: "move",
      id,
      page,
      prevPos,
      nextPos,
    });
  } else if (kind === "stroke") {
    pushHistory({
      type: "stroke",
      subType: "move",
      id,
      page,
      prevPoints,
      nextPoints,
    });
  }
});

window.addEventListener("keydown", (e) => {
  if (
    state.fileId &&
    state.selectedOverlay &&
    (e.key === "Delete" || e.key === "Backspace") &&
    !isEditableTarget(document.activeElement)
  ) {
    e.preventDefault();
    deleteOverlayById(state.selectedOverlay.kind, state.selectedOverlay.id, true);
  }
});

els.saveBtn.addEventListener("click", async () => {
  if (!state.fileId) return;
  clearTimeout(state.evalTimer);
  await evaluateWithEngine({ rerenderPage: false, onlyDirty: false });
  saveProgress(true);
});

els.backBtn.addEventListener("click", () => {
  pendingHistorySteps.length = 0;
  historyBusy = false;
  clearTimeout(state.evalTimer);
  saveProgress(false);
  revokeAllPageUrls();
  closeServerSession(state.fileId);
  state.fileId = null;
  state.history = [];
  state.redoStack = [];
  state.isDrawing = false;
  state.currentStroke = null;
  updateUndoState();
  setHeaderMode("home");
  els.backBtn.classList.add("hidden");
  els.toolbarCenter.classList.add("hidden");
  els.mobileSubbar.classList.add("hidden");
  els.actionsRight.classList.add("hidden");
  els.actionsRight.classList.remove("flex");

  const container = getPagesContainer();
  container.classList.add("hidden");
  container.classList.remove("flex");
  container.innerHTML = "";

  els.emptyState.classList.remove("hidden");
  renderHomeWarpGrid();
  els.fileNameLabel.textContent = "Fast PDFedit";
  els.statusText.textContent = "";
  els.pdfInput.value = "";
  els.pdfInputEmpty.value = "";
});

els.toggleHintsBtn.addEventListener("click", () => setFieldHints(!state.showFieldHints));
els.mToggleHints.addEventListener("click", () => setFieldHints(!state.showFieldHints));

els.pdfInput.addEventListener("change", (e) => handleFileSelected(e.target.files?.[0]));
els.pdfInputEmpty.addEventListener("change", (e) => handleFileSelected(e.target.files?.[0]));

els.toolCursorBtn.addEventListener("click", () => setTool("fields"));
els.toolTextBtn.addEventListener("click", () => setTool("text"));
els.toolDrawBtn.addEventListener("click", () => setTool("draw"));
els.undoBtn.addEventListener("click", undoLastAction);
els.redoBtn?.addEventListener("click", redoLastAction);

els.mToolFields.addEventListener("click", () => setTool("fields"));
els.mToolText.addEventListener("click", () => setTool("text"));
els.mToolDraw.addEventListener("click", () => setTool("draw"));
els.mUndo.addEventListener("click", undoLastAction);
els.mRedo?.addEventListener("click", redoLastAction);

els.zoomInBtn.addEventListener("click", () => setZoom(state.zoom + 0.15));
els.zoomOutBtn.addEventListener("click", () => setZoom(state.zoom - 0.15));
els.mZoomIn.addEventListener("click", () => setZoom(state.zoom + 0.15));
els.mZoomOut.addEventListener("click", () => setZoom(state.zoom - 0.15));

window.addEventListener("mousemove", moveDraw);
window.addEventListener("mouseup", endDraw);
window.addEventListener("touchmove", moveDraw, { passive: false });
window.addEventListener("touchend", endDraw);
window.addEventListener("beforeunload", () => {
  revokeAllPageUrls();
  if (state.fileId) {
    closeServerSession(state.fileId);
  }
});

// Gestão de Atalhos Globais de Teclado
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (state.fileId) {
      els.saveBtn.click();
    }
    return;
  }

  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "z") {
    if (isEditableTarget(document.activeElement)) {
      return;
    }
    e.preventDefault();
    undoLastAction();
    return;
  }

  if (
    ((e.ctrlKey || e.metaKey) && !e.shiftKey && key === "y") ||
    ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "z")
  ) {
    if (isEditableTarget(document.activeElement)) {
      return;
    }
    e.preventDefault();
    redoLastAction();
    return;
  }

  if (e.key === "Escape") {
    if (state.tool !== "fields") {
      setTool("fields");
    } else {
      const active = document.activeElement;
      if (active && active.tagName === "INPUT") {
        active.blur();
      }
    }
  }
});

els.exportBtn.addEventListener("click", async () => {
  if (!state.fileId) return;
  clearTimeout(state.evalTimer);
  await evaluateWithEngine({ rerenderPage: false, onlyDirty: false });
  saveProgress(false);
  els.exportBtn.disabled = true;
  const prev = els.exportBtn.textContent;
  els.exportBtn.textContent = "Salvando...";

  try {
    const blob = await exportFilledPdf({
      file_id: state.fileId,
      fields: buildPayloadByFieldName({ onlyDirty: false }),
      free_texts: state.freeTexts,
      strokes: state.strokes,
      flatten: els.flattenCheckbox.checked,
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.filename.replace(/\.pdf$/i, "") || "documento"}-editado.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("PDF baixado com sucesso!");
  } catch (err) {
    alert(err.message);
  } finally {
    els.exportBtn.disabled = false;
    els.exportBtn.textContent = prev;
  }
});

initHomeWarpGrid();