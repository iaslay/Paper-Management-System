"""模型配置、卡片内容与生成请求的严格结构。"""
from typing import Annotated, Literal
from pydantic import AfterValidator, Field, model_validator, field_validator
from .schemas import InputModel, RecordId, FileHash


def safe_text(value):
    value.encode("utf-8")
    return value.strip()


SafeText = Annotated[str, AfterValidator(safe_text)]
Origin = Literal["paper_fact", "author_claim", "system_inference", "user_record"]
PaperType = Literal["empirical", "theoretical", "survey", "other", "unknown"]


class ModelOptions(InputModel):
    provider: Literal["responses", "claude", "chat"] = "responses"
    base_url: SafeText = Field(default="https://api.openai.com/v1", max_length=2048)
    model: SafeText = Field(default="", max_length=200)
    enabled: bool = False
    auto_on_read: bool = False
    input_mode: Literal["auto", "pdf", "images"] = "auto"
    structured_output: bool = True
    batch_pages: int = Field(default=12, ge=1, le=30, strict=True)
    max_request_bytes: int = Field(default=20 * 1024 * 1024, ge=1024 * 1024, le=40 * 1024 * 1024, strict=True)
    image_long_edge: int = Field(default=1600, ge=800, le=3000, strict=True)
    max_output_tokens: int = Field(default=8000, ge=1024, le=16000, strict=True)
    max_calls: int = Field(default=40, ge=3, le=60, strict=True)
    input_tokens_per_page: int = Field(default=6000, ge=1000, le=100000, strict=True)
    max_task_tokens: int = Field(default=500000, ge=10000, le=50000000, strict=True)
    monthly_token_limit: int = Field(default=2000000, ge=10000, le=100000000, strict=True)
    timeout_seconds: int = Field(default=120, ge=10, le=120, strict=True)


class ModelWrite(ModelOptions):
    revision: int = Field(ge=0, strict=True)
    api_key: SafeText | None = Field(default=None, max_length=4096, repr=False)

    @field_validator("api_key")
    @classmethod
    def key_characters(cls, value):
        if value is not None:
            try:
                value.encode("ascii")
            except UnicodeError:
                raise ValueError("密钥需要使用服务提供的有效字符")
            if any(character.isspace() or ord(character) < 32 for character in value):
                raise ValueError("密钥不能包含空白或控制字符")
        return value


class ModelTest(InputModel):
    revision: int = Field(ge=1, strict=True)


class TaskCreate(InputModel):
    request_id: RecordId
    regenerate: bool = False
    note_ids: list[RecordId] = Field(default_factory=list, max_length=50)


class MetadataTaskCreate(InputModel):
    request_id: RecordId
    regenerate: bool = False


class WireEvidence(InputModel):
    source_page: int | None = Field(default=None, ge=1, strict=True)
    note_id: RecordId | None = None
    excerpt: SafeText = Field(default="", max_length=500)
    description: SafeText = Field(default="", max_length=300)

    @model_validator(mode="after")
    def one_source(self):
        if (self.source_page is None) == (self.note_id is None):
            raise ValueError("证据需要一个页面或个人记录来源")
        return self


class Evidence(InputModel):
    page_source_id: RecordId | None = None
    page_number: int | None = Field(default=None, ge=1, strict=True)
    note_id: RecordId | None = None
    excerpt: SafeText = Field(default="", max_length=500)
    description: SafeText = Field(default="", max_length=300)
    verification: Literal["unverified", "user_checked"] = "unverified"


class Claim(InputModel):
    text: SafeText = Field(default="", max_length=400)
    origin: Origin = "user_record"
    evidence: list[Evidence] = Field(default_factory=list, max_length=3)


class WireClaim(InputModel):
    text: SafeText = Field(max_length=400)
    origin: Origin
    evidence: list[WireEvidence] = Field(default_factory=list, max_length=3)


class Suggestion(InputModel):
    tag_id: int | None = Field(default=None, ge=1, strict=True)
    name: SafeText = Field(min_length=1, max_length=30)
    reason: SafeText = Field(max_length=100)
    evidence: list[Evidence] = Field(min_length=1, max_length=3)


class WireSuggestion(InputModel):
    tag_id: int | None = Field(default=None, ge=1, strict=True)
    name: SafeText | None = Field(default=None, max_length=30)
    reason: SafeText = Field(max_length=100)
    source_pages: list[Annotated[int, Field(ge=1, strict=True)]] = Field(min_length=1, max_length=3)


class ReadingPreview(InputModel):
    headline: SafeText = Field(min_length=1, max_length=40)
    problem: SafeText = Field(min_length=1, max_length=70)
    approach: SafeText = Field(min_length=1, max_length=90)
    benefit: SafeText = Field(min_length=1, max_length=70)


class CardContent(InputModel):
    schema_version: Literal["1.0"] = "1.0"
    summary: Claim = Field(default_factory=Claim)
    research_question: Claim = Field(default_factory=Claim)
    method: Claim = Field(default_factory=Claim)
    contributions: list[Claim] = Field(default_factory=list, max_length=3)
    findings: list[Claim] = Field(default_factory=list, max_length=3)
    limitations: list[Claim] = Field(default_factory=list, max_length=3)
    personal_value: SafeText = Field(default="", max_length=80)
    paper_type: PaperType = "unknown"
    research_direction_suggestions: list[Suggestion] = Field(default_factory=list, max_length=5)
    preview: ReadingPreview | None = None

    @model_validator(mode="after")
    def lengths(self):
        claims = [(self.summary, 150), (self.research_question, 200), (self.method, 400), *[(c, 200) for c in self.contributions], *[(c, 250) for c in self.findings], *[(c, 200) for c in self.limitations]]
        if any(len(c.text) > limit for c, limit in claims) or sum(len(c.text) for c, _ in claims) > 2000:
            raise ValueError("卡片字段或正文总量超过上限")
        return self


class WireCard(InputModel):
    schema_version: Literal["1.0"] = "1.0"
    summary: WireClaim
    research_question: WireClaim
    method: WireClaim
    contributions: list[WireClaim] = Field(default_factory=list, max_length=3)
    findings: list[WireClaim] = Field(default_factory=list, max_length=3)
    limitations: list[WireClaim] = Field(default_factory=list, max_length=3)
    paper_type: PaperType = "unknown"
    research_direction_suggestions: list[WireSuggestion] = Field(default_factory=list, max_length=5)
    preview: ReadingPreview | None = None


class CardWrite(InputModel):
    request_id: RecordId
    file_hash: FileHash
    card_revision: int = Field(ge=0, strict=True)
    base_version_id: RecordId | None = None
    data: CardContent


class CardConfirm(InputModel):
    request_id: RecordId
    card_revision: int = Field(ge=1, strict=True)


class DirectionAction(InputModel):
    request_id: RecordId
    paper_revision: int = Field(ge=1, strict=True)
    create_new: bool = False
