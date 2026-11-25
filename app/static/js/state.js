export const state = {
  fileId: null,
  filename: "",
  totalPages: 1,
  currentPage: 1,
  pages: [],
  docScripts: [],
  zoom: 1.0,
  tool: "fields", // "fields" | "text" | "draw"
  showFieldHints: false,
  fieldValues: {}, // field.id -> valor atual
  fieldMeta: {}, // field.id -> { id, name, label, type, calc_script, page }
  nameToFieldIds: {}, // field.name -> [field.id]
  lastEngineByName: {}, // field.name -> último valor conhecido pelo motor
  freeTexts: [], // { id, page, x, y, text, font_size }
  strokes: [], // { id, page, points: [{ x, y }] }
  history: [], // { type: "text" | "stroke" | "field", ... }
  redoStack: [], // ações desfeitas para refazer
  isDrawing: false,
  currentStroke: null,
  autosaveTimer: null,
  evalTimer: null,
  evalInFlight: false,
  evalPending: false,
  evalRerenderPending: false,
  evalForceFullPending: false,
  pageUrls: {}, // pageNum -> objectUrl
  pageRenderMeta: {}, // pageNum -> { fileId, dpi }
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
  pagesContainer: document.getElementById("pagesContainer"),
  zoomInBtn: document.getElementById("zoomInBtn"),
  zoomOutBtn: document.getElementById("zoomOutBtn"),
  zoomLabel: document.getElementById("zoomLabel"),
  toolCursorBtn: document.getElementById("toolCursorBtn"),
  toggleHintsBtn: document.getElementById("toggleHintsBtn"),
  toolTextBtn: document.getElementById("toolTextBtn"),
  toolDrawBtn: document.getElementById("toolDrawBtn"),
  undoBtn: document.getElementById("undoBtn"),
  redoBtn: document.getElementById("redoBtn"),
  mZoomIn: document.getElementById("mZoomIn"),
  mZoomOut: document.getElementById("mZoomOut"),
  mZoomLabel: document.getElementById("mZoomLabel"),
  mToolFields: document.getElementById("mToolFields"),
  mToggleHints: document.getElementById("mToggleHints"),
  mToolText: document.getElementById("mToolText"),
  mToolDraw: document.getElementById("mToolDraw"),
  mUndo: document.getElementById("mUndo"),
  mRedo: document.getElementById("mRedo"),
};

export function normalizeFieldValueForCompare(type, val) {
  if (type === "CheckBox") return Boolean(val);
  return String(val ?? "");
}

export function indexFieldsMetadata() {
  state.fieldMeta = {};
  state.nameToFieldIds = {};
  state.lastEngineByName = {};
  state.fieldValues = {};

  for (const p of state.pages || []) {
    for (const f of p.fields || []) {
      const initialVal = normalizeFieldValueForCompare(f.type, f.value);
      state.fieldMeta[f.id] = { ...f, page: p.page };
      state.fieldValues[f.id] = initialVal;

      const fname = String(f.name || "");
      if (fname) {
        if (!state.nameToFieldIds[fname]) state.nameToFieldIds[fname] = [];
        if (!state.nameToFieldIds[fname].includes(f.id)) {
          state.nameToFieldIds[fname].push(f.id);
        }
        if (!(fname in state.lastEngineByName)) {
          state.lastEngineByName[fname] = initialVal;
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