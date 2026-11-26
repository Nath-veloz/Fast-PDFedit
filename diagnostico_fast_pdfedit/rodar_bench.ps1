param([string]$PdfPath, [string]$ProbePath, [string]$OutDir)
if (-not (Test-Path -LiteralPath $PdfPath)) { Write-Error ("PDF nao encontrado: " + $PdfPath); exit 1 }
if (-not (Test-Path -LiteralPath $ProbePath)) { Write-Error ("Probe nao encontrado: " + $ProbePath); exit 1 }
$tmpJson = Join-Path $env:TEMP "probe_fields_test.json"
$tmpEvalPdf = Join-Path $env:TEMP "probe_eval_out.pdf"
$tmpExpPdf = Join-Path $env:TEMP "probe_exp_out.pdf"
$tmpPng = Join-Path $env:TEMP "probe_page_1.png"
$inspectOut = & $ProbePath $PdfPath 2>&1 | Out-String
$firstField = $null
try { $parsed = $inspectOut | ConvertFrom-Json; if ($parsed.fields -and $parsed.fields.Count -gt 0) { $firstField = $parsed.fields[0].name } } catch {}
$payload = @{}
if ($firstField) { $payload[$firstField] = "15" }
($payload | ConvertTo-Json -Compress) | Set-Content -Path $tmpJson -Encoding UTF8
function Measure-Cmd([string]$name, [string[]]$cmdArgs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $output = & $ProbePath @cmdArgs 2>&1 | Out-String
  $sw.Stop()
  $trimmed = $output.Trim()
  $preview = if ($trimmed.Length -gt 300) { $trimmed.Substring(0, 300) } else { $trimmed }
  [PSCustomObject]@{ step = $name; elapsed_ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1); exit_code = $LASTEXITCODE; output_preview = $preview }
}
$results = @(
  (Measure-Cmd "inspect" @($PdfPath)),
  (Measure-Cmd "render_150dpi_p1" @("render", "--page", "1", "--dpi", "150", "--out", $tmpPng, $PdfPath)),
  (Measure-Cmd "eval_with_out" @("eval", "--fields-json", $tmpJson, "--out", $tmpEvalPdf, $PdfPath)),
  (Measure-Cmd "export" @("export", "--fields-json", $tmpJson, "--out", $tmpExpPdf, $PdfPath))
)
$results | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutDir "benchmark_probe.json") -Encoding UTF8
$results | Format-Table -AutoSize | Out-String | Set-Content -Path (Join-Path $OutDir "benchmark_probe.txt") -Encoding UTF8
Remove-Item $tmpJson, $tmpEvalPdf, $tmpExpPdf, $tmpPng -ErrorAction SilentlyContinue
Get-Content (Join-Path $OutDir "benchmark_probe.txt")
