import json
import os
import sys

try:
    import pypdfium2 as pdfium
except Exception as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(2)

source_path, output_dir, scale = sys.argv[1], sys.argv[2], float(sys.argv[3])
os.makedirs(output_dir, exist_ok=True)
document = pdfium.PdfDocument(source_path)
pages = []
for index in range(len(document)):
    page = document[index]
    bitmap = page.render(scale=scale)
    output_path = os.path.join(output_dir, f"page-{index + 1}.png")
    bitmap.to_pil().save(output_path, format="PNG")
    pages.append({"pageNumber": index + 1, "path": output_path})
print(json.dumps({"pages": pages}, ensure_ascii=False))
