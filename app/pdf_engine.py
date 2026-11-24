import json
import os
from pathlib import Path
import subprocess
import tempfile
from typing import Any, Dict, List, Optional

PROBE_EXE = Path(os.environ.get("PDFCRAFT_PROBE_EXE", r"C:\cargo_target\pdfcraft_core\debug\pdfcraft_probe.exe"))
PROBE_TIMEOUT_SECONDS = 30


class PdfEngineError(RuntimeError):
    """Erro retornado pelo motor Rust pdfcraft-engine."""


def _ensure_probe_exists() -> None:
    if not PROBE_EXE.exists():
        raise PdfEngineError(f"Binário do motor não encontrado em: {PROBE_EXE}")


def _safe_unlink(path: Optional[Path]) -> None:
    if path is not None and path.exists():
        try:
            path.unlink()
        except OSError:
            pass


def _run_probe_json(pdf_bytes: bytes, args: Optional[List[str]] = None) -> Dict[str, Any]:
    _ensure_probe_exists()

    tmp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = Path(tmp.name)

        cmd = [str(PROBE_EXE), *(args or []), str(tmp_path)]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise PdfEngineError("Tempo limite excedido ao executar o motor PDF.") from exc
    finally:
        _safe_unlink(tmp_path)

    raw_out = (proc.stdout or "").strip()
    raw_err = (proc.stderr or "").strip()

    if proc.returncode != 0:
        detail = raw_err or raw_out or f"Código de saída {proc.returncode}"
        raise PdfEngineError(f"Falha no pdfcraft_probe: {detail}")

    if not raw_out:
        raise PdfEngineError("pdfcraft_probe não retornou saída JSON.")

    try:
        data = json.loads(raw_out)
    except json.JSONDecodeError as exc:
        raise PdfEngineError(f"Saída inválida do pdfcraft_probe: {exc}") from exc

    if isinstance(data, dict) and data.get("ok") is False:
        raise PdfEngineError(str(data.get("error") or "Erro desconhecido no motor PDF."))

    return data


def _run_probe_render(pdf_bytes: bytes, page_number: int, dpi: int) -> bytes:
    _ensure_probe_exists()

    tmp_pdf: Optional[Path] = None
    tmp_png: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as pdf_f:
            pdf_f.write(pdf_bytes)
            tmp_pdf = Path(pdf_f.name)

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as png_f:
            tmp_png = Path(png_f.name)

        cmd = [
            str(PROBE_EXE),
            "render",
            "--page",
            str(page_number),
            "--dpi",
            str(dpi),
            "--out",
            str(tmp_png),
            str(tmp_pdf),
        ]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT_SECONDS,
        )

        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip() or f"Código de saída {proc.returncode}"
            raise PdfEngineError(f"Falha ao renderizar PNG no pdfcraft_probe: {detail}")

        if not tmp_png.exists() or tmp_png.stat().st_size == 0:
            raise PdfEngineError("pdfcraft_probe não gerou o arquivo PNG esperado.")

        return tmp_png.read_bytes()
    except subprocess.TimeoutExpired as exc:
        raise PdfEngineError("Tempo limite excedido ao renderizar página PDF.") from exc
    finally:
        _safe_unlink(tmp_pdf)
        _safe_unlink(tmp_png)


def _run_probe_eval(pdf_bytes: bytes, field_values: Dict[str, Any]) -> tuple[Dict[str, Any], bytes]:
    _ensure_probe_exists()

    tmp_pdf: Optional[Path] = None
    tmp_json: Optional[Path] = None
    tmp_out: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as pdf_f:
            pdf_f.write(pdf_bytes)
            tmp_pdf = Path(pdf_f.name)

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w", encoding="utf-8") as js_f:
            json.dump(field_values or {}, js_f, ensure_ascii=False, separators=(",", ":"))
            tmp_json = Path(js_f.name)

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as out_f:
            tmp_out = Path(out_f.name)

        cmd = [
            str(PROBE_EXE),
            "eval",
            "--fields-json",
            str(tmp_json),
            "--out",
            str(tmp_out),
            str(tmp_pdf),
        ]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT_SECONDS,
        )

        raw_out = (proc.stdout or "").strip()
        raw_err = (proc.stderr or "").strip()

        if proc.returncode != 0:
            detail = raw_err or raw_out or f"Código de saída {proc.returncode}"
            raise PdfEngineError(f"Falha ao avaliar campos no pdfcraft_probe: {detail}")

        if not raw_out:
            raise PdfEngineError("pdfcraft_probe eval não retornou saída JSON.")

        try:
            payload = json.loads(raw_out)
        except json.JSONDecodeError as exc:
            raise PdfEngineError(f"Saída inválida do pdfcraft_probe eval: {exc}") from exc

        if isinstance(payload, dict) and payload.get("ok") is False:
            raise PdfEngineError(str(payload.get("error") or "Erro desconhecido no motor PDF."))

        if not tmp_out.exists() or tmp_out.stat().st_size == 0:
            raise PdfEngineError("pdfcraft_probe eval não gerou o arquivo PDF de saída.")

        fields_out = payload.get("fields") if isinstance(payload, dict) and isinstance(payload.get("fields"), dict) else {}
        return fields_out, tmp_out.read_bytes()
    except subprocess.TimeoutExpired as exc:
        raise PdfEngineError("Tempo limite excedido ao avaliar campos no PDF.") from exc
    finally:
        _safe_unlink(tmp_pdf)
        _safe_unlink(tmp_json)
        _safe_unlink(tmp_out)

def _run_probe_export(pdf_bytes: bytes, field_values: Dict[str, Any]) -> bytes:
    _ensure_probe_exists()

    tmp_pdf: Optional[Path] = None
    tmp_json: Optional[Path] = None
    tmp_out: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as pdf_f:
            pdf_f.write(pdf_bytes)
            tmp_pdf = Path(pdf_f.name)

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w", encoding="utf-8") as js_f:
            json.dump(field_values or {}, js_f, ensure_ascii=False, separators=(",", ":"))
            tmp_json = Path(js_f.name)

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as out_f:
            tmp_out = Path(out_f.name)

        cmd = [
            str(PROBE_EXE),
            "export",
            "--fields-json",
            str(tmp_json),
            "--out",
            str(tmp_out),
            str(tmp_pdf),
        ]
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROBE_TIMEOUT_SECONDS,
        )

        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip() or f"Código de saída {proc.returncode}"
            raise PdfEngineError(f"Falha ao exportar PDF no pdfcraft_probe: {detail}")

        if not tmp_out.exists() or tmp_out.stat().st_size == 0:
            raise PdfEngineError("pdfcraft_probe não gerou o arquivo PDF de saída.")

        return tmp_out.read_bytes()
    except subprocess.TimeoutExpired as exc:
        raise PdfEngineError("Tempo limite excedido ao exportar PDF.") from exc
    finally:
        _safe_unlink(tmp_pdf)
        _safe_unlink(tmp_json)
        _safe_unlink(tmp_out)


def _normalize_rect(raw_rect: Any) -> List[float]:
    if not isinstance(raw_rect, list) or len(raw_rect) != 4:
        return [0.0, 0.0, 0.0, 0.0]
    vals: List[float] = []
    for x in raw_rect:
        try:
            f = float(x)
            vals.append(max(0.0, min(1.0, f)))
        except (TypeError, ValueError):
            return [0.0, 0.0, 0.0, 0.0]
    return vals


def inspect_pdf(pdf_bytes: bytes) -> Dict[str, Any]:
    """Inspeciona o PDF usando o pdfcraft_probe compilado em Rust."""
    raw = _run_probe_json(pdf_bytes)

    raw_pages = raw.get("pages") if isinstance(raw.get("pages"), list) else []
    total_pages = int(raw.get("page_count") or len(raw_pages) or 0)
    raw_fields = raw.get("fields") if isinstance(raw.get("fields"), list) else []

    page_dims: Dict[int, tuple[float, float]] = {}
    for idx in range(total_pages):
        p_num = idx + 1
        p_entry = raw_pages[idx] if idx < len(raw_pages) and isinstance(raw_pages[idx], dict) else {}
        w = float(p_entry.get("width") or 612.0)
        h = float(p_entry.get("height") or 792.0)
        page_dims[p_num] = (w, h)

    fields_by_page: Dict[int, List[Dict[str, Any]]] = {p + 1: [] for p in range(total_pages)}
    normalized_fields: List[Dict[str, Any]] = []

    for idx, f in enumerate(raw_fields):
        if not isinstance(f, dict):
            continue
        name = str(f.get("name") or f"field_{idx}")
        kind = str(f.get("kind") or "Unknown")
        widgets = f.get("widgets") if isinstance(f.get("widgets"), list) else []

        if widgets and isinstance(widgets[0], dict):
            first_w = widgets[0]
            page_val = first_w.get("page")
            rect_val = _normalize_rect(first_w.get("rect"))
        else:
            page_val = f.get("page")
            rect_val = _normalize_rect(f.get("rect"))

        page_num: Optional[int]
        if page_val is None:
            page_num = None
        else:
            try:
                page_num = int(page_val)
            except (TypeError, ValueError):
                page_num = None

        norm_field = {
            "id": f"f_{idx}",
            "name": name,
            "label": name,
            "type": kind,
            "page": page_num,
            "value": f.get("value", ""),
            "rect": rect_val,
            "read_only": bool(f.get("read_only", False)),
            "hidden": bool(f.get("hidden", False)),
            "widgets": widgets,
            "calc_script": f.get("calc_script"),
        }
        normalized_fields.append(norm_field)

        target_page = page_num if page_num in fields_by_page else (1 if 1 in fields_by_page else None)
        if target_page is not None:
            fields_by_page[target_page].append(norm_field)

    pages_out: List[Dict[str, Any]] = []
    for p_idx in range(total_pages):
        p_num = p_idx + 1
        w, h = page_dims.get(p_num, (612.0, 792.0))
        pages_out.append({
            "page": p_num,
            "width": w,
            "height": h,
            "fields": fields_by_page.get(p_num, []),
        })

    if not pages_out and normalized_fields:
        pages_out.append({
            "page": 1,
            "width": 612.0,
            "height": 792.0,
            "fields": normalized_fields,
        })

    return {
        "total_pages": total_pages,
        "has_form_fields": len(normalized_fields) > 0,
        "doc_scripts": [],
        "pages": pages_out,
        "fields": normalized_fields,
    }


def evaluate_fields(pdf_bytes: bytes, field_values: Dict[str, Any]) -> tuple[Dict[str, Any], bytes]:
    """Aplica valores de campos no motor Rust e retorna (campos_atualizados, bytes_pdf)."""
    return _run_probe_eval(pdf_bytes, field_values=field_values)


def render_page_png(pdf_bytes: bytes, page_number: int, dpi: int = 150) -> bytes:
    """Renderiza uma página específica (1-based) em PNG via pdfcraft_probe."""
    return _run_probe_render(pdf_bytes, page_number=page_number, dpi=dpi)


def build_filled_pdf(
    pdf_bytes: bytes,
    field_values: Dict[str, Any],
    free_texts: Optional[List[Dict[str, Any]]] = None,
    strokes: Optional[List[Dict[str, Any]]] = None,
    flatten: bool = True,
) -> bytes:
    """Aplica valores de campos e recálculos via motor Rust pdfcraft_probe."""
    _ = (free_texts, strokes, flatten)
    return _run_probe_export(pdf_bytes, field_values=field_values)