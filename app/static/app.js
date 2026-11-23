// ============================================================================
// 1. ESTADO E REFERÊNCIAS DE DOM
// ============================================================================

const state = {
  fileId: null,
  filename: "",
  totalPages: 1,
  currentPage: 1,
  pages: [],
  docScripts: [],
  zoom: 1.0,
  tool: "fields", // "fields" | "text" | "draw"
  fieldValues: {}, // field.id -> valor atual
  fieldMeta: {}, // field.id -> { id, name, label, type, calc_script, page }
  nameToFieldIds: {}, // field.name -> [field.id]
  lastEngineByName: {}, // field.name -> último valor conhecido pelo motor
  freeTexts: [], // { id, page, x, y, text, font_size }
  strokes: [], // { id, page, points: [{ x, y }] }
  history: [], // { type: "text" | "stroke", id }
  isDrawing: false,
  currentStroke: null,
  autosaveTimer: null,
  evalTimer: null,
  evalInFlight: false,
  evalPending: false,
  evalRerenderPending: false,
};

let lastPageUrl = null;

const els = {
  pdfInput: document.getElementById("pdfInput"),
  pdfInputEmpty: document.getElementById("pdfInputEmpty"),
  statusText: document.getElementById("statusText"),
  backBtn: document.getElementById("backBtn"),
  fileNameLabel: document.getElementById("fileNameLabel"),
  toolbarCenter: document.getElementById("toolbarCenter"),
  mobileSubbar: document.getElementById("mobileSubbar"),
  actionsRight: document.getElementById("actionsRight"),
  flattenWrap: document.getElementById("flattenWrap"),
  flattenCheckbox: document.getElementById("flattenCheckbox"),
  saveBtn: document.getElementById("saveBtn"),
  exportBtn: document.getElementById("exportBtn"),
  toastBanner: document.getElementById("toastBanner"),
  emptyState: document.getElementById("emptyState"),
  pageStage: document.getElementById("pageStage"),
  pageImage: document.getElementById("pageImage"),
  widgetsLayer: document.getElementById("widgetsLayer"),
  drawCanvas: document.getElementById("drawCanvas"),
  freeTextsLayer: document.getElementById("freeTextsLayer"),
  pageInput: document.getElementById("pageInput"),
  totalPagesLabel: document.getElementById("totalPagesLabel"),
  prevPageBtn: document.getElementById("prevPageBtn"),
  nextPageBtn: document.getElementById("nextPageBtn"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  zoomLabel: document.getElementById("zoomLabel"),
  toolCursorBtn: document.getElementById("toolCursorBtn"),
  toolTextBtn: document.getElementById("toolTextBtn"),
  toolDrawBtn: document.getElementById("toolDrawBtn"),
  undoBtn: document.getElementById("undoBtn"),
  mPrevBtn: document.getElementById("mPrevBtn"),
  mNextBtn: document.getElementById("mNextBtn"),
  mPageLabel: document.getElementById("mPageLabel"),
  mZoomIn: document.getElementById("mZoomIn"),
  mZoomOut: document.getElementById("mZoomOut"),
  mZoomLabel: document.getElementById("mZoomLabel"),
  mToolFields: document.getElementById("mToolFields"),
  mToolText: document.getElementById("mToolText"),
  mToolDraw: document.getElementById("mToolDraw"),
  mUndo: document.getElementById("mUndo"),
};

// ============================================================================
// 2. AVALIAÇÃO E RECÁLCULO VIA MOTOR RUST (/api/evaluate)
// ============================================================================

function normalizeFieldValueForCompare(type, val) {
  if (type === "CheckBox") return Boolean(val);
  return String(val ?? "");
}

function indexFieldsMetadata() {
  state.fieldMeta = {};
  state.nameToFieldIds = {};
  state.lastEngineByName = {};

  for (const p of state.pages || []) {
    for (const f of p.fields || []) {
      state.fieldMeta[f.id] = { ...f, page: p.page };
      const fname = String(f.name || "");
      if (fname) {
        if (!state.nameToFieldIds[fname]) state.nameToFieldIds[fname] = [];
        if (!state.nameToFieldIds[fname].includes(f.id)) {
          state.nameToFieldIds[fname].push(f.id);
        }
        if (!(fname in state.lastEngineByName)) {
          state.lastEngineByName[fname] = normalizeFieldValueForCompare(f.type, f.value);
        }
      }
    }
  }
}

function buildPayloadByFieldName({ onlyDirty = false } = {}) {
  const out = {};
  const grouped = {};

  for (const [fid, meta] of Object.entries(state.fieldMeta)) {
    const fname = String(meta?.name || "");
    if (!fname) continue;
    const normVal = normalizeFieldValueForCompare(meta.type, state.fieldValues[fid]);
    grouped[fname] = normVal;
  }

  for (const [fname, normVal] of Object.entries(grouped)) {
    if (!onlyDirty) {
      out[fname] = normVal;
      continue;
    }
    const prevKnown = state.lastEngineByName[fname];
    if (prevKnown !== normVal) {
      out[fname] = normVal;
    }
  }

  return out;
}

function syncDomInputsWithState(changedIds) {
  if (!changedIds || !changedIds.size) return;
  const activeEl = document.activeElement;
  const inputs = els.widgetsLayer.querySelectorAll("[data-field-id]");
  for (const el of inputs) {
    const fid = el.getAttribute("data-field-id");
    if (!fid || !changedIds.has(fid)) continue;
    if (el === activeEl) continue;

    if (el.type === "checkbox") {
      el.checked = Boolean(state.fieldValues[fid]);
    } else {
      const nextVal = state.fieldValues[fid] ?? "";
      if (el.value !== String(nextVal)) {
        el.value = String(nextVal);
      }
    }
  }
}

async function evaluateWithEngine({ rerenderPage = true, onlyDirty = true } = {}) {
  if (!state.fileId) return;

  const payloadFields = buildPayloadByFieldName({ onlyDirty });
  if (onlyDirty && Object.keys(payloadFields).length === 0) {
    return;
  }

  if (state.evalInFlight) {
    state.evalPending = true;
    state.evalRerenderPending = state.evalRerenderPending || rerenderPage;
    return;
  }

  state.evalInFlight = true;
  state.evalPending = false;
  const shouldRerender = rerenderPage || state.evalRerenderPending;
  state.evalRerenderPending = false;

  try {
    const res = await fetch("/api/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: state.fileId,
        fields: payloadFields,
      }),
    });

    const rawText = await res.text();
    if (!res.ok) {
      console.warn("Falha no /api/evaluate:", res.status, rawText);
      return;
    }

    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch (_) {
      console.warn("Resposta não-JSON em /api/evaluate:", rawText);
      return;
    }

    const engineFields = data?.fields;
    if (!engineFields || typeof engineFields !== "object") return;

    const activeFid = document.activeElement?.getAttribute?.("data-field-id") || null;
    const changedIds = new Set();

    for (const [fname, rawVal] of Object.entries(engineFields)) {
      const fids = state.nameToFieldIds[fname] || [];
      const firstMeta = fids.length ? state.fieldMeta[fids[0]] : null;
      const engineNorm = normalizeFieldValueForCompare(firstMeta?.type, rawVal);
      state.lastEngineByName[fname] = engineNorm;

      for (const fid of fids) {
        if (fid === activeFid) continue;
        const meta = state.fieldMeta[fid];
        const nextVal = normalizeFieldValueForCompare(meta?.type, rawVal);
        const prevVal = normalizeFieldValueForCompare(meta?.type, state.fieldValues[fid]);

        if (nextVal !== prevVal) {
          state.fieldValues[fid] = nextVal;
          changedIds.add(fid);
        }
      }
    }

    if (changedIds.size > 0) {
      syncDomInputsWithState(changedIds);
      scheduleAutosave();
      if (shouldRerender) {
        await loadAndRenderPage();
      }
    }
  } catch (err) {
    console.warn("Erro ao avaliar campos:", err);
  } finally {
    state.evalInFlight = false;
    if (state.evalPending) {
      const nextRerender = state.evalRerenderPending;
      state.evalPending = false;
      state.evalRerenderPending = false;
      await evaluateWithEngine({ rerenderPage: nextRerender, onlyDirty: true });
    }
  }
}

function scheduleEvaluate(delayMs = 220) {
  if (!state.fileId) return;
  clearTimeout(state.evalTimer);
  state.evalTimer = setTimeout(() => {
    evaluateWithEngine({ rerenderPage: true, onlyDirty: true });
  }, delayMs);
}

// ============================================================================
// 3. PERSISTÊNCIA LOCAL (RASCUNHO) E TOASTS
// ============================================================================

function showToast(msg) {
  els.toastBanner.textContent = msg;
  els.toastBanner.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toastBanner.classList.add("hidden");
  }, 1800);
}

function getStorageKey() {
  return `fast_pdfedit_draft_${state.filename}_${state.totalPages}`;
}

function saveProgress(notify = false) {
  if (!state.filename) return;
  try {
    const payload = {
      fieldValues: state.fieldValues,
      freeTexts: state.freeTexts,
      strokes: state.strokes,
      currentPage: state.currentPage,
      savedAt: Date.now(),
    };
    localStorage.setItem(getStorageKey(), JSON.stringify(payload));
    if (notify) showToast("Progresso salvo! Você pode continuar editando.");
  } catch (_) {
    // Ignora caso localStorage esteja indisponível ou cheio
  }
}

function scheduleAutosave() {
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(() => saveProgress(false), 600);
}

function loadSavedProgress() {
  try {
    const raw = localStorage.getItem(getStorageKey());
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (data.fieldValues) {
      state.fieldValues = { ...state.fieldValues, ...data.fieldValues };
    }
    if (Array.isArray(data.freeTexts)) state.freeTexts = data.freeTexts;
    if (Array.isArray(data.strokes)) state.strokes = data.strokes;
    if (data.currentPage) {
      state.currentPage = Math.max(1, Math.min(state.totalPages, Number(data.currentPage)));
    }
    return true;
  } catch (_) {
    return false;
  }
}

els.saveBtn.addEventListener("click", () => saveProgress(true));

els.backBtn.addEventListener("click", () => {
  clearTimeout(state.evalTimer);
  saveProgress(false);
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

// ============================================================================
// 4. ABERTURA DE PDF, NAVEGAÇÃO, ZOOM E FERRAMENTAS
// ============================================================================

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
  state.evalInFlight = false;
  state.evalPending = false;
  state.evalRerenderPending = false;

  els.statusText.textContent = "Carregando documento...";
  els.exportBtn.disabled = true;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/inspect", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Erro ao abrir PDF");

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
    await loadAndRenderPage();

    if (restored) {
      showToast("Rascunho anterior restaurado.");
      void evaluateWithEngine({ rerenderPage: true, onlyDirty: true });
    }
  } catch (err) {
    els.statusText.textContent = `Erro: ${err.message}`;
  }
}

els.pdfInput.addEventListener("change", (e) => handleFileSelected(e.target.files?.[0]));
els.pdfInputEmpty.addEventListener("change", (e) => handleFileSelected(e.target.files?.[0]));

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

els.toolCursorBtn.addEventListener("click", () => setTool("fields"));
els.toolTextBtn.addEventListener("click", () => setTool("text"));
els.toolDrawBtn.addEventListener("click", () => setTool("draw"));
els.undoBtn.addEventListener("click", undoLastAction);

els.mToolFields.addEventListener("click", () => setTool("fields"));
els.mToolText.addEventListener("click", () => setTool("text"));
els.mToolDraw.addEventListener("click", () => setTool("draw"));
els.mUndo.addEventListener("click", undoLastAction);

function setZoom(val) {
  state.zoom = Math.max(0.5, Math.min(2.2, Number(val.toFixed(2))));
  const pct = `${Math.round(state.zoom * 100)}%`;
  els.zoomLabel.textContent = pct;
  els.mZoomLabel.textContent = pct;
  applyStageLayout();
}

els.zoomInBtn.addEventListener("click", () => setZoom(state.zoom + 0.15));
els.zoomOutBtn.addEventListener("click", () => setZoom(state.zoom - 0.15));
els.mZoomIn.addEventListener("click", () => setZoom(state.zoom + 0.15));
els.mZoomOut.addEventListener("click", () => setZoom(state.zoom - 0.15));

async function goToPage(p) {
  if (!state.fileId) return;
  const clamped = Math.max(1, Math.min(state.totalPages, p));
  state.currentPage = clamped;
  scheduleAutosave();
  await loadAndRenderPage();
}

els.prevPageBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
els.nextPageBtn.addEventListener("click", () => goToPage(state.currentPage + 1));
els.mPrevBtn.addEventListener("click", () => goToPage(state.currentPage - 1));
els.mNextBtn.addEventListener("click", () => goToPage(state.currentPage + 1));
els.pageInput.addEventListener("change", () =>
  goToPage(parseInt(els.pageInput.value || "1", 10))
);

function updatePageLabels() {
  els.pageInput.value = String(state.currentPage);
  els.mPageLabel.textContent = `${state.currentPage} / ${state.totalPages}`;
}

async function loadAndRenderPage() {
  if (!state.fileId) return;
  updatePageLabels();

  const dpi = state.zoom > 1.25 ? 200 : 150;
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: state.fileId, page: state.currentPage, dpi }),
  });
  if (!res.ok) return;

  const blob = await res.blob();
  const nextUrl = URL.createObjectURL(blob);
  els.pageImage.onload = () => {
    applyStageLayout();
    if (lastPageUrl) {
      URL.revokeObjectURL(lastPageUrl);
    }
    lastPageUrl = nextUrl;
  };
  els.pageImage.src = nextUrl;
}

// ============================================================================
// 5. WIDGETS DO FORMULÁRIO, TEXTO LIVRE, DESENHO E EXPORTAÇÃO
// ============================================================================

function applyStageLayout() {
  const pageObj = state.pages.find((p) => p.page === state.currentPage);
  const baseWidth = pageObj?.width || 595;
  const baseHeight = pageObj?.height || 842;

  const renderedW = Math.round(baseWidth * state.zoom);
  const renderedH = Math.round(baseHeight * state.zoom);

  els.pageStage.style.width = `${renderedW}px`;
  els.pageStage.style.height = `${renderedH}px`;
  els.pageImage.style.width = `${renderedW}px`;
  els.pageImage.style.height = `${renderedH}px`;

  els.drawCanvas.width = renderedW;
  els.drawCanvas.height = renderedH;

  renderWidgetsOverlay(renderedW, renderedH, pageObj?.fields || []);
  renderFreeTextsOverlay();
  redrawStrokesCanvas();
}

function renderWidgetsOverlay(w, h, fields) {
  els.widgetsLayer.innerHTML = "";
  for (const f of fields) {
    const [x0, y0, x1, y1] = f.rect || [0, 0, 0, 0];
    const left = Math.round(x0 * w);
    const top = Math.round(y0 * h);
    const width = Math.max(10, Math.round((x1 - x0) * w));
    const height = Math.max(10, Math.round((y1 - y0) * h));

    if (f.type === "CheckBox") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "pdf-widget-checkbox";
      cb.dataset.fieldId = f.id;
      cb.checked = Boolean(state.fieldValues[f.id]);
      const boxSize = Math.min(22, Math.max(12, Math.min(width, height)));
      cb.style.left = `${left + Math.max(0, (width - boxSize) / 2)}px`;
      cb.style.top = `${top + Math.max(0, (height - boxSize) / 2)}px`;
      cb.style.width = `${boxSize}px`;
      cb.style.height = `${boxSize}px`;
      cb.addEventListener("change", () => {
        state.fieldValues[f.id] = cb.checked;
        scheduleAutosave();
        scheduleEvaluate(60);
      });
      els.widgetsLayer.appendChild(cb);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "pdf-widget-input";
      inp.dataset.fieldId = f.id;
      inp.value = state.fieldValues[f.id] ?? "";
      inp.title = f.label || f.name;
      inp.style.left = `${left}px`;
      inp.style.top = `${top}px`;
      inp.style.width = `${width}px`;
      inp.style.height = `${height}px`;
      inp.style.fontSize = `${Math.max(8, Math.min(18, height * 0.68))}px`;
      inp.style.textAlign = width <= 45 ? "center" : "left";
      inp.addEventListener("input", () => {
        state.fieldValues[f.id] = inp.value;
        scheduleAutosave();
        scheduleEvaluate(220);
      });
      inp.addEventListener("blur", () => {
        scheduleEvaluate(0);
      });
      els.widgetsLayer.appendChild(inp);
    }
  }
}

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

function renderFreeTextsOverlay() {
  els.freeTextsLayer.innerHTML = "";
  const items = state.freeTexts.filter((t) => t.page === state.currentPage);
  for (const t of items) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.left = `${t.x * 100}%`;
    el.style.top = `${t.y * 100}%`;
    el.style.fontSize = `${Math.max(9, t.font_size * state.zoom)}px`;
    el.className = "text-blue-900 font-medium whitespace-nowrap leading-none";
    el.textContent = t.text;
    els.freeTextsLayer.appendChild(el);
  }
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

els.drawCanvas.addEventListener("mousedown", startDraw);
els.drawCanvas.addEventListener("mousemove", moveDraw);
window.addEventListener("mouseup", endDraw);
els.drawCanvas.addEventListener("touchstart", startDraw, { passive: false });
els.drawCanvas.addEventListener("touchmove", moveDraw, { passive: false });
window.addEventListener("touchend", endDraw);

function redrawStrokesCanvas() {
  const ctx = els.drawCanvas.getContext("2d");
  const w = els.drawCanvas.width;
  const h = els.drawCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const pageStrokes = state.strokes.filter((s) => s.page === state.currentPage);
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

els.exportBtn.addEventListener("click", async () => {
  if (!state.fileId) return;
  clearTimeout(state.evalTimer);
  await evaluateWithEngine({ rerenderPage: false, onlyDirty: true });
  saveProgress(false);
  els.exportBtn.disabled = true;
  const prev = els.exportBtn.textContent;
  els.exportBtn.textContent = "Salvando...";

  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file_id: state.fileId,
        fields: buildPayloadByFieldName({ onlyDirty: false }),
        free_texts: state.freeTexts,
        strokes: state.strokes,
        flatten: els.flattenCheckbox.checked,
      }),
    });
    if (!res.ok) throw new Error("Falha ao exportar");

    const blob = await res.blob();
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