"""论文信息的视觉识别结构、证据校验、分批合并与分类暂存。"""
import json
from datetime import datetime
from typing import Annotated, Literal
from pydantic import Field, ValidationError
from sqlalchemy import select
from .schemas import InputModel, TagInput
from .ai_schemas import SafeText
from .models import Tag, TagName
from . import reading_service as reading
from . import services as management

KINDS = ("research_direction", "topic", "general")
FIELDS = ("title", "authors", "year", "doi")
Pages = list[Annotated[int, Field(ge=1, strict=True)]]


class TextField(InputModel):
    value: SafeText | None = Field(default=None, max_length=500)
    source_pages: Pages = Field(default_factory=list, max_length=3)


class AuthorsField(InputModel):
    value: list[Annotated[SafeText, Field(min_length=1, max_length=100)]] = Field(default_factory=list, max_length=100)
    source_pages: Pages = Field(default_factory=list, max_length=3)


class YearField(InputModel):
    value: int | None = Field(default=None, ge=1500, strict=True)
    source_pages: Pages = Field(default_factory=list, max_length=3)


class Classification(InputModel):
    kind: Literal["research_direction", "topic", "general"]
    tag_id: int | None = Field(default=None, ge=1, strict=True)
    name: SafeText = Field(min_length=1, max_length=50)
    reason: SafeText = Field(max_length=100)
    source_pages: Pages = Field(min_length=1, max_length=3)


class WireMetadata(InputModel):
    title: TextField
    authors: AuthorsField
    year: YearField
    doi: TextField
    classifications: list[Classification] = Field(default_factory=list, max_length=9)


def normalize(raw, pages, dictionary):
    try:
        parsed = WireMetadata.model_validate(raw).model_dump()
    except ValidationError:
        reading.fail("论文信息的字段、长度或页码格式无效。", "invalid_metadata")
    def sources(numbers):
        if any(number not in pages for number in numbers):
            reading.fail("论文信息引用超出本次输入页序。", "invalid_evidence")
        return [{"page_source_id": pages[n]["id"], "page_number": pages[n]["page_number"]} for n in dict.fromkeys(numbers)]
    warnings, fields = [], {}
    for field in FIELDS:
        value = parsed[field]["value"]
        if field == "year" and value and value > datetime.now().year + 1:
            reading.fail("识别的发表年份不在有效范围内。", "invalid_metadata")
        if field == "doi" and value:
            value = value.removeprefix("https://doi.org/").removeprefix("http://doi.org/").strip()
            if len(value) > 200 or not value.startswith("10.") or "/" not in value or any(c.isspace() for c in value):
                reading.fail("识别的 DOI 格式无效，不能填入表单。", "invalid_metadata")
        evidence = sources(parsed[field]["source_pages"])
        if value and not evidence:
            reading.fail("识别的论文信息缺少页面来源。", "invalid_evidence")
        fields[field] = {"value": value if value else ([] if field == "authors" else None), "sources": evidence}
    labels, seen = [], set()
    by_id = {item["id"]: item for item in dictionary}
    for candidate in parsed["classifications"]:
        name, kind = candidate["name"], candidate["kind"]
        tag = by_id.get(candidate["tag_id"])
        if candidate["tag_id"] and (tag is None or tag["kind"] != kind):
            warnings.append("一个分类建议不属于本次可用字典，已跳过。")
            continue
        if tag:
            name = tag["name"]
        else:
            key = management.normalize(name)
            tag = next((item for item in dictionary if item["kind"] == kind and any(management.normalize(alias) == key for alias in [item["name"], *item["aliases"]])), None)
            if tag:
                name = tag["name"]
        key = (kind, management.normalize(name))
        if key in seen or len(name) > (50 if kind == "topic" else 30):
            continue
        if sum(item["kind"] == kind for item in labels) >= 3:
            continue
        seen.add(key)
        labels.append({"kind": kind, "tag_id": tag["id"] if tag else None, "name": name, "reason": candidate["reason"], "sources": sources(candidate["source_pages"])})
    return {"fields": fields, "classifications": labels, "warnings": warnings}, warnings


def merge(results):
    merged = {"fields": {name: {"value": [] if name == "authors" else None, "sources": []} for name in FIELDS}, "classifications": [], "warnings": []}
    seen = set()
    for result in results:
        merged["warnings"] += result["warnings"]
        for name in FIELDS:
            value, current = result["fields"][name], merged["fields"][name]
            if not current["value"] and value["value"]:
                merged["fields"][name] = value
            elif current["value"] and value["value"] and current["value"] != value["value"]:
                merged["warnings"].append(f"不同页段的 {dict(title='标题',authors='作者',year='年份',doi='DOI')[name]} 不一致，保留前部页段结果，请核对。")
        for label in result["classifications"]:
            key = (label["kind"], management.normalize(label["name"]))
            if key not in seen and sum(item["kind"] == label["kind"] for item in merged["classifications"]) < 3:
                seen.add(key); merged["classifications"].append(label)
    merged["warnings"] = list(dict.fromkeys(merged["warnings"]))
    return merged


def prompt(snapshot, pages):
    rules = "识别论文信息，只返回给定结构的 JSON。保留论文原始标题和全部作者的原始拼写。年份与 DOI 只依据原文，禁止猜测、外部查询或从文件名推断。无法确定的文本或年份 value 为 null，作者为空数组，且 source_pages 为空。每个已识别字段必须引用输入局部页序。区分作者与单位、参考文献作者。分类包含研究方向、主题、普通标签，每类最多三项；名称和理由用中文，方向及普通标签名≤30字符，主题≤50字符。优先使用现有分类的 tag_id；新分类 tag_id 为 null。source_pages 只能引用当前附件局部页序。阅读状态由用户维护，不生成。"
    return rules + "\n输入数据：" + json.dumps({"page_manifest": [{"source_page": n, "original_page": s["page_number"]} for n, s in pages.items()], "classification_dictionary": snapshot["classification_dictionary"], "schema": WireMetadata.model_json_schema()}, ensure_ascii=False, separators=(",", ":"))


def resolve_new_labels(db, workspace, labels):
    groups = {kind: [] for kind in KINDS}
    for value in labels:
        row = db.scalar(select(TagName).where(TagName.workspace_id == workspace, TagName.kind == value.kind, TagName.normalized_name == management.normalize(value.name)))
        tag = db.get(Tag, row.tag_id) if row else None
        visited = set()
        while tag and tag.merged_into_id and tag.id not in visited:
            visited.add(tag.id); tag = db.get(Tag, tag.merged_into_id)
        if tag and (tag.workspace_id != workspace or tag.kind != value.kind or tag.deleted_at is not None):
            reading.fail("所选新分类已归档或不可用，请修改建议或在分类管理中恢复。", "invalid_classification", 409)
        if tag is None:
            tag = management.save_tag(db, workspace, TagInput(name=value.name, kind=value.kind))
        groups[value.kind].append(tag.id)
    return groups
