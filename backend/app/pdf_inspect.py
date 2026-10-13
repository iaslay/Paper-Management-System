"""隔离检查 PDF；主服务为子进程设置超时，不识别图片中的文字。"""

import json
import sys
import math
from pathlib import Path
from pypdf import PdfReader


def inspect_pdf(path):
    try:
        with open(path, "rb") as stream:
            if b"%PDF-" not in stream.read(1024):
                return {"error": "文件内容不是有效的 PDF，请重新选择文件。"}
        reader = PdfReader(path, strict=False)
        if reader.is_encrypted:
            return {"error": "这份 PDF 已加密，请先提供可读取的副本。"}
        pages = len(reader.pages)
        if pages < 1:
            return {"error": "PDF 没有可阅读的页面。"}
        metadata = reader.metadata
        title = str(metadata.title or "").strip()[:500] if metadata else ""
        author = str(metadata.author or "").strip()[:100] if metadata else ""
        sources = []
        for number, page in enumerate(reader.pages, 1):
            try:
                media, crop = [float(v) for v in page.mediabox], [float(v) for v in page.cropbox]
                box = [max(media[0], crop[0]), max(media[1], crop[1]), min(media[2], crop[2]), min(media[3], crop[3])]
                if box[0] >= box[2] or box[1] >= box[3]:
                    box = media
                rotation, unit = int(page.get("/Rotate", 0)), float(page.get("/UserUnit", 1))
                if not all(math.isfinite(v) for v in [*box, unit]) or box[0] >= box[2] or box[1] >= box[3] or unit <= 0 or rotation % 90:
                    continue
                sources.append({"page_number": number, "view_box": box, "intrinsic_rotation": rotation % 360, "user_unit": unit})
            except Exception:
                continue
        return {"page_count": pages, "title": title, "authors": [author] if author else [], "page_sources": sources}
    except Exception:
        return {"error": "无法读取这份 PDF，文件可能损坏，请检查后重新上传。"}


if __name__ == "__main__":
    print(json.dumps(inspect_pdf(Path(sys.argv[1])), ensure_ascii=True))
