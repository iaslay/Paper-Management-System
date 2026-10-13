"""在隔离进程中准备完整页段或页面图片，不执行 OCR。"""
import io
import json
import sys
from pathlib import Path
from pypdf import PdfReader, PdfWriter


def prepare(path, pages, mode, edge):
    if mode == "pdf":
        reader, writer = PdfReader(path), PdfWriter()
        for number in pages:
            writer.add_page(reader.pages[number - 1])
        output = io.BytesIO(); writer.write(output)
        return [("pdf", output.getvalue(), 0)]
    import pypdfium2 as pdfium
    output = []
    with pdfium.PdfDocument(path) as document:
        for local, number in enumerate(pages, 1):
            page = document[number - 1]
            try:
                width, height = page.get_size()
                scale = min(edge / max(width, height), (6000000 / (width * height)) ** .5)
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil().convert("RGB")
                    buffer = io.BytesIO(); image.save(buffer, format="JPEG", quality=88)
                    output.append(("image", buffer.getvalue(), local))
                finally:
                    bitmap.close()
            finally:
                page.close()
    return output


if __name__ == "__main__":
    path, output_dir, mode, edge, page_numbers = sys.argv[1:]
    destination = Path(output_dir)
    manifest = []
    for index, (kind, data, local) in enumerate(prepare(path, json.loads(page_numbers), mode, int(edge))):
        filename = f"input-{index}.{'pdf' if kind == 'pdf' else 'jpg'}"
        (destination / filename).write_bytes(data)
        manifest.append({"kind": kind, "filename": filename, "local_page": local})
    print(json.dumps(manifest))
