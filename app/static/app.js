const state = {
  fileId: null,
  filename: "",
  totalPages: 1,
  currentPage: 1,
  pages: [],
  docScripts: [],
  zoom: 1.0,
  tool: "fields", // "fields" | "text" | "draw"
  fieldValues: {},
  fieldMeta: {}, // field.id -> { id, name, label, type, calc_script, page }
  keyToFieldIds: {}, // chave normalizada (name/label/id) -> [field.id]
  freeTexts: [], // { id, page, x, y, text, font_size }
  strokes: [], // { id, page, points: [{ x, y }] }
  history: [], // { type: "text" | "stroke", id }
  isDrawing: false,
  currentStroke: null,
  autosaveTimer: null,
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

function normalizeKey(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function toNumber(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  if (typeof val === "boolean") return val ? 1 : 0;
  const cleaned = String(val ?? "")
    .replace(",", ".")
    .replace(/[^0-9.-]+/g, " ")
    .trim()
    .split(/\s+/)[0];
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function indexFieldsMetadata() {
  state.fieldMeta = {};
  state.keyToFieldIds = {};

  for (const p of state.pages || []) {
    for (const f of p.fields || []) {
      state.fieldMeta[f.id] = { ...f, page: p.page };
      const candidates = [f.id, f.name, f.label];
      for (const cand of candidates) {
        const k = normalizeKey(cand);
        if (!k) continue;
        if (!state.keyToFieldIds[k]) state.keyToFieldIds[k] = [];
        if (!state.keyToFieldIds[k].includes(f.id)) {
          state.keyToFieldIds[k].push(f.id);
        }
      }
    }
  }
}

function getFieldValueByKey(rawKey) {
  const k = normalizeKey(rawKey);
  const ids = state.keyToFieldIds[k];
  if (!ids || !ids.length) return 0;
  const meta = state.fieldMeta[ids[0]];
  const rawVal = state.fieldValues[ids[0]];
  if (meta?.type === "CheckBox") return Boolean(rawVal) ? 1 : 0;
  return toNumber(rawVal);
}

function safeEvalMathExpr(expr) {
  const candidate = expr
    .replace(/\bMath\.(floor|ceil|round|abs|max|min)\b/g, "__MATH_$1__")
    .replace(/\b(floor|ceil|round|abs|max|min)\b/g, "__MATH_$1__");

  const stripped = candidate
    .replace(/__MATH_(floor|ceil|round|abs|max|min)__/g, "")
    .replace(/[0-9+\-*/().,\s]/g, "");

  if (stripped.length > 0) return null;

  const jsExpr = candidate.replace(/__MATH_(floor|ceil|round|abs|max|min)__/g, "Math.$1");
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${jsExpr});`);
    const res = fn();
    if (typeof res === "number" && Number.isFinite(res)) {
      return Number.isInteger(res) ? String(res) : String(Number(res.toFixed(2)));
    }
    return null;
  } catch (_) {
    return null;
  }
}

function inferAttributeModifier(targetField) {
  const key = normalizeKey(targetField.name || targetField.label || "");
  const modMatch =
    key.match(/^(?:mod_?|modificador_?(?:de)?_?)([a-z0-9]+)$/) ||
    key.match(/^([a-z0-9]+)_?(?:mod|modificador)$/);
  if (!modMatch) return null;

  const attrKey = modMatch[1];
  const attrIds = state.keyToFieldIds[attrKey];
  if (!attrIds || !attrIds.length || attrIds.includes(targetField.id)) return null;

  const attrVal = toNumber(state.fieldValues[attrIds[0]]);
  return String(Math.floor((attrVal - 10) / 2));
}

function evaluateCalcScriptForTarget(script, targetField) {
  if (!script || typeof script !== "string") return null;

  const afMatch = script.match(
    /AFSimple_Calculate\s*\(\s*["']([A-Z]+)["']\s*,\s*\[([^\]]*)\]\s*\)/i
  );
  if (afMatch) {
    const mode = afMatch[1].toUpperCase();
    const fieldNames = Array.from(afMatch[2].matchAll(/["']([^"']+)["']/g)).map((m) => m[1]);
    const nums = fieldNames.map((name) => getFieldValueByKey(name));
    if (!nums.length) return null;
    if (mode === "SUM") return String(nums.reduce((a, b) => a + b, 0));
    if (mode === "PRD") return String(nums.reduce((a, b) => a * b, 1));
    if (mode === "AVG") {
      return String(Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)));
    }
  }

  let expr = script;
  const assignMatch = script.match(/event\.value\s*=\s*([\s\S]*?)(?:;|$)/);
  if (assignMatch) {
    expr = assignMatch[1].trim();
  } else if (/function\s*\(/.test(script) || /\bif\s*\(/.test(script)) {
    return null;
  }

  expr = expr.replace(
    /(?:this\.)?getField\s*\(\s*["']([^"']+)["']\s*\)(?:\.value)?/g,
    (_, fieldName) => String(getFieldValueByKey(fieldName))
  );

  const selfId = targetField.id;
  expr = expr.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (token) => {
    if (["Math", "floor", "ceil", "round", "abs", "max", "min", "event", "value"].includes(token)) {
      return token;
    }
    const ids = state.keyToFieldIds[normalizeKey(token)];
    if (ids && ids.length && !ids.includes(selfId)) {
      return String(getFieldValueByKey(token));
    }
    return token;
  });

  return safeEvalMathExpr(expr);
}

function syncDomInputsWithState(changedIds) {
  if (!changedIds.size) return;
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

function recalculateFields(maxPasses = 3) {
  const allFields = Object.values(state.fieldMeta);
  if (!allFields.length) return;

  const updatedIds = new Set();

  for (let pass = 0; pass < maxPasses; pass++) {
    let anyChanged = false;
    for (const f of allFields) {
      if (f.type === "CheckBox") continue;

      let computed = null;
      if (f.calc_script) {
        computed = evaluateCalcScriptForTarget(f.calc_script, f);
      }
      if (computed === null) {
        computed = inferAttributeModifier(f);
      }

      if (computed !== null && String(state.fieldValues[f.id] ?? "") !== computed) {
        state.fieldValues[f.id] = computed;
        updatedIds.add(f.id);
        anyChanged = true;
      }
    }
    if (!anyChanged) break;
  }

  syncDomInputsWithState(updatedIds);
}

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
    recalculateFields();

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

    if (restored) {
      showToast("Rascunho anterior restaurado.");
    }

    setTool("fields");
    await loadAndRenderPage();
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
        recalculateFields();
        scheduleAutosave();
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
        recalculateFields();
        scheduleAutosave();
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
  recalculateFields();
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
        fields: state.fieldValues,
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