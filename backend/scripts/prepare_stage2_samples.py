"""只为第二阶段独立验收目录生成样本并上传，不操作正式数据。"""

import io
import hashlib
import sqlite3
from pathlib import Path
import httpx
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, ArrayObject, TextStringObject, NumberObject, DecodedStreamObject, RectangleObject

root = Path(__file__).resolve().parents[2]
destination = root / ".test-data" / "stage2-samples"
destination.mkdir(parents=True, exist_ok=True)
samples = [("中文阅读与记录校验", 3), ("英文双栏校验", 3), ("多行文本与连字校验", 2), ("带目录阅读校验", 3), ("无目录阅读校验", 2), ("旋转页与非零边界校验", 3), ("扫描页阅读校验", 2), ("混合页面与长文校验", 280)]


def fonts(writer):
    child = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/CIDFontType0"), NameObject("/BaseFont"): NameObject("/STSong-Light"), NameObject("/CIDSystemInfo"): DictionaryObject({NameObject("/Registry"): TextStringObject("Adobe"), NameObject("/Ordering"): TextStringObject("GB1"), NameObject("/Supplement"): NumberObject(0)})})
    chinese = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type0"), NameObject("/BaseFont"): NameObject("/STSong-Light"), NameObject("/Encoding"): NameObject("/UniGB-UCS2-H"), NameObject("/DescendantFonts"): ArrayObject([writer._add_object(child)])}))
    english = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Times-Roman")}))
    return DictionaryObject({NameObject("/F1"): chinese, NameObject("/F2"): english})


for name, count in samples:
    writer = PdfWriter()
    resources = fonts(writer)
    for number in range(count):
        page = writer.add_blank_page(width=595, height=842)
        stream = DecodedStreamObject()
        scanned = name.startswith("扫描") or (name.startswith("混合") and number in (1, 4))
        if scanned:
            # 位图示意只用于检查无文本层分支，不冒充真实论文内容。
            bitmap = DecodedStreamObject()
            bitmap.set_data(bytes(40 if 8 <= y % 16 <= 10 and 6 <= x < 57 else 240 for y in range(80) for x in range(64)))
            bitmap.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Image"), NameObject("/Width"): NumberObject(64), NameObject("/Height"): NumberObject(80), NameObject("/ColorSpace"): NameObject("/DeviceGray"), NameObject("/BitsPerComponent"): NumberObject(8)})
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Scan"): writer._add_object(bitmap)})})
            stream.set_data(b"q 450 0 0 600 60 120 cm /Scan Do Q")
        else:
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): resources})
            lines = [name, f"这是第 {number + 1} 页，仅用于阅读功能验收。", "研究方向：智能体、检索增强生成。", "这里验证多行选区、高亮坐标和页码笔记。", "我的理解、待解决疑问和可能用途分别保存。", "关闭后继续阅读，内容由本机数据库持久化。"]
            commands = "BT /F1 16 Tf 55 755 Td " + " ".join(("0 -32 Td " if i else "") + "<" + line.encode("utf-16-be").hex() + "> Tj" for i, line in enumerate(lines)) + " ET\n"
            if name.startswith("英文") or name.startswith("多行"):
                for x, rows in [(55, ["Research method and evaluation", "Retrieval augmented generation", "Compare experimental conditions.", "Read and record a research question."]), (310, ["Results under different settings", "Agent planning and memory", "A separate column is shown here.", "Avoid highlighting the blank gap."])]:
                    commands += f"BT /F2 12 Tf {x} 490 Td " + " ".join(("0 -22 Td " if i else "") + "(" + line + ") Tj" for i, line in enumerate(rows)) + " ET\n"
            stream.set_data(commands.encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)
        if name.startswith("旋转"):
            page.cropbox = RectangleObject([20, 30, 575, 820])
            page.rotate(number * 90)
    if name.startswith("带目录"):
        writer.add_outline_item("第一章：阅读与定位", 0)
        writer.add_outline_item("第二章：笔记与高亮", 1)
        writer.add_outline_item("第三章：继续阅读", 2)
    writer.add_metadata({"/Title": name, "/Author": "第二阶段合成验收样本"})
    output = io.BytesIO(); writer.write(output)
    (destination / (name + ".pdf")).write_bytes(output.getvalue())

with httpx.Client(base_url="http://127.0.0.1:8000", headers={"X-Paperboard-Request": "1"}, timeout=60) as client:
    client.post("/api/v1/session", json={"username": "ui-check", "password": "browser-check-2026"}).raise_for_status()
    # 通过会话回执确认服务确实连接独立验收库，避免向其他数据目录上传样本。
    token_hash = hashlib.sha256(client.cookies["paperboard_session"].encode()).hexdigest()
    qa_database = root / ".test-data" / "stage2-browser" / "paperboard.sqlite3"
    with sqlite3.connect(qa_database.as_uri() + "?mode=ro", uri=True) as db:
        if db.execute("SELECT 1 FROM sessions WHERE token_hash=?", (token_hash,)).fetchone() is None:
            raise RuntimeError("当前服务未连接第二阶段独立验收库，已停止上传样本。")
    for name, _ in samples:
        content = (destination / (name + ".pdf")).read_bytes()
        client.post("/api/v1/papers", files={"file": (name + ".pdf", content, "application/pdf")}).raise_for_status()
print("八份第二阶段样本已保存并上传到当前独立验收服务。")
