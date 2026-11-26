# Fast PDFedit v0.1

Editor web para PDFs editáveis com backend em **FastAPI** (Python), processamento complementar de camadas e achatamento com **PyMuPDF (`fitz`)**, interface em **HTML/CSS/JavaScript (Canvas)** e motor de inspeção, renderização e edição de formulários em **Rust** (`pdfcraft_probe`).

## Como o `pdfcraft_probe` funciona

O binário `pdfcraft_probe` (localizado em `pdfcraft_core/crates/engine/src/bin/pdfcraft_probe.rs`) expõe o motor Rust via linha de comando (CLI) para o backend Python, sem alterar os arquivos originais do `pdfcraft_core`:

* **Inspeção (`<pdf>`)**: abre o documento em sessão, verifica se é editável (`editable`), lê as dimensões das páginas (`width`, `height`) e os campos de formulário (`name`, `kind`, `value`, `read_only`, `hidden`, `widgets`), normaliza os retângulos dos *widgets* para o espaço visual `[0.0, 1.0]` considerando rotação e *crop*, e imprime o resultado em JSON no `stdout`.
* **Renderização (`render [--page <p>] [--dpi <d>] --out <arquivo.png> <pdf>`)**: renderiza a página solicitada (baseada em 1, padrão `1`) na escala correspondente ao `dpi` (padrão `150`, limitado entre `72` e `300`) e grava o PNG RGBA no caminho indicado em `--out`.
* **Avaliação (`eval [--fields-json <campos.json>] [--out <saida.pdf>] <pdf>`)**: aplica opcionalmente valores de campos via `Edit::SetFieldValue` a partir de um JSON (ignorando campos que já possuem o mesmo valor), grava opcionalmente o PDF resultante em `--out` e imprime em JSON os valores finais de todos os campos (`fields`) e o total aplicado (`applied_fields`).
* **Exportação (`export [--fields-json <campos.json>] --out <saida.pdf> <pdf>`)**: aplica os valores de campos na sessão e grava o PDF resultante em `--out`, que o backend Python complementa aplicando textos livres, traços e achatamento (`flatten`).

## Como rodar localmente

### Pré-requisitos

* **Git** (para clonar o repositório)
* **Python 3.10+** com `pip` (recomendado o uso de ambiente virtual `venv`)
* **Rust e Cargo** (`rustc` e `cargo` instalados via [rustup](https://rustup.rs/))

### Passo a passo

1. **Clone o repositório e acesse a pasta do projeto**:

   ```bash
   git clone https://github.com/Nath-veloz/Fast-PDFedit.git
   cd Fast-PDFedit
   ```

2. **Crie um ambiente virtual e instale as dependências Python**:

   * **Linux / macOS:**

     ```bash
     python3 -m venv .venv
     source .venv/bin/activate
     pip install -r requirements.txt
     ```

   * **Windows (PowerShell):**

     ```powershell
     python -m venv .venv
     .venv\Scripts\Activate.ps1
     pip install -r requirements.txt
     ```

3. **Compile o binário `pdfcraft_probe`**:

   ```bash
   cd pdfcraft_core
   cargo build --release --bin pdfcraft_probe
   cd ..
   ```

   *(Para desenvolvimento rápido, você também pode rodar `cargo build --bin pdfcraft_probe` sem `--release`.)*

4. **Configure o caminho do binário (se compilado em `--release`) e inicie o servidor**:

   Por padrão, se `PDFCRAFT_PROBE_EXE` não estiver definida, o backend busca o build de debug (`pdfcraft_core/target/debug/pdfcraft_probe`). Caso tenha compilado com `--release`, aponte o caminho relativo à raiz do projeto:

   * **Linux / macOS:**

     ```bash
     export PDFCRAFT_PROBE_EXE="./pdfcraft_core/target/release/pdfcraft_probe"
     uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
     ```

   * **Windows (PowerShell):**

     ```powershell
     $env:PDFCRAFT_PROBE_EXE=".\pdfcraft_core\target\release\pdfcraft_probe.exe"
     uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
     ```

5. **Acesse no navegador**:

   Abra `http://127.0.0.1:8000` para carregar, preencher, anotar e exportar seus PDFs.

## Variáveis de Ambiente

| Variável | Descrição | Padrão |
| :--- | :--- | :--- |
| `PDFCRAFT_PROBE_EXE` | Caminho para o executável compilado `pdfcraft_probe` (ou `pdfcraft_probe.exe` no Windows). | `pdfcraft_core/target/debug/pdfcraft_probe(.exe)` |
| `PDFCRAFT_DEBUG` | Quando definida como `1` ou `true`, habilita logs de depuração do motor Rust no `stderr`. | Desativado (`false`) |

## Licenças e Atribuições

* **Fast PDFedit**: licenciado sob a licença MIT (veja `LICENSE` na raiz do repositório).
* **Motor `pdfcraft_core`**: licenciado sob `MIT OR Apache-2.0`. Os textos completos e avisos de terceiros encontram-se em:
  * `pdfcraft_core/LICENSE-MIT`
  * `pdfcraft_core/LICENSE-APACHE`
  * `pdfcraft_core/NOTICE`
  * `pdfcraft_core/ATTRIBUTION.md`
  * `pdfcraft_core/licenses/`

> **Nota:** marcas, logotipos, fontes e dependências de terceiros (como ArtCraft, Lucide, fontes sob SIL OFL 1.1 e crates listadas em `NOTICE` e `ATTRIBUTION.md`) permanecem sujeitos às suas respectivas licenças e termos de uso.