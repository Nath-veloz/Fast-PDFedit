from pathlib import Path
import re
from threading import Lock
import time
from typing import Any, Dict, List
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.pdf_engine import (
    PdfEngineError,
    build_filled_pdf,
    evaluate_fields,
    inspect_pdf,
    render_page_png,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Fast-PDFedit API")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Cache temporário em memória: file_id -> {"bytes": bytes, "filename": str, "created_at": float}
PDF_STORE: Dict[str, Dict[str, Any]] = {}
STORE_LOCK = Lock()
MAX_STORED_FILES = 50
TTL_SECONDS = 3600  # 1 hora
MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB


class RenderRequest(BaseModel):
    file_id: str
    page: int = 1
    dpi: int = 150


class EvaluateRequest(BaseModel):
    file_id: str
    fields: Dict[str, Any] = {}


class FreeTextItem(BaseModel):
    page: int
    x: float
    y: float
    text: str
    font_size: float = 11.0


class StrokePoint(BaseModel):
    x: float
    y: float


class StrokeItem(BaseModel):
    page: int
    points: List[StrokePoint] = []


class ExportRequest(BaseModel):
    file_id: str
    fields: Dict[str, Any] = {}
    free_texts: List[FreeTextItem] = []
    strokes: List[StrokeItem] = []
    flatten: bool = True


def _cleanup_store_locked(now: float) -> None:
    expired = [k for k, v in PDF_STORE.items() if now - v["created_at"] > TTL_SECONDS]
    for k in expired:
        del PDF_STORE[k]

    while len(PDF_STORE) > MAX_STORED_FILES:
        oldest_key = next(iter(PDF_STORE))
        del PDF_STORE[oldest_key]


def _get_entry_or_404(file_id: str) -> Dict[str, Any]:
    now = time.time()
    with STORE_LOCK:
        _cleanup_store_locked(now)
        entry = PDF_STORE.get(file_id)
        if not entry:
            raise HTTPException(status_code=404, detail="Arquivo não encontrado ou sessão expirada.")
        entry["created_at"] = now
        return entry


def _safe_download_name(original_name: str) -> str:
    stem = Path(original_name or "documento").stem
    clean = re.sub(r"[^A-Za-z0-9._-]", "_", stem).strip("_") or "documento"
    return f"{clean}-editado.pdf"


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/inspect")
async def api_inspect(file: UploadFile = File(...)) -> Dict[str, Any]:
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Envie um arquivo PDF válido.")

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="O arquivo PDF está vazio.")

    if len(pdf_bytes) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="O arquivo PDF excede o limite de 25 MB.")

    try:
        info = inspect_pdf(pdf_bytes)
    except PdfEngineError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    file_id = str(uuid4())
    now = time.time()
    with STORE_LOCK:
        _cleanup_store_locked(now)
        PDF_STORE[file_id] = {
            "bytes": pdf_bytes,
            "filename": file.filename,
            "created_at": now,
        }
        _cleanup_store_locked(now)

    return {"file_id": file_id, "filename": file.filename, **info}


@app.post("/api/render")
def api_render(req: RenderRequest) -> Response:
    entry = _get_entry_or_404(req.file_id)
    safe_dpi = max(72, min(req.dpi, 220))
    try:
        png_bytes = render_page_png(entry["bytes"], page_number=req.page, dpi=safe_dpi)
    except PdfEngineError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(content=png_bytes, media_type="image/png")


@app.post("/api/evaluate")
def api_evaluate(req: EvaluateRequest) -> Dict[str, Any]:
    entry = _get_entry_or_404(req.file_id)
    try:
        updated_fields, updated_pdf = evaluate_fields(entry["bytes"], field_values=req.fields)
    except PdfEngineError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    with STORE_LOCK:
        if req.file_id in PDF_STORE:
            PDF_STORE[req.file_id]["bytes"] = updated_pdf
            PDF_STORE[req.file_id]["created_at"] = time.time()

    return {"ok": True, "fields": updated_fields}


@app.delete("/api/session/{file_id}")
def api_close_session(file_id: str) -> Dict[str, Any]:
    with STORE_LOCK:
        removed = PDF_STORE.pop(file_id, None) is not None
    return {"ok": True, "removed": removed}


@app.post("/api/export")
def api_export(req: ExportRequest) -> Response:
    entry = _get_entry_or_404(req.file_id)
    try:
        out_bytes = build_filled_pdf(
            pdf_bytes=entry["bytes"],
            field_values=req.fields,
            free_texts=[item.model_dump() for item in req.free_texts],
            strokes=[item.model_dump() for item in req.strokes],
            flatten=req.flatten,
        )
    except PdfEngineError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    download_name = _safe_download_name(entry["filename"])
    return Response(
        content=out_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )