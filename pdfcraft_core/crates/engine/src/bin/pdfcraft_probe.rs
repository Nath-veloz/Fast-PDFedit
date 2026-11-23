use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::sync::Arc;

use image::{ColorType, ImageEncoder, codecs::png::PngEncoder};
use pdfcraft_engine::{Edit, FieldValue, Session};
use serde_json::{Value, json};

struct RenderArgs {
    pdf_path: String,
    out_path: String,
    page: usize,
    dpi: u32,
}

struct ExportArgs {
    pdf_path: String,
    fields_json_path: Option<String>,
    out_path: String,
}

fn parse_render_args(args: &[String]) -> Result<RenderArgs, String> {
    let mut pdf_path: Option<String> = None;
    let mut out_path: Option<String> = None;
    let mut page: usize = 1;
    let mut dpi: u32 = 150;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--page" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| "Faltou valor para --page".to_string())?;
                page = v.parse::<usize>().map_err(|e| format!("--page inválido: {e}"))?;
            }
            "--dpi" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| "Faltou valor para --dpi".to_string())?;
                dpi = v.parse::<u32>().map_err(|e| format!("--dpi inválido: {e}"))?;
            }
            "--out" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| "Faltou valor para --out".to_string())?;
                out_path = Some(v.clone());
            }
            other if !other.starts_with("--") && pdf_path.is_none() => {
                pdf_path = Some(other.to_string());
            }
            other => {
                return Err(format!("Argumento desconhecido em render: {other}"));
            }
        }
        i += 1;
    }

    let pdf_path = pdf_path.ok_or_else(|| "Caminho do PDF ausente em render".to_string())?;
    let out_path = out_path.ok_or_else(|| "Caminho de saída --out ausente em render".to_string())?;

    Ok(RenderArgs {
        pdf_path,
        out_path,
        page: page.max(1),
        dpi: dpi.clamp(72, 300),
    })
}

fn parse_export_args(args: &[String]) -> Result<ExportArgs, String> {
    let mut pdf_path: Option<String> = None;
    let mut fields_json_path: Option<String> = None;
    let mut out_path: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--fields-json" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| "Faltou valor para --fields-json".to_string())?;
                fields_json_path = Some(v.clone());
            }
            "--out" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| "Faltou valor para --out".to_string())?;
                out_path = Some(v.clone());
            }
            other if !other.starts_with("--") && pdf_path.is_none() => {
                pdf_path = Some(other.to_string());
            }
            other => {
                return Err(format!("Argumento desconhecido em export: {other}"));
            }
        }
        i += 1;
    }

    let pdf_path = pdf_path.ok_or_else(|| "Caminho do PDF ausente em export".to_string())?;
    let out_path = out_path.ok_or_else(|| "Caminho de saída --out ausente em export".to_string())?;

    Ok(ExportArgs {
        pdf_path,
        fields_json_path,
        out_path,
    })
}

fn json_to_field_value(val: &Value) -> FieldValue {
    match val {
        Value::Bool(b) => FieldValue::Text(if *b { "Yes".to_string() } else { "Off".to_string() }),
        Value::Number(n) => FieldValue::Text(n.to_string()),
        Value::String(s) => FieldValue::Text(s.clone()),
        Value::Null => FieldValue::Text(String::new()),
        other => FieldValue::Text(other.to_string()),
    }
}

fn rgba_to_png_bytes(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| "Dimensões de imagem inválidas ou excedidas".to_string())?;

    if rgba.len() != expected {
        return Err(format!(
            "Tamanho do buffer RGBA ({}) não corresponde a {}x{}x4 ({})",
            rgba.len(),
            width,
            height,
            expected
        ));
    }

    let mut png_buf: Vec<u8> = Vec::new();
    let encoder = PngEncoder::new(&mut png_buf);
    encoder
        .write_image(rgba, width, height, ColorType::Rgba8.into())
        .map_err(|e| format!("Falha ao codificar PNG: {e}"))?;
    Ok(png_buf)
}

/// Normaliza um retângulo de *user space* `[x0, y0, x1, y1]` (eixo Y para cima) para
/// coordenadas visuais normalizadas `[0.0, 1.0]` (eixo Y para baixo, a partir do topo).
fn normalize_widget_rect(
    rect: [f64; 4],
    page_info: &pdfcraft_render::PageInfo,
) -> [f64; 4] {
    let [cx0, cy0, cx1, cy1] = page_info.crop.map(f64::from);
    let cw = (cx1 - cx0).abs().max(1.0);
    let ch = (cy1 - cy0).abs().max(1.0);

    let x_min = rect[0].min(rect[2]);
    let x_max = rect[0].max(rect[2]);
    let y_min = rect[1].min(rect[3]);
    let y_max = rect[1].max(rect[3]);

    // Em user space, y_max é o topo do retângulo e y_min é a base.
    let u0 = ((x_min - cx0) / cw).clamp(0.0, 1.0);
    let u1 = ((x_max - cx0) / cw).clamp(0.0, 1.0);
    let v0 = ((cy1 - y_max) / ch).clamp(0.0, 1.0);
    let v1 = ((cy1 - y_min) / ch).clamp(0.0, 1.0);

    let (nx0, ny0, nx1, ny1) = match page_info.rotation.rem_euclid(360) {
        90 => (1.0 - v1, u0, 1.0 - v0, u1),
        180 => (1.0 - u1, 1.0 - v1, 1.0 - u0, 1.0 - v0),
        270 => (v0, 1.0 - u1, v1, 1.0 - u0),
        _ => (u0, v0, u1, v1),
    };

    [
        nx0.min(nx1).clamp(0.0, 1.0),
        ny0.min(ny1).clamp(0.0, 1.0),
        nx0.max(nx1).clamp(0.0, 1.0),
        ny0.max(ny1).clamp(0.0, 1.0),
    ]
}

fn run_inspect(pdf_path: &str) -> Result<Value, String> {
    let bytes = fs::read(pdf_path).map_err(|e| format!("Falha ao ler '{pdf_path}': {e}"))?;

    let mut session = Session::new();
    let doc_id = session
        .open("input.pdf", Some(pdf_path.to_string()), Arc::new(bytes), None)
        .map_err(|e| format!("Falha ao abrir PDF no motor: {e}"))?;

    let doc = session.get(doc_id).ok_or_else(|| "Documento não encontrado na sessão".to_string())?;

    let pages: Vec<Value> = doc
        .info
        .pages
        .iter()
        .enumerate()
        .map(|(idx, p)| {
            json!({
                "page": idx + 1,
                "width": p.width,
                "height": p.height,
            })
        })
        .collect();

    let fields: Vec<Value> = doc
        .form
        .iter()
        .map(|f| {
            let widgets: Vec<Value> = f
                .widgets
                .iter()
                .map(|w| {
                    let page_1based = w.page.map(|p| p + 1);
                    let rect = w
                        .page
                        .and_then(|p| doc.info.pages.get(p))
                        .map(|p_info| normalize_widget_rect(w.rect, p_info))
                        .unwrap_or([0.0, 0.0, 0.0, 0.0]);
                    json!({
                        "page": page_1based,
                        "rect": rect,
                    })
                })
                .collect();

            let first_widget_page = widgets.first().and_then(|w| w.get("page")).cloned().unwrap_or(Value::Null);
            let first_widget_rect = widgets
                .first()
                .and_then(|w| w.get("rect"))
                .cloned()
                .unwrap_or_else(|| json!([0.0, 0.0, 0.0, 0.0]));

            let value_json: Value = match f.kind {
                pdfcraft_engine::FormFieldKind::CheckBox => {
                    let checked = f.widgets.iter().enumerate().any(|(i, _)| f.widget_on(i))
                        || f.value.first().is_some_and(|v| !v.is_empty() && v != "Off");
                    Value::Bool(checked)
                }
                _ => Value::String(f.value.first().cloned().unwrap_or_default()),
            };

            json!({
                "name": f.name,
                "kind": format!("{:?}", f.kind),
                "value": value_json,
                "page": first_widget_page,
                "rect": first_widget_rect,
                "widgets": widgets,
            })
        })
        .collect();

    Ok(json!({
        "ok": true,
        "path": pdf_path,
        "editable": doc.editable(),
        "page_count": doc.info.pages.len(),
        "pages": pages,
        "field_count": doc.form.len(),
        "fields": fields,
    }))
}

fn run_render(cfg: RenderArgs) -> Result<(), String> {
    let bytes = fs::read(&cfg.pdf_path).map_err(|e| format!("Falha ao ler '{}': {e}", cfg.pdf_path))?;
    let mut session = Session::new();
    let doc_id = session
        .open("input.pdf", Some(cfg.pdf_path.clone()), Arc::new(bytes), None)
        .map_err(|e| format!("Falha ao abrir PDF no motor: {e}"))?;

    let doc = session.get(doc_id).ok_or_else(|| "Documento não encontrado na sessão".to_string())?;
    let page_idx = cfg.page.saturating_sub(1);
    if page_idx >= doc.info.pages.len() {
        return Err(format!("Página {} fora do intervalo (total: {})", cfg.page, doc.info.pages.len()));
    }

    let scale = f32::from(cfg.dpi as u16) / 72.0;
    let render_cfg = session.render_config(doc_id).unwrap_or_default();
    let mut renderer = pdfcraft_render::PageRenderer::new(doc.display.clone(), render_cfg);
    let rendered = renderer.render(pdfcraft_render::RenderRequest {
        page: page_idx,
        kind: pdfcraft_render::RequestKind::Pixels,
        scale,
        ..Default::default()
    });

    if let Some(err) = rendered.error {
        return Err(format!("Falha ao renderizar página {}: {err}", cfg.page));
    }

    let png_bytes = rgba_to_png_bytes(rendered.rgba.as_ref(), rendered.width, rendered.height)?;
    fs::write(&cfg.out_path, &png_bytes)
        .map_err(|e| format!("Falha ao escrever PNG em '{}': {e}", cfg.out_path))?;

    Ok(())
}

fn run_export(cfg: ExportArgs) -> Result<Value, String> {
    let bytes = fs::read(&cfg.pdf_path).map_err(|e| format!("Falha ao ler '{}': {e}", cfg.pdf_path))?;
    let mut session = Session::new();
    let doc_id = session
        .open("input.pdf", Some(cfg.pdf_path.clone()), Arc::new(bytes), None)
        .map_err(|e| format!("Falha ao abrir PDF no motor: {e}"))?;

    let mut applied_count: usize = 0;

    if let Some(json_path) = cfg.fields_json_path {
        let json_txt = fs::read_to_string(&json_path)
            .map_err(|e| format!("Falha ao ler JSON de campos '{}': {e}", json_path))?;
        let parsed: Value = serde_json::from_str(&json_txt)
            .map_err(|e| format!("JSON de campos inválido: {e}"))?;

        if let Some(map) = parsed.as_object() {
            let ordered: BTreeMap<String, Value> = map.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            for (field_name, val) in ordered {
                let edit = Edit::SetFieldValue {
                    name: field_name,
                    value: json_to_field_value(&val),
                };
                session
                    .apply(doc_id, edit)
                    .map_err(|e| format!("Falha ao aplicar campo no motor: {e}"))?;
                applied_count += 1;
            }
        }
    }

    let out_bytes = session
        .save_full_bytes(doc_id)
        .map_err(|e| format!("Falha ao gerar bytes do PDF exportado: {e}"))?;

    fs::write(&cfg.out_path, out_bytes.as_slice())
        .map_err(|e| format!("Falha ao escrever '{}': {e}", cfg.out_path))?;

    Ok(json!({
        "ok": true,
        "out": cfg.out_path,
        "applied_fields": applied_count,
    }))
}

fn main() {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() {
        eprintln!(r#"{{"ok":false,"error":"Uso: pdfcraft_probe <pdf> | render ... | export ..."}}"#);
        std::process::exit(1);
    }

    if args[0] == "render" {
        args.remove(0);
        match parse_render_args(&args).and_then(run_render) {
            Ok(()) => {}
            Err(msg) => {
                let err_json = json!({ "ok": false, "error": msg });
                eprintln!("{err_json}");
                std::process::exit(1);
            }
        }
        return;
    }

    if args[0] == "export" {
        args.remove(0);
        match parse_export_args(&args).and_then(run_export) {
            Ok(payload) => match serde_json::to_string(&payload) {
                Ok(text) => println!("{text}"),
                Err(err) => {
                    eprintln!(r#"{{"ok":false,"error":"Falha ao serializar JSON: {err}"}}"#);
                    std::process::exit(1);
                }
            },
            Err(msg) => {
                let err_json = json!({ "ok": false, "error": msg });
                eprintln!("{err_json}");
                std::process::exit(1);
            }
        }
        return;
    }

    let pdf_path = args[0].as_str();
    match run_inspect(pdf_path) {
        Ok(payload) => match serde_json::to_string_pretty(&payload) {
            Ok(text) => println!("{text}"),
            Err(err) => {
                eprintln!(r#"{{"ok":false,"error":"Falha ao serializar JSON: {err}"}}"#);
                std::process::exit(1);
            }
        },
        Err(msg) => {
            let err_json = json!({ "ok": false, "error": msg });
            eprintln!("{err_json}");
            std::process::exit(1);
        }
    }
}