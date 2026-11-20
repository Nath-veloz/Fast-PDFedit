import re
from typing import Any, Dict, List, Optional, Tuple
import pymupdf


def _find_nearby_label(words: List[Tuple], rect: pymupdf.Rect) -> str:
    """Busca a palavra mais próxima à esquerda ou logo acima do campo como fallback."""
    best_label = ""
    best_dist = float("inf")

    for x0, y0, x1, y1, word, *_ in words:
        word = word.strip()
        if not word or len(word) < 2:
            continue

        to_left = x1 <= rect.x0 + 4 and abs((y0 + y1) / 2 - (rect.y0 + rect.y1) / 2) <= 18
        above = y1 <= rect.y0 + 4 and 0 <= (rect.y0 - y1) <= 22 and abs(x0 - rect.x0) <= 40

        if to_left or above:
            dx = max(0.0, rect.x0 - x1)
            dy = max(0.0, rect.y0 - y1)
            dist = (dx * dx + dy * dy) ** 0.5
            if dist < best_dist:
                best_dist = dist
                best_label = word

    return best_label


def _is_valid_widget(widget: pymupdf.Widget, page_rect: pymupdf.Rect) -> bool:
    """Filtra widgets invisíveis, ocultos ou com geometria inválida/fantasma."""
    r = widget.rect
    if r.is_empty or r.is_infinite:
        return False
    if r.width < 4 or r.height < 4:
        return False

    # Ignora campos ocultos (PDF_ANNOT_IS_HIDDEN = 2)
    flags = getattr(widget, "field_flags", 0) or 0
    if flags & 2:
        return False

    # Ignora caixas com proporção extrema que costumam ser artefatos de layout
    if widget.field_type_string != "CheckBox":
        ratio = r.height / max(r.width, 1.0)
        if ratio > 3.0 and r.width < 25:
            return False

    inter = r & page_rect
    if inter.is_empty or inter.width < 3 or inter.height < 3:
        return False

    return True


def _extract_balanced_parens(text: str, start_idx: int) -> Optional[str]:
    """Extrai o conteúdo de uma string literal PDF '(...)' respeitando parênteses aninhados e escapes."""
    n = len(text)
    if start_idx >= n or text[start_idx] != "(":
        return None

    depth = 0
    escaped = False
    chars: List[str] = []

    for i in range(start_idx, n):
        ch = text[i]
        if escaped:
            chars.append(ch)
            escaped = False
            continue
        if ch == "\\":
            escaped = True
            chars.append(ch)
            continue
        if ch == "(":
            depth += 1
            if depth > 1:
                chars.append(ch)
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return "".join(chars)
            chars.append(ch)
        elif depth > 0:
            chars.append(ch)

    return None


def _resolve_js_from_ref(doc: pymupdf.Document, ref_str: str) -> str:
    """Resolve uma referência indireta '123 0 R' para o texto/stream JS quando existir."""
    match = re.search(r"(\d+)\s+\d+\s+R", ref_str)
    if not match:
        return ref_str.strip()

    xref = int(match.group(1))
    try:
        stream_data = doc.xref_stream(xref)
        if stream_data:
            return stream_data.decode("utf-8", errors="replace").strip()
    except Exception:
        pass

    try:
        obj_txt = doc.xref_object(xref) or ""
        js_pos = obj_txt.find("/JS")
        if js_pos != -1:
            paren_pos = obj_txt.find("(", js_pos)
            if paren_pos != -1:
                extracted = _extract_balanced_parens(obj_txt, paren_pos)
                if extracted is not None:
                    return extracted.strip()
        return obj_txt.strip()
    except Exception:
        return ""


def _extract_js_after_key(obj_str: str, key: str, doc: pymupdf.Document) -> List[str]:
    """Extrai referências ou literais JS após uma chave como /JS ou /C."""
    results: List[str] = []
    search_from = 0

    while True:
        idx = obj_str.find(key, search_from)
        if idx == -1:
            break
        after = obj_str[idx + len(key):].lstrip()
        search_from = idx + len(key)

        ref_m = re.match(r"(\d+\s+\d+\s+R)", after)
        if ref_m:
            resolved = _resolve_js_from_ref(doc, ref_m.group(1))
            if resolved:
                results.append(resolved)
            continue

        # Caso seja dicionário << ... /JS ... >>
        if after.startswith("<<"):
            dict_end = after.find(">>")
            if dict_end != -1:
                sub = after[:dict_end]
                results.extend(_extract_js_after_key(sub, "/JS", doc))
            continue

        # Caso seja string literal (...)
        if after.startswith("("):
            extracted = _extract_balanced_parens(after, 0)
            if extracted is not None and extracted.strip():
                results.append(extracted.strip())

    return results


def _extract_widget_script(doc: pymupdf.Document, widget: pymupdf.Widget) -> Optional[str]:
    """Extrai script de cálculo/ação associado ao widget no PDF, se houver."""
    direct_script = getattr(widget, "script", None) or getattr(widget, "script_calc", None)
    if isinstance(direct_script, str) and direct_script.strip():
        return direct_script.strip()

    xref = getattr(widget, "xref", 0) or 0
    if not xref:
        return None

    try:
        obj_str = doc.xref_object(xref) or ""
    except Exception:
        return None

    candidates: List[str] = []
    candidates.extend(_extract_js_after_key(obj_str, "/C", doc))
    candidates.extend(_extract_js_after_key(obj_str, "/JS", doc))

    if not candidates:
        return None

    unique = list(dict.fromkeys(c for c in candidates if c))
    return "\n".join(unique) if unique else None


def _extract_doc_scripts(doc: pymupdf.Document) -> List[Dict[str, Any]]:
    """Varre o documento em busca de scripts embutidos (ex.: JavaScript de cálculo)."""
    scripts: List[Dict[str, Any]] = []
    try:
        count = doc.xref_length()
    except Exception:
        return scripts

    for xref in range(1, count):
        try:
            obj_str = doc.xref_object(xref) or ""
        except Exception:
            continue

        if "/JS" in obj_str or "JavaScript" in obj_str or "/S /JavaScript" in obj_str:
            code_items = _extract_js_after_key(obj_str, "/JS", doc)
            code = "\n".join(dict.fromkeys(code_items)).strip()

            if not code:
                try:
                    st = doc.xref_stream(xref)
                    if st:
                        code = st.decode("utf-8", errors="replace").strip()
                except Exception:
                    pass

            if code:
                scripts.append({"xref": xref, "code": code})

    return scripts


def inspect_pdf(pdf_bytes: bytes) -> Dict[str, Any]:
    """Lê o PDF em memória e extrai páginas, campos de formulário e scripts internos."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        pages_out: List[Dict[str, Any]] = []

        for page_index, page in enumerate(doc):
            words = page.get_text("words")
            vis_rect = page.rect
            w_total = vis_rect.width if vis_rect.width else 1.0
            h_total = vis_rect.height if vis_rect.height else 1.0

            fields_out: List[Dict[str, Any]] = []
            seen_keys = set()

            for idx, widget in enumerate(page.widgets() or []):
                if not _is_valid_widget(widget, vis_rect):
                    continue

                r = widget.rect
                norm_rect = [
                    max(0.0, min(1.0, (r.x0 - vis_rect.x0) / w_total)),
                    max(0.0, min(1.0, (r.y0 - vis_rect.y0) / h_total)),
                    max(0.0, min(1.0, (r.x1 - vis_rect.x0) / w_total)),
                    max(0.0, min(1.0, (r.y1 - vis_rect.y0) / h_total)),
                ]

                dedup_key = (
                    widget.field_type_string,
                    round(norm_rect[0], 4),
                    round(norm_rect[1], 4),
                    round(norm_rect[2], 4),
                    round(norm_rect[3], 4),
                )
                if dedup_key in seen_keys:
                    continue
                seen_keys.add(dedup_key)

                raw_label = (widget.field_label or "").strip()
                fallback_label = _find_nearby_label(words, r) if not raw_label else raw_label
                label = fallback_label or widget.field_name or f"Campo {idx + 1}"

                is_checkbox = widget.field_type_string == "CheckBox"
                val: Any
                if is_checkbox:
                    val = bool(widget.field_value) and str(widget.field_value).lower() not in ("off", "false", "0", "")
                else:
                    val = "" if widget.field_value is None else str(widget.field_value)

                calc_script = _extract_widget_script(doc, widget)

                fields_out.append({
                    "id": f"p{page_index + 1}_f{idx}",
                    "name": widget.field_name or f"field_{page_index + 1}_{idx}",
                    "label": label,
                    "type": widget.field_type_string,
                    "value": val,
                    "rect": norm_rect,
                    "calc_script": calc_script,
                })

            pages_out.append({
                "page": page_index + 1,
                "width": w_total,
                "height": h_total,
                "fields": fields_out,
            })

        doc_scripts = _extract_doc_scripts(doc)
        total_pages = len(doc)

        return {
            "total_pages": total_pages,
            "has_form_fields": any(len(p["fields"]) > 0 for p in pages_out),
            "doc_scripts": doc_scripts,
            "pages": pages_out,
        }
    finally:
        doc.close()


def render_page_png(pdf_bytes: bytes, page_number: int, dpi: int = 150) -> bytes:
    """Renderiza uma página específica (1-based) em PNG."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        idx = max(0, min(page_number - 1, len(doc) - 1))
        page = doc[idx]
        pix = page.get_pixmap(dpi=dpi)
        return pix.tobytes("png")
    finally:
        doc.close()


def build_filled_pdf(
    pdf_bytes: bytes,
    field_values: Dict[str, Any],
    free_texts: Optional[List[Dict[str, Any]]] = None,
    strokes: Optional[List[Dict[str, Any]]] = None,
    flatten: bool = True,
) -> bytes:
    """Aplica valores nos campos, textos livres e traços, retornando os bytes do PDF final."""
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        free_texts = free_texts or []
        strokes = strokes or []

        for page_index, page in enumerate(doc):
            page_num = page_index + 1
            vis_rect = page.rect

            for idx, widget in enumerate(page.widgets() or []):
                if not _is_valid_widget(widget, vis_rect):
                    continue

                field_id = f"p{page_num}_f{idx}"
                key = field_id if field_id in field_values else widget.field_name
                if key in field_values:
                    val = field_values[key]
                    if widget.field_type_string == "CheckBox":
                        widget.field_value = bool(val)
                    else:
                        widget.field_value = "" if val is None else str(val)
                    widget.update()

            for item in free_texts:
                if int(item.get("page", 0)) != page_num:
                    continue
                text = (item.get("text") or "").strip()
                if not text:
                    continue
                x_norm = float(item.get("x", 0.1))
                y_norm = float(item.get("y", 0.1))
                font_size = float(item.get("font_size", 11))

                pt = pymupdf.Point(
                    vis_rect.x0 + x_norm * vis_rect.width,
                    vis_rect.y0 + y_norm * vis_rect.height,
                )
                page.insert_text(pt, text, fontsize=font_size)

            for stk in strokes:
                if int(stk.get("page", 0)) != page_num:
                    continue
                pts = stk.get("points") or []
                if len(pts) < 2:
                    continue
                pdf_pts = [
                    pymupdf.Point(
                        vis_rect.x0 + float(p.get("x", 0.0)) * vis_rect.width,
                        vis_rect.y0 + float(p.get("y", 0.0)) * vis_rect.height,
                    )
                    for p in pts
                ]
                page.draw_polyline(pdf_pts, color=(0.11, 0.31, 0.85), width=1.8)

        if flatten:
            doc.bake()

        return doc.tobytes(garbage=3, deflate=True)
    finally:
        doc.close()