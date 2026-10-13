"""仅初始化独立的浏览器验收环境，并创建合成 PDF 样本。"""

import io
from pathlib import Path
import httpx
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, ArrayObject, TextStringObject, NumberObject, DecodedStreamObject

root = Path(__file__).resolve().parents[2]
samples = root / ".test-data" / "samples"
samples.mkdir(parents=True, exist_ok=True)

for name in ["浏览器验收：智能体与检索", "浏览器验收：多模态阅读", "浏览器验收：待分类论文"]:
    writer = PdfWriter()
    child = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/CIDFontType0"), NameObject("/BaseFont"): NameObject("/STSong-Light"), NameObject("/CIDSystemInfo"): DictionaryObject({NameObject("/Registry"): TextStringObject("Adobe"), NameObject("/Ordering"): TextStringObject("GB1"), NameObject("/Supplement"): NumberObject(0)})})
    font = writer._add_object(DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type0"), NameObject("/BaseFont"): NameObject("/STSong-Light"), NameObject("/Encoding"): NameObject("/UniGB-UCS2-H"), NameObject("/DescendantFonts"): ArrayObject([writer._add_object(child)])}))
    for number in range(2):
        page = writer.add_blank_page(width=595, height=842)
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
        stream = DecodedStreamObject()
        lines = [name, "此文件仅用于论文看板的浏览器验收。", "测试上传、分类、检索和私有原文预览。", f"这是第 {number + 1} 页，不包含真实研究结论。"]
        commands = "BT /F1 16 Tf 55 755 Td " + " ".join(("0 -35 Td " if i else "") + "<" + line.encode("utf-16-be").hex() + "> Tj" for i, line in enumerate(lines)) + " ET"
        stream.set_data(commands.encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)
    writer.add_metadata({"/Title": name, "/Author": "合成验收样本"})
    writer.write(str(samples / (name.replace("：", "-") + ".pdf")))

with httpx.Client(base_url="http://127.0.0.1:8000", headers={"X-Paperboard-Request": "1"}) as client:
    state = client.get("/api/v1/status").json()
    credentials = {"username": "ui-check", "password": "browser-check-2026"}
    response = client.post("/api/v1/session" if state["initialized"] else "/api/v1/setup", json=credentials if state["initialized"] else {**credentials, "workspace_name": "浏览器验收空间"})
    response.raise_for_status()
    names = {item["name"] for item in client.get("/api/v1/tags").json()}
    for name, aliases in [("智能体", ["Agent"]), ("检索增强生成", ["RAG"])]:
        if name not in names:
            client.post("/api/v1/tags", json={"name": name, "kind": "research_direction", "aliases": aliases}).raise_for_status()
print("独立验收账号和三份合成 PDF 已准备；正式数据目录未初始化账号。")
