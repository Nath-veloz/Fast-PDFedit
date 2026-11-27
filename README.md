# Fast PDFedit v0.1

Editor web open source para PDFs editáveis com backend em **FastAPI** (Python), processamento complementar de camadas e achatamento com **PyMuPDF (`pymupdf` / `fitz`)**, interface interativa em **HTML/CSS/JavaScript (Canvas)** e motor de inspeção, renderização e edição de formulários em **Rust** (`pdfcraft_probe`).

## Acesso Online

Caso queira apenas utilizar o editor diretamente pelo navegador, sem baixar o repositório ou configurar um servidor próprio, acesse a instância pública:

* **Aplicação Web:** <https://fast-pdfedit.duckdns.org>

## Reconhecimentos: ArtCraft e PdfCraft

Este projeto é construído sobre a engenharia open source do [**PdfCraft**](https://github.com/storytold/pdfcraft.git), desenvolvido pela equipe do [**ArtCraft**](https://getartcraft.com/), que fornece o núcleo em Rust (`pdfcraft_core`) responsável pela leitura estrutural de documentos PDF, renderização de páginas e avaliação de formulários interativos.

* **Site oficial do ArtCraft:** <https://getartcraft.com/>
* **Repositório oficial do PdfCraft:** <https://github.com/storytold/pdfcraft.git>

## Arquitetura e Fluxo de Funcionamento

O **Fast PDFedit** separa a interface do usuário, a orquestração da API e a manipulação de baixo nível do PDF em camadas bem definidas:

1. **Front-end (`app/static/`)**: interface em HTML/CSS/JavaScript com Canvas interativo para upload, visualização de páginas, preenchimento de campos de formulário, inserção de textos livres (`free_texts`) e desenhos à mão livre (`strokes`).
2. **Backend / API (`app/main.py` e `app/pdf_engine.py`)**: servidor FastAPI que gerencia sessões temporárias em memória com TTL, impõe limites de tamanho de arquivo e concorrência, e coordena a chamada ao motor Rust e ao `PyMuPDF`.
3. **Motor Rust (`pdfcraft_probe`)**: binário CLI compilado a partir de `pdfcraft_core/crates/engine/src/bin/pdfcraft_probe.rs` que inspeciona campos/dimensões, renderiza páginas em PNG e aplica valores em formulários PDF.
4. **Composição Final (`PyMuPDF`)**: na exportação, o backend recebe o PDF com os formulários preenchidos pelo motor Rust e aplica textos livres, traços vetoriais e o achatamento (`flatten`) antes de entregar o arquivo final para download.

## Como o `pdfcraft_probe` funciona

O binário `pdfcraft_probe` expõe o motor Rust via linha de comando (CLI) para o backend Python sem modificar os arquivos originais do `pdfcraft_core`:

* **Inspeção (`<pdf>`)**: abre o documento em sessão, verifica se é editável (`editable`), lê as dimensões das páginas (`width`, `height`) e os campos de formulário (`name`, `kind`, `value`, `read_only`, `hidden`, `widgets`), normaliza os retângulos dos *widgets* para o espaço visual `[0.0, 1.0]` considerando rotação e *crop*, e imprime o resultado em JSON no `stdout`.
* **Renderização (`render [--page <p>] [--dpi <d>] --out <arquivo.png> <pdf>`)**: renderiza a página solicitada (baseada em 1, padrão `1`) na escala correspondente ao `dpi` (padrão `150`, limitado entre `72` e `300`) e grava o PNG RGBA no caminho indicado em `--out`.
* **Avaliação (`eval [--fields-json <campos.json>] [--out <saida.pdf>] <pdf>`)**: aplica opcionalmente valores de campos via `Edit::SetFieldValue` a partir de um JSON (ignorando campos que já possuem o mesmo valor), grava opcionalmente o PDF resultante em `--out` e imprime em JSON os valores finais de todos os campos (`fields`) e o total aplicado (`applied_fields`).
* **Exportação (`export [--fields-json <campos.json>] --out <saida.pdf> <pdf>`)**: aplica os valores de campos na sessão e grava o PDF resultante em `--out`, que o backend Python complementa aplicando textos livres, traços e achatamento (`flatten`).

## Como rodar em um servidor próprio (Docker + GHCR + Caddy)

As imagens Docker do **Fast PDFedit** são compiladas automaticamente via GitHub Actions (multi-stage build) e publicadas de forma pública no **GitHub Container Registry (GHCR)** (`ghcr.io/nath-veloz/fast-pdfedit:latest`). Isso permite implantar o serviço em servidores enxutos (como instâncias de 1 GB de RAM) sem precisar compilar Rust na máquina de produção.

### Pré-requisitos no servidor

* **Docker** e **Docker Compose** (`docker compose`) instalados.
* **Caddy** (ou Nginx) instalado no host para atuar como proxy reverso com certificado HTTPS/TLS automático apontando para `127.0.0.1:8000`.
* Um domínio ou subdomínio (por exemplo, `seudominio.com`) com registro `A` apontando para o IP público do servidor, com as portas TCP `80` e `443` liberadas no firewall.
* *(Recomendado em instâncias de 1 GB de RAM)* Configurar entre 1 GB e 2 GB de memória *swap* no sistema operacional para absorver picos momentâneos de processamento.

### Passo a passo no servidor

1. **Clone o repositório e acesse a pasta do projeto:**

   ```bash
   git clone https://github.com/Nath-veloz/Fast-PDFedit.git
   cd Fast-PDFedit
   ```

2. **Baixe a imagem pré-construída do GHCR e inicie o container:**

   ```bash
   docker compose pull
   docker compose up -d
   ```

   O serviço ficará escutando localmente em `http://127.0.0.1:8000` com limites de memória e concorrência já ajustados no `docker-compose.yml`.

3. **Configure o proxy reverso com HTTPS (Caddy):**

   Use o modelo disponível em `deploy/Caddyfile.example` como base para o `/etc/caddy/Caddyfile` do servidor, substituindo o domínio pelo seu endereço real (`seudominio.com`):

   ```caddyfile
   seudominio.com {
       request_body {
           max_size 12MB
       }

       reverse_proxy 127.0.0.1:8000
   }
   ```

   Em seguida, valide e recarregue o serviço do Caddy:

   ```bash
   sudo caddy fmt --overwrite /etc/caddy/Caddyfile
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

4. **Como atualizar a aplicação e a imagem Docker no servidor:**

   Sempre que houver uma nova versão publicada no repositório e no GHCR, acesse a pasta do projeto no servidor, atualize os arquivos locais, baixe a nova imagem e recrie o container:

   ```bash
   cd ~/Fast-PDFedit
   git pull
   docker compose pull
   docker compose up -d
   docker image prune -f
   ```

## Como rodar localmente (Desenvolvimento)

### Pré-requisitos

* **Git** (para clonar o repositório)
* **Python 3.10+** com `pip` (recomendado o uso de ambiente virtual `venv`)
* **Rust e Cargo** (`rustc` e `cargo` instalados via [rustup](https://rustup.rs/), com suporte à edição 2024)

### Passo a passo

1. **Clone o repositório e acesse a pasta do projeto:**

   ```bash
   git clone https://github.com/Nath-veloz/Fast-PDFedit.git
   cd Fast-PDFedit
   ```

2. **Crie um ambiente virtual e instale as dependências Python:**

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

3. **Compile o binário `pdfcraft_probe`:**

   ```bash
   cd pdfcraft_core
   cargo build --release --bin pdfcraft_probe
   cd ..
   ```

   *(Para compilação mais rápida durante testes locais, você também pode rodar `cargo build --bin pdfcraft_probe` sem `--release`.)*

4. **Inicie o servidor de desenvolvimento:**

   Por padrão, o backend procura automaticamente o executável em `pdfcraft_core/target/release/pdfcraft_probe(.exe)` e, caso não exista, faz fallback para `pdfcraft_core/target/debug/pdfcraft_probe(.exe)`:

   ```bash
   uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
   ```

   Caso queira apontar outro caminho manualmente:

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

5. **Acesse no navegador:**

   Abra `http://127.0.0.1:8000` para carregar, preencher, anotar e exportar seus PDFs.

## Estrutura do Projeto

```text
Fast-PDFedit/
├── .github/workflows/       # Pipeline CI/CD para build multi-stage e push no GHCR
├── app/
│   ├── main.py              # API FastAPI, cache LRU em memória e controle de sessões
│   ├── pdf_engine.py        # Ponte CLI com pdfcraft_probe + composição/flatten com PyMuPDF
│   └── static/              # Front-end HTML, CSS e JavaScript (Canvas)
├── deploy/
│   └── Caddyfile.example    # Modelo de configuração de proxy reverso e HTTPS com Caddy
├── pdfcraft_core/           # Núcleo em Rust (PdfCraft) e licenças de terceiros
├── docker-compose.yml       # Orquestração do container em produção usando imagem do GHCR
├── Dockerfile               # Build multi-stage (Rust builder + Python runtime enxuto)
├── LICENSE                  # Licença MIT do Fast PDFedit
├── README.md                # Documentação do projeto
└── requirements.txt         # Dependências Python (FastAPI, Uvicorn, PyMuPDF, etc.)
```

## Variáveis de Ambiente

| Variável | Descrição | Padrão |
| :--- | :--- | :--- |
| `PDFCRAFT_PROBE_EXE` | Caminho para o executável compilado `pdfcraft_probe` (ou `pdfcraft_probe.exe` no Windows). | `pdfcraft_core/target/release/pdfcraft_probe(.exe)` (fallback para `debug`) |
| `PDFCRAFT_PROBE_TIMEOUT` | Tempo limite (em segundos) para cada execução do binário `pdfcraft_probe`. | `30` (`25` no Docker) |
| `PDFCRAFT_DEBUG` | Quando definida como `1` ou `true`, habilita logs de depuração do motor Rust no `stderr`. | Desativado (`false`) |
| `MAX_FILE_SIZE_MB` | Tamanho máximo permitido (em MB) para upload de arquivos PDF. | `25` (`10` no Docker) |
| `MAX_STORED_FILES` | Número máximo de sessões de PDF mantidas simultaneamente em memória. | `50` (`8` no Docker) |
| `MAX_CACHED_PNGS` | Número máximo de páginas renderizadas em PNG mantidas em cache na memória. | `240` (`40` no Docker) |
| `MAX_CONCURRENT_PROBE_CALLS` | Limite de execuções simultâneas do motor Rust/PyMuPDF. | `4` (`1` no Docker) |
| `MAX_TEMP_PDFS` | Limite de arquivos PDF temporários mantidos em disco para o `pdfcraft_probe`. | `32` (`12` no Docker) |
| `SESSION_TTL_SECONDS` | Tempo de expiração (em segundos) das sessões e arquivos temporários inativos. | `3600` (`1800` no Docker) |

## Segurança e Privacidade

* Os arquivos enviados são processados exclusivamente em memória e em diretório temporário isolado durante a sessão ativa, sendo descartados automaticamente após o fechamento da sessão ou expiração do tempo limite (`SESSION_TTL_SECONDS`).
* Não há persistência permanente de documentos enviados pelos usuários no servidor.

## Licenças e Atribuições

* **Fast PDFedit**: licenciado sob a licença MIT (consulte o arquivo `LICENSE` na raiz do repositório).
* **Motor `pdfcraft_core` ([PdfCraft](https://github.com/storytold/pdfcraft.git) / [ArtCraft](https://getartcraft.com/))**: licenciado sob ambas as licenças MIT e Apache-2.0 (`MIT AND Apache-2.0`). Os textos completos e avisos de terceiros encontram-se em:
  * `pdfcraft_core/LICENSE-MIT`
  * `pdfcraft_core/LICENSE-APACHE`
  * `pdfcraft_core/NOTICE`
  * `pdfcraft_core/ATTRIBUTION.md`
  * `pdfcraft_core/licenses/`

> **Nota:** marcas, logotipos, fontes e dependências de terceiros (como ArtCraft, Lucide, fontes sob SIL OFL 1.1 e crates listadas em `NOTICE` e `ATTRIBUTION.md`) permanecem sujeitos às suas respectivas licenças e termos de uso.