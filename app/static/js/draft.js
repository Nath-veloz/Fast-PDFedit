import { state, els } from "./state.js";

export function showToast(msg) {
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

export function scheduleAutosave() {
  clearTimeout(state.autosaveTimer);
  state.autosaveTimer = setTimeout(() => saveProgress(false), 600);
}

export function loadSavedProgress() {
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