import { state, els } from "./state.js";

export function showToast(msg) {
  els.toastBanner.textContent = msg;
  els.toastBanner.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    els.toastBanner.classList.add("hidden");
  }, 1800);
}

function getFieldsSignature() {
  const names = Object.keys(state.fieldMeta || {}).map((fid) => state.fieldMeta[fid]?.name || "");
  names.sort();
  const raw = names.join("|");
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function getStorageKey() {
  return `fast_pdfedit_draft_${state.filename}_${state.totalPages}_${getFieldsSignature()}`;
}

export function saveProgress(notify = false) {
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

export function clearSavedProgress() {
  if (!state.filename) return;
  try {
    localStorage.removeItem(getStorageKey());
  } catch (_) {
    // Ignora erros de storage
  }
}

export function scheduleAutosave() {
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(() => saveProgress(false), 600);
}

export function loadSavedProgress() {
  try {
    const raw = localStorage.getItem(getStorageKey());
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (data.fieldValues && typeof data.fieldValues === "object") {
      for (const [fid, val] of Object.entries(data.fieldValues)) {
        if (Object.prototype.hasOwnProperty.call(state.fieldValues, fid)) {
          state.fieldValues[fid] = val;
        }
      }
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