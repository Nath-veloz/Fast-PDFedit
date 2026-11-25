import {
  state,
  normalizeFieldValueForCompare,
  buildPayloadByFieldName,
} from "./state.js";
import { evaluatePdfFields } from "./api.js";
import { scheduleAutosave } from "./draft.js";

function syncDomInputsWithState(changedIds) {
  if (!changedIds || !changedIds.size) return;
  const activeEl = document.activeElement;
  const root = document.getElementById("pagesContainer") || document;
  const inputs = root.querySelectorAll("[data-field-id]");

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

export async function evaluateWithEngine(
  { rerenderPage = false, onlyDirty = true } = {},
  onRerender = null
) {
  if (!state.fileId) return;

  if (state.evalInFlight) {
    state.evalPending = true;
    state.evalRerenderPending = state.evalRerenderPending || rerenderPage;
    state.evalForceFullPending = state.evalForceFullPending || !onlyDirty;
    return;
  }

  state.evalInFlight = true;
  state.evalPending = false;
  const shouldRerender = rerenderPage || state.evalRerenderPending;
  const effectiveOnlyDirty = onlyDirty && !state.evalForceFullPending;
  state.evalRerenderPending = false;
  state.evalForceFullPending = false;

  try {
    const payloadFields = buildPayloadByFieldName({ onlyDirty: effectiveOnlyDirty });
    if (effectiveOnlyDirty && Object.keys(payloadFields).length === 0) {
      if (shouldRerender && typeof onRerender === "function") {
        await onRerender();
      }
      return;
    }

    const data = await evaluatePdfFields(state.fileId, payloadFields);
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
    }

    if (shouldRerender && typeof onRerender === "function") {
      await onRerender();
    }
  } catch (err) {
    console.warn("Erro ao avaliar campos:", err);
  } finally {
    state.evalInFlight = false;
    if (state.evalPending) {
      const nextRerender = state.evalRerenderPending;
      const nextOnlyDirty = !state.evalForceFullPending;
      state.evalPending = false;
      state.evalRerenderPending = false;
      state.evalForceFullPending = false;
      await evaluateWithEngine({ rerenderPage: nextRerender, onlyDirty: nextOnlyDirty }, onRerender);
    }
  }
}

export function scheduleEvaluate({ delayMs = 220, rerenderPage = false } = {}, onRerender = null) {
  if (!state.fileId) return;
  clearTimeout(state.evalTimer);
  state.evalTimer = setTimeout(() => {
    evaluateWithEngine({ rerenderPage, onlyDirty: true }, onRerender);
  }, delayMs);
}