export function closeServerSession(fileId) {
  if (!fileId) return;
  const url = `/api/session/${encodeURIComponent(fileId)}`;
  try {
    fetch(url, { method: "DELETE", keepalive: true }).catch(() => {});
  } catch (_) {
    // Ignora falhas de rede no fechamento
  }
}

export async function inspectPdfFile(file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch("/api/inspect", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Erro ao abrir PDF");
  return data;
}

export async function renderPdfPage(fileId, page, dpi) {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId, page, dpi }),
  });
  if (!res.ok) return null;
  return res.blob();
}

export async function evaluatePdfFields(fileId, fields) {
  const res = await fetch("/api/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      file_id: fileId,
      fields,
    }),
  });
  const rawText = await res.text();
  if (!res.ok) {
    console.warn("Falha no /api/evaluate:", res.status, rawText);
    return null;
  }
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch (_) {
    console.warn("Resposta não-JSON em /api/evaluate:", rawText);
    return null;
  }
}

export async function exportFilledPdf(payload) {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Falha ao exportar");
  return res.blob();
}