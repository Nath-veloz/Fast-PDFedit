export const state = {
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
  lastPageUrl: null,
};

export const els = {
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

export function normalizeFieldValueForCompare(type, val) {
  if (type === "CheckBox") return Boolean(val);
  return String(val ?? "");
}

export function indexFieldsMetadata() {
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

export function buildPayloadByFieldName({ onlyDirty = false } = {}) {
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