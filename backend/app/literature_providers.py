"""官方来源适配：有界响应、固定公共地址与不含凭据的错误。"""
import asyncio
import html
import json
import logging
import re
import time
from urllib.parse import urlsplit, urljoin, unquote
from xml.etree import ElementTree as ET
import httpx
from pydantic import BaseModel, Field, field_validator
from .reading_service import fail
from .ai_provider import pinned_address, ProviderError


class RedactKey(logging.Filter):
    def filter(self, record):
        if "apikey=" in record.getMessage():
            record.msg = re.sub(r"(?i)(apikey=)[^&\s\"']+", r"\1[已隐藏]", record.getMessage())
            record.args = ()
        return True


logging.getLogger("httpx").addFilter(RedactKey())


class LiteratureRecord(BaseModel):
    provider: str
    source_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    authors: list[str] = Field(default_factory=list, max_length=100)
    abstract: str = Field(default="", max_length=20000)
    year: int | None = Field(default=None, ge=1800, le=2100)
    doi: str | None = Field(default=None, max_length=200)
    url: str = Field(max_length=2048)
    pdf_url: str | None = Field(default=None, max_length=2048)
    published: str = ""
    updated: str = ""
    version: str = ""
    venue: str = ""
    volume_id: str = ""
    category: str = ""
    date_precision: str = "unknown"
    source_revision: str = ""
    access: str = "public"

    @field_validator("authors")
    @classmethod
    def author_length(cls, values):
        return [v[:200] for v in values]


def text(value, limit=20000):
    return html.unescape(re.sub(r"<[^>]*>", "", str(value or ""))).strip()[:limit]


def year_of(value):
    match = re.search(r"\b(18\d{2}|19\d{2}|20\d{2}|2100)\b", str(value or ""))
    return int(match[0]) if match else None


ARXIV_ID = re.compile(r"(?:\d{4}\.\d{4,5}|[a-zA-Z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?$")
ACL_ID = re.compile(r"(?:[A-Z]\d{2}-\d{4,5}|\d{4}\.[a-zA-Z0-9_-]+\.\d+)$")


def identifier(provider, value):
    value = value.strip()
    if value.startswith(("http://", "https://")):
        parts = urlsplit(value)
        hosts = {"arxiv": {"arxiv.org", "www.arxiv.org"}, "acl": {"aclanthology.org", "www.aclanthology.org"}, "ieee": {"ieeexplore.ieee.org"}}
        if parts.hostname not in hosts.get(provider, set()) or parts.username or parts.password:
            fail("请选择对应来源的官方条目链接。", "invalid_identifier")
        value = unquote(parts.path).strip("/")
        if provider == "arxiv":
            value = re.sub(r"^(?:abs|pdf)/", "", value).removesuffix(".pdf")
        elif provider == "ieee":
            value = value.removeprefix("document/")
    if provider == "arxiv" and ARXIV_ID.fullmatch(value):
        return value
    if provider == "acl" and ACL_ID.fullmatch(value):
        return value
    if provider == "ieee" and re.fullmatch(r"\d{4,12}", value):
        return value
    fail("来源标识无效，请使用该来源的论文 ID 或官方条目链接。", "invalid_identifier")


class SourceHTTP:
    hosts = {"export.arxiv.org", "arxiv.org", "www.arxiv.org", "aclanthology.org", "www.aclanthology.org", "ieeexploreapi.ieee.org", "ieeexplore.ieee.org"}

    def __init__(self):
        self.transport = None

    async def fetch(self, url, *, params=None, limit=2 * 1024 * 1024, output=None, progress=None):
        try:
            for redirect in range(5):
                parts = urlsplit(url)
                if parts.scheme != "https" or parts.hostname not in self.hosts or parts.username or parts.password or parts.port not in {None, 443}:
                    fail("来源链接不在允许的官方地址范围内。", "unsafe_source_url")
                if self.transport is None:
                    target, authority, hostname = await asyncio.to_thread(pinned_address, url)
                    headers, extensions = {"Host": authority}, {"sni_hostname": hostname}
                else:
                    target, headers, extensions = url, {}, {}
                headers["User-Agent"] = "PaperBoard/0.5.0 (personal literature discovery)"
                async with httpx.AsyncClient(transport=self.transport, follow_redirects=False, trust_env=False,
                                             timeout=httpx.Timeout(30, connect=8)) as client:
                    async with client.stream("GET", target, params=params, headers=headers, extensions=extensions) as response:
                        if response.is_redirect:
                            if params and "apikey" in params:
                                fail("IEEE 接口发生异常跳转，请稍后重试。", "source_redirect", 502)
                            url = urljoin(url, response.headers.get("location", ""))
                            params = None
                            continue
                        if response.status_code in {401, 403}:
                            fail("来源拒绝请求，请检查 IEEE 密钥及授权状态，或通过机构页面核对访问权限。", "source_rejected", 502)
                        if response.status_code == 429:
                            fail("来源请求达到限流或配额，请稍后重试。", "source_rate_limited", 429)
                        if response.status_code == 404:
                            fail("来源暂未提供该论文或原文，请更新来源或核对标识。", "source_not_found", 404)
                        if not response.is_success:
                            fail("来源暂时不可用，请稍后重试。", "source_unavailable", 502)
                        content = bytearray()
                        size = 0
                        async for chunk in response.aiter_bytes():
                            size += len(chunk)
                            if size > limit:
                                fail("来源返回的数据超过大小限制。", "source_too_large", 413)
                            if progress:
                                await progress(size)
                            if output:
                                output.write(chunk)
                            else:
                                content.extend(chunk)
                        return bytes(content)
            fail("来源跳转次数过多，请查看官方来源。", "source_redirect", 502)
        except (httpx.TimeoutException, httpx.NetworkError):
            fail("来源连接超时或中断，请保留当前条件后重试。", "source_timeout", 504)
        except (httpx.HTTPError, ProviderError, OSError):
            fail("无法连接公共来源地址，请检查网络后重试。", "source_connection_failed", 502)


class RemoteSources:
    def __init__(self, http):
        self.http = http
        self.arxiv_lock, self.ieee_lock = asyncio.Lock(), asyncio.Lock()
        self.arxiv_last = self.ieee_last = 0.0
        self.arxiv_interval = 3.0

    async def arxiv(self, q, *, field="all", page=1, sort="relevance", year_from=None, year_to=None, category="", date_from="", date_to="", exact=False):
        params = {"start": (page - 1) * 20, "max_results": 20, "sortBy": "submittedDate" if sort == "year_desc" else "relevance", "sortOrder": "descending"}
        if exact or ARXIV_ID.fullmatch(q) or q.startswith("https://arxiv.org/"):
            params["id_list"] = identifier("arxiv", q)
        else:
            prefix = {"all": "all", "title": "ti", "author": "au", "abstract": "abs"}[field]
            terms = [f'{prefix}:"{part.replace(chr(34), "")}"' for part in re.findall(r'"[^"]+"|\S+', q)]
            if category:
                if not re.fullmatch(r"[a-zA-Z0-9.-]{1,40}", category):
                    fail("arXiv 学科分类格式无效。", "invalid_filter")
                terms.append("cat:" + category)
            if date_from or date_to or year_from or year_to:
                first = date_from.replace("-", "") if date_from else f"{year_from or 1991}0101"
                last = date_to.replace("-", "") if date_to else f"{year_to or 2100}1231"
                terms.append(f"submittedDate:[{first}0000 TO {last}2359]")
            params["search_query"] = " AND ".join(terms)
        async with self.arxiv_lock:
            await asyncio.sleep(max(0, self.arxiv_interval - (time.monotonic() - self.arxiv_last)))
            self.arxiv_last = time.monotonic()
            data = await self.http.fetch("https://export.arxiv.org/api/query", params=params)
        try:
            root = ET.fromstring(data)
            ns = {"a": "http://www.w3.org/2005/Atom", "o": "http://a9.com/-/spec/opensearch/1.1/", "x": "http://arxiv.org/schemas/atom"}
            records = []
            for entry in root.findall("a:entry", ns):
                raw_id = entry.findtext("a:id", "", ns).split("/abs/")[-1]
                if not ARXIV_ID.fullmatch(raw_id):
                    continue
                published = entry.findtext("a:published", "", ns)
                records.append(LiteratureRecord(provider="arxiv", source_id=raw_id, title=text(entry.findtext("a:title", "", ns), 500),
                    authors=[text(a.findtext("a:name", "", ns), 200) for a in entry.findall("a:author", ns)][:100],
                    abstract=text(entry.findtext("a:summary", "", ns)), published=published, updated=entry.findtext("a:updated", "", ns),
                    year=year_of(published), doi=entry.findtext("x:doi", None, ns), version=(re.search(r"v\d+$", raw_id) or [""])[0],
                    category=", ".join(c.get("term", "") for c in entry.findall("a:category", ns)), date_precision="day",
                    url="https://arxiv.org/abs/" + raw_id, pdf_url="https://arxiv.org/pdf/" + raw_id).model_dump())
            return {"items": records, "total": int(root.findtext("o:totalResults", str(len(records)), ns))}
        except (ValueError, ET.ParseError, TypeError):
            fail("arXiv 返回的数据无法解析，请稍后重试。", "source_invalid_response", 502)

    async def ieee(self, q, key, *, field="all", page=1, sort="relevance", year_from=None, year_to=None, exact=False):
        params = {"apikey": key, "format": "json", "max_records": 20, "start_record": (page - 1) * 20 + 1,
                  "sort_order": "desc", "sort_field": "publication_year" if sort == "year_desc" else "article_score"}
        if exact or q.startswith("https://ieeexplore.ieee.org/document/") or re.fullmatch(r"\d{4,12}", q):
            params["article_number"] = identifier("ieee", q)
        elif q.removeprefix("https://doi.org/").startswith("10."):
            params["doi"] = q.removeprefix("https://doi.org/")
        else:
            params[{"title": "article_title", "author": "author"}.get(field, "querytext")] = q
        if year_from:
            params["start_year"] = year_from
        if year_to:
            params["end_year"] = year_to
        async with self.ieee_lock:
            await asyncio.sleep(max(0, .15 - (time.monotonic() - self.ieee_last)))
            self.ieee_last = time.monotonic()
            data = await self.http.fetch("https://ieeexploreapi.ieee.org/api/v1/search/articles", params=params)
        try:
            payload = json.loads(data)
            if not isinstance(payload, dict) or ("articles" not in payload and "total_records" not in payload):
                raise ValueError()
            records = []
            for article in payload.get("articles", []):
                source_id = identifier("ieee", str(article["article_number"]))
                records.append(LiteratureRecord(provider="ieee", source_id=source_id, title=text(article.get("title"), 500),
                    authors=[text(a.get("full_name"), 200) for a in (article.get("authors") or {}).get("authors", [])][:100],
                    abstract=text(article.get("abstract")), year=year_of(article.get("publication_year")),
                    published=str(article.get("publication_year", "")), date_precision="year", doi=article.get("doi") or None,
                    venue=text(article.get("publication_title"), 500), access="institution", url="https://ieeexplore.ieee.org/document/" + source_id).model_dump())
            return {"items": records, "total": int(payload.get("total_records", len(records)))}
        except (ValueError, KeyError, TypeError):
            fail("IEEE 返回的数据无法解析，请检查接口授权后重试。", "source_invalid_response", 502)
