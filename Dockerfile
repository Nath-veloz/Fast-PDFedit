# --- Estágio 1: Compila o binário Rust pdfcraft_probe ---
FROM rust:1.83-slim-bookworm AS rust-builder

WORKDIR /build

# Instala dependências básicas do sistema caso alguma crate nativo/openssl/build precise
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY pdfcraft_core ./pdfcraft_core

WORKDIR /build/pdfcraft_core
RUN cargo build --release --bin pdfcraft_probe


# --- Estágio 2: Imagem final enxuta com FastAPI + PyMuPDF + binário Rust ---
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PDFCRAFT_PROBE_EXE=/app/bin/pdfcraft_probe

WORKDIR /app

# Dependências de runtime (ex.: libgomp1 costuma ser exigida por pacotes como PyMuPDF / processamento numérico no Linux)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --from=rust-builder /build/pdfcraft_core/target/release/pdfcraft_probe /app/bin/pdfcraft_probe
RUN chmod +x /app/bin/pdfcraft_probe

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]