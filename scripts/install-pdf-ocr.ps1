$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot ".venv-pdf\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
  throw "Create .venv-pdf first with uv; missing $python"
}
$env:UV_DEFAULT_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"
uv pip install --python $python pypdf pypdfium2 pytesseract
Write-Output "PDF OCR Python packages installed with UV_DEFAULT_INDEX=$env:UV_DEFAULT_INDEX"
Write-Output "The local adapter also needs a Tesseract executable with chi_sim and eng language data for image-only PDFs."
