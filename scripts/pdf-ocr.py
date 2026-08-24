import json
import sys

source_path = sys.argv[1]
options = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

try:
    import pypdfium2 as pdfium
    import pytesseract
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(2)

try:
    document = pdfium.PdfDocument(source_path)
    if options.get("maxPages") and len(document) > options["maxPages"]:
        print("OCR page limit exceeded", file=sys.stderr)
        raise SystemExit(1)
    pages = []
    for number in range(len(document)):
        image = document[number].render(scale=1.5).to_pil()
        text = pytesseract.image_to_string(image, lang="chi_sim+eng").strip()
        pages.append({
            "pageNumber": number + 1,
            "status": "succeeded",
            "blocks": ([{"kind": "text", "order": 0, "text": text}] if text else []),
            "warnings": ([] if text else ["ocr-empty-page"])
        })
    if not all(page["blocks"] for page in pages):
        print("OCR returned an empty page", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps({
        "pages": pages,
        "capabilities": {"text": True, "table": False, "formula": False},
        "warnings": ["table-recognition-not-configured", "formula-recognition-not-configured"]
    }, ensure_ascii=False))
except SystemExit:
    raise
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(2)
