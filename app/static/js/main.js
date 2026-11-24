import { state, els, indexFieldsMetadata, buildPayloadByFieldName } from "./state.js";
import { closeServerSession, inspectPdfFile, exportFilledPdf } from "./api.js";
import { showToast, saveProgress, scheduleAutosave, loadSavedProgress } from "./draft.js";
import { evaluateWithEngine } from "./engine-sync.js";
import {
  loadAndRenderPage,
  applyStageLayout,
  renderFreeTextsOverlay,
  redrawStrokesCanvas,
} from "./stage.js";

function pushHistory(action) {
  state.history.push(action);
  updateUndoState();
}

function updateUndoState() {
  const disabled = state.history.length === 0;
  els.undoBtn.disabled = disabled;
  els.mUndo.disabled = disabled;
}

function undoLastAction() {
  const last = state.history.pop();
  updateUndoState();
  if (!last) return;

  if (last.type === "text") {
    state.freeTexts = state.freeTexts.filter((t) => t.id !== last.id);
    renderFreeTextsOverlay();
    scheduleAutosave();
  } else if (last.type === "stroke") {
    state.strokes = state.strokes.filter((s) => s.id !== last.id);
    redrawStrokesCanvas();
    scheduleAutosave();
  }
}

async function handleFileSelected(file) {
  if (!file) return;
  clearTimeout(state.evalTimer);
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

    for (const p of state.pages) {
      for (const f of p.fields || []) {
        state.fieldValues[f.id] = f.value;
      }
    }

    indexFieldsMetadata();
    const restored = loadSavedProgress();

    els.fileNameLabel.textContent = state.filename;
    els.totalPagesLabel.textContent = String(state.totalPages);
    els.pageInput.max = String(state.totalPages);
    els.backBtn.classList.remove("hidden");
    els.toolbarCenter.classList.remove("hidden");
    els.toolbarCenter.classList.add("md:flex");
    els.mobileSubbar.classList.remove("hidden");
    els.actionsRight.classList.remove("hidden");
    els.actionsRight.classList.add("flex");
    els.flattenWrap.classList.remove("hidden");
    els.emptyState.classList.add("hidden");
    els.pageStage.classList.remove("hidden");
    els.exportBtn.disabled = false;
    els.statusText.textContent = "";

    setTool("fields");
    setFieldHints(false);

    if (restored) {
      showToast("Rascunho anterior restaurado.");
      await evaluateWithEngine({ rerenderPage: true, onlyDirty: false }, loadAndRenderPage);
    } else {
      await loadAndRenderPage();
    }
  } catch (err) {
    els.statusText.textContent = `Erro: ${err.message}`;
  }
}

function setFieldHints(enabled) {
  state.showFieldHints = Boolean(enabled);
  els.widgetsLayer.classList.toggle("show-field-hints", state.showFieldHints);

  els.toggleHintsBtn.className = state.showFieldHints
    ? "px-2 py-1 rounded text-xs bg-blue-500/30 text-blue-200 border border-blue-400/40"
    : "px-2 py-1 rounded text-xs hover:bg-white/10 text-slate-300";

  els.mToggleHints.className = state.showFieldHints
    ? "px-2 py-1 rounded bg-blue-500/30 text-blue-200"
    : "px-2 py-1 rounded bg-white/10";
}

function setTool(newTool) {
  state.tool = newTool;

  const isFields = newTool === "fields";
  const isText = newTool === "text";
  const isDraw = newTool === "draw";

  els.toolCursorBtn.className = isFields
    ? "px-2 py-1 rounded text-xs bg-blue-500/30 text-blue-200 border border-blue-400/40"
    : "px-2 py-1 rounded text-xs hover:bg-white/10 text-slate-300";

  els.toolTextBtn.className = isText
    ? "w-7 h-7 rounded bg-blue-500/30 text-blue-200 border border-blue-400/40 text-sm font-serif font-bold flex items-center justify-center"
    : "w-7 h-7 rounded hover:bg-white/10 text-sm font-serif font-bold flex items-center justify-center";

  els.toolDrawBtn.className = isDraw
    ? "w-7 h-7 rounded bg-blue-500/30 text-blue-200 border border-blue-400/40 text-sm flex items-center justify-center"
    : "w-7 h-7 rounded hover:bg-white/10 text-sm flex items-center justify-center";

  els.mToolFields.className = isFields
    ? "px-2 py-1 rounded bg-blue-500/30 text-blue-200"
    : "px-2 py-1 rounded bg-white/10";
  els.mToolText.className = isText
    ? "px-2 py-1 rounded bg-blue-500/30 text-blue-200 font-serif font-bold"
    : "px-2 py-1 rounded bg-white/10 font-serif font-bold";
  els.mToolDraw.className = isDraw
    ? "px-2 py-1 rounded bg-blue-500/30 text-blue-200"
    : "px-2 py-1 rounded bg-white/10";

  els.widgetsLayer.style.pointerEvents = isFields ? "auto" : "none";
  els.drawCanvas.style.pointerEvents = isDraw ? "auto" : "none";
  els.pageStage.style.cursor = isText ? "text" : isDraw ? "crosshair" : "default";
}

function setZoom(val) {
  state.zoom = Math.max(0.5, Math.min(2.2, Number(val.toFixed(2))));
  const pct = `${Math.round(state.zoom * 100)}%`;
  els.zoomLabel.textContent = pct;
  els.mZoomLabel.textContent = pct;
  applyStageLayout();
}

async function goToPage(p) {
  if (!state.fileId) return;
  const clamped = Math.max(1, Math.min(state.totalPages, p));
  state.currentPage = clamped;
  scheduleAutosave();
  await loadAndRenderPage();
}

function getNormCoords(e) {
  const rect = els.drawCanvas.getBoundingClientRect();
  const clientX = e.touches?.[0]?.clientX ?? e.clientX;
  const clientY = e.touches?.[0]?.clientY ?? e.clientY;
  return {
    x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
  };
}

function startDraw(e) {
  if (!state.fileId || state.tool !== "draw") return;
  e.preventDefault();
  const pt = getNormCoords(e);
  const id = `stk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  state.isDrawing = true;
  state.currentStroke = { id, page: state.currentPage, points: [pt] };
  state.strokes.push(state.currentStroke);
  pushHistory({ type: "stroke", id });
}

function moveDraw(e) {
  if (!state.isDrawing || !state.currentStroke) return;
  e.preventDefault();
  state.currentStroke.points.push(getNormCoords(e));
  redrawStrokesCanvas();
}

function endDraw() {
  if (state.isDrawing) {
    state.isDrawing = false;
    state.currentStroke = null;
    scheduleAutosave();
  }
}

els.saveBtn.addEventListener("click", () => saveProgress(true));

els.backBtn.addEventListener("click", () => {
  clearTimeout(state.evalTimer);
  saveProgress(false);
  closeServerSession(state.fileId);
  state.fileId = null;
  els.backBtn.classList.add("hidden");
  els.toolbarCenter.classList.add("hidden");
  els.toolbarCenter.classList.remove("md:flex");
  els.mobileSubbar.classList.add("hidden");
  els.actionsRight.classList.add("hidden");
  els.actionsRight.classList.remove("flex");
  els.pageStage.classList.add("hidden");
  els.emptyState.classList.remove("hidden");
  els.fileNameLabel.textContent = "Fast-PDFedit";
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

els.prevPageBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
els.nextPageBtn.addEventListener("click", () => goToPage(state.currentPage + 1));
els.mPrevBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
els.mNextBtn.addEventListener("click", () => goToPage(state.currentPage + 1));
els.pageInput.addEventListener("change", () =>
  goToPage(parseInt(els.pageInput.value || "1", 10))
);

els.pageStage.addEventListener("click", (e) => {
  if (!state.fileId || state.tool !== "text") return;
  const rect = els.pageStage.getBoundingClientRect();
  const xNorm = (e.clientX - rect.left) / rect.width;
  const yNorm = (e.clientY - rect.top) / rect.height;

  const text = prompt("Digite o texto:");
  if (!text || !text.trim()) return;

  const id = `txt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  state.freeTexts.push({
    id,
    page: state.currentPage,
    x: Math.max(0, Math.min(1, xNorm)),
    y: Math.max(0, Math.min(1, yNorm)),
    text: text.trim(),
    font_size: 11,
  });
  pushHistory({ type: "text", id });
  renderFreeTextsOverlay();
  scheduleAutosave();
});

els.drawCanvas.addEventListener("mousedown", startDraw);
els.drawCanvas.addEventListener("mousemove", moveDraw);
window.addEventListener("mouseup", endDraw);
els.drawCanvas.addEventListener("touchstart", startDraw, { passive: false });
els.drawCanvas.addEventListener("touchmove", moveDraw, { passive: false });
window.addEventListener("touchend", endDraw);
window.addEventListener("beforeunload", () => {
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