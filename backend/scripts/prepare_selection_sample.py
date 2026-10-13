"""生成图片底图与隐藏文字层样本，仅上传至第二阶段独立验收库。"""

import hashlib
import io
import sqlite3
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
# 系统 Python 提供绘图工具，应用依赖使用项目已经安装的环境。
sys.path.insert(0, str(root / ".venv" / "Lib" / "site-packages"))
from PIL import Image, ImageDraw, ImageFont
import httpx
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, NumberObject, DecodedStreamObject


def main():
    destination = root / ".test-data" / "stage2-samples" / "图片底图与隐藏文字层校验.pdf"
    destination.parent.mkdir(parents=True, exist_ok=True)
    title = "图片底图与隐藏文字层校验"
    rows = ["Research method and evaluation", "Retrieval augmented generation", "Compare experimental conditions.", "Read and record a research question.", "Select multiple lines without moving the page."]
    image = Image.new("RGB", (1190, 1684), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 32)
    for index, line in enumerate(rows):
        draw.text((110, 200 + index * 64), line, font=font, fill="black", anchor="ls")
    writer = PdfWriter()
    page = writer.add_blank_page(width=595, height=842)
    bitmap = DecodedStreamObject()
    bitmap.set_data(image.tobytes())
    bitmap.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"), NameObject("/Width"): NumberObject(1190), NameObject("/Height"): NumberObject(1684), NameObject("/ColorSpace"): NameObject("/DeviceRGB"), NameObject("/BitsPerComponent"): NumberObject(8)})
    font_object = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Scan"): writer._add_object(bitmap)}), NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font_object)})})
    stream = DecodedStreamObject()
    # 文字渲染模式 3：文字只用于复制和选区，肉眼看到的内容来自整页位图。
    commands = "q 595 0 0 842 0 0 cm /Scan Do Q\nBT /F1 16 Tf 3 Tr 55 742 Td "
    commands += " ".join(("0 -32 Td " if index else "") + "(" + line + ") Tj" for index, line in enumerate(rows)) + " ET"
    stream.set_data(commands.encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    page.compress_content_streams()
    writer.add_metadata({"/Title": title, "/Author": "拖选交互合成验收样本"})
    buffer = io.BytesIO(); writer.write(buffer)
    content = buffer.getvalue(); destination.write_bytes(content)
    assert PdfReader(io.BytesIO(content)).pages[0].extract_text().splitlines() == rows
    with httpx.Client(base_url="http://localhost:8011", headers={"X-Paperboard-Request": "1"}, timeout=60) as client:
        client.post("/api/v1/session", json={"username": "ui-check", "password": "browser-check-2026"}).raise_for_status()
        token_hash = hashlib.sha256(client.cookies["paperboard_session"].encode()).hexdigest()
        database = root / ".test-data" / "stage2-browser" / "paperboard.sqlite3"
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            if db.execute("SELECT 1 FROM sessions WHERE token_hash=?", (token_hash,)).fetchone() is None:
                raise RuntimeError("当前服务未连接独立验收库，已停止上传。")
        response = client.post("/api/v1/papers", files={"file": (destination.name, content, "application/pdf")})
        response.raise_for_status()
    print("图片底图与隐藏文字层样本已保存并上传至独立验收库。")


if __name__ == "__main__":
    main()
