"""API 输入规范，所有校验错误由界面显示中文提示。"""

from datetime import datetime, timezone
from typing import Literal, Annotated
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Status = Literal["unread", "reading", "read"]
Kind = Literal["research_direction", "general", "topic"]


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Credentials(InputModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=12, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def validate_username(cls, value):
        if not isinstance(value, str):
            return value
        if not value.strip():
            raise ValueError("用户名不能为空")
        return value.strip()


class Setup(Credentials):
    workspace_name: str = Field(default="我的论文库", min_length=1, max_length=50)

    @field_validator("workspace_name")
    @classmethod
    def validate_name(cls, value):
        if not value.strip():
            raise ValueError("论文库名称不能为空")
        return value.strip()


class NewLabel(InputModel):
    name: str = Field(min_length=1, max_length=50)
    kind: Kind


class PaperUpdate(InputModel):
    revision: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=500)
    authors: list[str] | None = Field(default=None, max_length=100)
    year: int | None = None
    doi: str | None = Field(default=None, max_length=200)
    reading_status: Status | None = None
    is_favorite: bool | None = None
    research_direction_ids: list[int] | None = Field(default=None, max_length=10)
    tag_ids: list[int] | None = Field(default=None, max_length=20)
    topic_ids: list[int] | None = Field(default=None, max_length=10)
    new_labels: list[NewLabel] = Field(default_factory=list, max_length=9)
    request_id: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    file_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def new_label_receipt(self):
        if self.new_labels and (not self.request_id or not self.file_hash):
            raise ValueError("新分类需要原文标识和保存请求标识")
        return self

    @field_validator("title")
    @classmethod
    def validate_title(cls, value):
        if value is not None and not value.strip():
            raise ValueError("论文标题不能为空")
        return value.strip() if value else value

    @field_validator("authors")
    @classmethod
    def validate_authors(cls, value):
        if value is not None and any(not name.strip() or len(name) > 100 for name in value):
            raise ValueError("作者姓名需要为 1～100 个字符")
        return [name.strip() for name in value] if value is not None else None

    @field_validator("year")
    @classmethod
    def validate_year(cls, value):
        if value is not None and not 1500 <= value <= datetime.now(timezone.utc).year + 1:
            raise ValueError("请填写有效的发表年份")
        return value


class TagInput(InputModel):
    name: str = Field(min_length=1, max_length=50)
    kind: Kind = "research_direction"
    aliases: list[str] = Field(default_factory=list, max_length=10)


class TagUpdate(TagInput):
    revision: int = Field(ge=1)


class MergeInput(InputModel):
    target_id: int = Field(ge=1)
    revision: int = Field(ge=1)
    target_revision: int = Field(ge=1)


class BatchInput(InputModel):
    paper_ids: list[str] = Field(min_length=1, max_length=100)
    direction_ids: list[int] = Field(min_length=1, max_length=10)
    operation: Literal["add", "remove"]


class DirectionInput(InputModel):
    revision: int = Field(ge=1)
    research_direction_ids: list[int] = Field(max_length=10)


RecordId = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]
FileHash = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
FiniteNumber = Annotated[float, Field(allow_inf_nan=False)]
HighlightColor = Literal["yellow", "green", "blue", "pink"]
NoteType = Literal["page_note", "annotation_comment", "personal_insight"]
InsightKind = Literal["understanding", "question", "application"]


class ReadingWrite(InputModel):
    request_id: RecordId


class PositionWrite(ReadingWrite):
    revision: int = Field(ge=1, strict=True)
    file_hash: FileHash
    page_number: int = Field(ge=1, strict=True)
    zoom_mode: Literal["fit_width", "custom"]
    zoom: Annotated[float, Field(ge=.5, le=3, allow_inf_nan=False)] | None = None
    view_rotation: Literal[0, 90, 180, 270] = 0

    @model_validator(mode="after")
    def zoom_matches_mode(self):
        if (self.zoom_mode == "custom") != (self.zoom is not None):
            raise ValueError("缩放模式与比例不一致")
        return self


class NoteCreate(ReadingWrite):
    file_hash: FileHash
    note_type: NoteType
    content: str = Field(min_length=1, max_length=10000)
    page_number: int | None = Field(default=None, ge=1, strict=True)
    annotation_id: RecordId | None = None
    insight_kind: InsightKind | None = None

    @field_validator("content")
    @classmethod
    def not_blank(cls, value):
        if not value.strip():
            raise ValueError("内容不能为空")
        value.encode("utf-8")
        return value


class NoteEdit(ReadingWrite):
    revision: int = Field(ge=1, strict=True)
    content: str | None = Field(default=None, min_length=1, max_length=10000)
    page_number: int | None = Field(default=None, ge=1, strict=True)
    insight_kind: InsightKind | None = None

    @field_validator("content")
    @classmethod
    def not_blank(cls, value):
        if value is None or not value.strip():
            raise ValueError("内容不能为空")
        value.encode("utf-8")
        return value


class AnnotationCreate(ReadingWrite):
    file_hash: FileHash
    page_source_id: RecordId
    page_number: int = Field(ge=1, strict=True)
    quote: str = Field(min_length=1, max_length=2000)
    rects: list[tuple[FiniteNumber, FiniteNumber, FiniteNumber, FiniteNumber]] = Field(min_length=1, max_length=200)
    color: HighlightColor = "yellow"
    comment: str | None = Field(default=None, min_length=1, max_length=10000)

    @field_validator("quote", "comment")
    @classmethod
    def not_blank(cls, value):
        if value is not None and not value.strip():
            raise ValueError("摘录或评论不能为空")
        if value is not None:
            value.encode("utf-8")
        return value


class AnnotationEdit(ReadingWrite):
    revision: int = Field(ge=1, strict=True)
    color: HighlightColor


class ReadingDelete(ReadingWrite):
    revision: int = Field(ge=1, strict=True)
