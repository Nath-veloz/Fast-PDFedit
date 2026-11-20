from pathlib import Path
import re
import time
from typing import Any, Dict, List
from uuid import uuid4

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.pdf_engine import build_filled_pdf, inspect_pdf, render_page_png

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Fast-PDFedit API")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Cache temporário em memória: file_id -> {"bytes": bytes, "filename": str, "created_at": float}
PDF_STORE: Dict[str, Dict[str, Any]] = {}
MAX_STORED_FILES = 50
TTL_SECONDS = 3600  # 1 hora
MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024  # 25 MB


class RenderRequest(BaseModel):
    file_id: str
    page: int = 1
    dpi: int = 150


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


def _cleanup_store() -> None:
    now = time.time()
    expired = [k for k, v in PDF_STORE.items() if now - v["created_at"] > TTL_SECONDS]
    for k in expired:
        del PDF_STORE[k]

    while len(PDF_STORE) > MAX_STORED_FILES:
        oldest_key = next(iter(PDF_STORE))
        del PDF_STORE[oldest_key]


def _get_entry_or_404(file_id: str) -> Dict[str, Any]:
    _cleanup_store()
    entry = PDF_STORE.get(file_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Arquivo não encontrado ou sessão expirada.")
    entry["created_at"] = time.time()
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
    _cleanup_store()
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Envie um arquivo PDF válido.")

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="O arquivo PDF está vazio.")

    if len(pdf_bytes) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="O arquivo PDF excede o limite de 25 MB.")

    file_id = str(uuid4())
    PDF_STORE[file_id] = {
        "bytes": pdf_bytes,
        "filename": file.filename,
        "created_at": time.time(),
    }
    _cleanup_store()

    info = inspect_pdf(pdf_bytes)
    return {"file_id": file_id, "filename": file.filename, **info}


@app.post("/api/render")
def api_render(req: RenderRequest) -> Response:
    entry = _get_entry_or_404(req.file_id)
    safe_dpi = max(72, min(req.dpi, 220))
    png_bytes = render_page_png(entry["bytes"], page_number=req.page, dpi=safe_dpi)
    return Response(content=png_bytes, media_type="image/png")


@app.post("/api/export")
def api_export(req: ExportRequest) -> Response:
    entry = _get_entry_or_404(req.file_id)
    out_bytes = build_filled_pdf(
        pdf_bytes=entry["bytes"],
        field_values=req.fields,
        free_texts=[item.model_dump() for item in req.free_texts],
        strokes=[item.model_dump() for item in req.strokes],
        flatten=req.flatten,
    )
    download_name = _safe_download_name(entry["filename"])
    return Response(
        content=out_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )