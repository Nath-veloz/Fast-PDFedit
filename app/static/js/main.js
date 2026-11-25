import { initHomeWarpGrid, renderHomeWarpGrid } from "./warp-grid.js";
import { state, els, indexFieldsMetadata, buildPayloadByFieldName } from "./state.js";
import { closeServerSession, inspectPdfFile, exportFilledPdf } from "./api.js";
import { showToast, saveProgress, scheduleAutosave, loadSavedProgress } from "./draft.js";
import { evaluateWithEngine } from "./engine-sync.js";
import {
  loadAndRenderPage,
  applyStageLayout,
  renderFreeTextsOverlay,
  redrawStrokesCanvas,
  revokeAllPageUrls,
} from "./stage.js";

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

function pushHistory(action) {
  state.history.push(action);
  updateUndoState();
}

function updateUndoState() {
  const disabled = state.history.length === 0;
  if (els.undoBtn) els.undoBtn.disabled = disabled;
  if (els.mUndo) els.mUndo.disabled = disabled;
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
      state.freeTexts.push({
        id,
        page: pageNum,
        x: Math.max(0, Math.min(1, xNorm)),
        y: Math.max(0, Math.min(1, yNorm)),
        text: text.trim(),
        font_size: 11,
      });
      pushHistory({ type: "text", id });
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
    if (widgetsLayer) widgetsLayer.style.pointerEvents = isFields ? "auto" : "none";
    if (drawCanvas) drawCanvas.style.pointerEvents = isDraw ? "auto" : "none";
    stage.style.cursor = isText ? "text" : isDraw ? "crosshair" : "default";
  });
}

function undoLastAction() {
  const last = state.history.pop();
  updateUndoState();
  if (!last) return;

  if (last.type === "text") {
    state.freeTexts = state.freeTexts.filter((t) => t.id !== last.id);
    renderAllPagesOverlays();
    scheduleAutosave();
  } else if (last.type === "stroke") {
    state.strokes = state.strokes.filter((s) => s.id !== last.id);
    renderAllPagesOverlays();
    scheduleAutosave();
  }
}

async function handleFileSelected(file) {
  if (!file) return;
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

function startDraw(e, pageNum, canvas) {
  if (!state.fileId || state.tool !== "draw") return;
  e.preventDefault();
  const pt = getNormCoords(e, canvas);
  const id = `stk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  state.currentPage = pageNum;
  state.isDrawing = true;
  state.currentStroke = { id, page: pageNum, points: [pt] };
  state.strokes.push(state.currentStroke);
  pushHistory({ type: "stroke", id });
}

function moveDraw(e) {
  if (!state.isDrawing || !state.currentStroke) return;
  const pageEls = getStageEls(state.currentStroke.page);
  if (!pageEls?.drawCanvas) return;
  e.preventDefault();
  state.currentStroke.points.push(getNormCoords(e, pageEls.drawCanvas));
  withPageContext(state.currentStroke.page, () => redrawStrokesCanvas(state.currentStroke.page));
}

function endDraw() {
  if (state.isDrawing) {
    state.isDrawing = false;
    state.currentStroke = null;
    scheduleAutosave();
  }
}

els.saveBtn.addEventListener("click", async () => {
  if (!state.fileId) return;
  clearTimeout(state.evalTimer);
  await evaluateWithEngine({ rerenderPage: false, onlyDirty: false });
  saveProgress(true);
});

els.backBtn.addEventListener("click", () => {
  clearTimeout(state.evalTimer);
  saveProgress(false);
  revokeAllPageUrls();
  closeServerSession(state.fileId);
  state.fileId = null;
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

els.mToolFields.addEventListener("click", () => setTool("fields"));
els.mToolText.addEventListener("click", () => setTool("text"));
els.mToolDraw.addEventListener("click", () => setTool("draw"));
els.mUndo.addEventListener("click", undoLastAction);

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