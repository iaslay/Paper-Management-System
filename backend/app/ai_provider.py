"""视觉接口适配、固定地址连接与有界响应解析。"""
import asyncio
import base64
import ipaddress
import json
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit
import httpx
from .reading_service import fail


class ProviderError(Exception):
    def __init__(self, message, code="provider_error", retryable=False, uncertain=False, retry_after=0):
        super().__init__(message)
        self.code, self.retryable, self.uncertain = code, retryable, uncertain
        self.retry_after = min(60, max(0, retry_after))
        self.input_tokens = self.output_tokens = self.request_id = None


@dataclass
class ModelResult:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    request_id: str | None = None


ENDPOINTS = {"responses": "/responses", "claude": "/messages", "chat": "/chat/completions"}


def normalize_base_url(value, provider, allow_local=False):
    validate_url(value, allow_local)
    parts = urlsplit(value.strip().rstrip("/"))
    path = parts.path
    for protocol, endpoint in ENDPOINTS.items():
        if path.endswith(endpoint):
            if protocol != provider:
                fail("完整接口地址与所选接口类型不一致，请修改接口类型或填写服务基础地址。", "endpoint_mismatch")
            path = path[:-len(endpoint)]
            if any(path.endswith(suffix) for suffix in ENDPOINTS.values()):
                fail("服务地址重复包含接口路径，请只保留一次接口路径或填写基础地址。", "invalid_model_url")
            break
    return parts._replace(path=path).geturl()


def is_deepseek(options):
    return urlsplit(options["base_url"]).hostname == "api.deepseek.com"


def normalize_options(options, allow_local=False):
    options = dict(options)
    options["base_url"] = normalize_base_url(options["base_url"], options["provider"], allow_local)
    if is_deepseek(options) and options["model"].casefold() == "deepseek-v4.1-flash":
        # 展示名称对应官方 API 标识，保持同一个模型而非替换模型。
        options["model"] = "deepseek-flash"
    return options


def validate_url(value, allow_local=False):
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        fail("服务地址格式不正确。", "invalid_model_url")
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment or (parts.scheme != "https" and not (allow_local and parts.scheme == "http" and parts.hostname in {"localhost", "127.0.0.1", "::1"})):
        fail("请填写不含凭证和查询参数的 HTTPS 服务地址。", "invalid_model_url")
    try:
        address = ipaddress.ip_address(parts.hostname)
        if not address.is_global and not (allow_local and address.is_loopback):
            fail("模型服务不能使用内网或保留地址。", "invalid_model_url")
    except ValueError:
        if parts.hostname.lower() == "localhost" and not allow_local:
            fail("模型服务不能使用本机地址。", "invalid_model_url")
    return parts.hostname, port or (443 if parts.scheme == "https" else 80)


def pinned_address(url, allow_local=False):
    host, port = validate_url(url, allow_local)
    try:
        addresses = list(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
    except OSError:
        raise ProviderError("模型服务地址无法解析，请检查地址和网络。", "connection_failed", True)
    if not addresses or any(not ipaddress.ip_address(value).is_global and not (allow_local and ipaddress.ip_address(value).is_loopback) for value in addresses):
        raise ProviderError("模型服务解析到了不允许的本机、内网或保留地址。", "invalid_model_url")
    selected = next((value for value in addresses if ipaddress.ip_address(value).version == 4), addresses[0])
    url_object = httpx.URL(url)
    authority = url_object.netloc.decode("ascii")
    return url_object.copy_with(host=selected), authority, url_object.raw_host.decode("ascii")


def strict_schema(schema):
    schema = json.loads(json.dumps(schema))
    def visit(value):
        if isinstance(value, dict):
            value.pop("default", None)
            if value.get("type") == "object":
                value["required"] = list(value.get("properties", {}))
                value["additionalProperties"] = False
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(schema)
    return schema


class VisionProvider:
    def __init__(self, options, key, allow_local=False, transport=None):
        self.options, self.key, self.allow_local, self.transport = normalize_options(options, allow_local), key, allow_local, transport

    def build(self, prompt, system, attachments, schema=None, max_output=None):
        options = self.options
        limit = max_output or options["max_output_tokens"]
        content = []
        for attachment in attachments:
            encoded = base64.b64encode(attachment["data"]).decode("ascii")
            if attachment["kind"] == "pdf":
                if is_deepseek(options) and options["provider"] == "responses":
                    raise ProviderError("DeepSeek Responses 不接收 PDF 文件，请将输入模式改为“按页图片”或“自动”。", "unsupported_request")
                if options["provider"] == "responses":
                    content.append({"type": "input_file", "filename": attachment["filename"], "file_data": "data:application/pdf;base64," + encoded, "detail": "high"})
                elif options["provider"] == "claude":
                    content.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": encoded}})
                else:
                    content.append({"type": "file", "file": {"filename": attachment["filename"], "file_data": "data:application/pdf;base64," + encoded}})
            else:
                label = f"输入局部页序：{attachment['local_page']}"
                if options["provider"] == "responses":
                    content.extend([{"type": "input_text", "text": label}, {"type": "input_image", "image_url": "data:image/jpeg;base64," + encoded, "detail": "high"}])
                elif options["provider"] == "claude":
                    content.extend([{"type": "text", "text": label}, {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": encoded}}])
                else:
                    content.extend([{"type": "text", "text": label}, {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + encoded, "detail": "high"}}])
        content.append({"type": "input_text" if options["provider"] == "responses" else "text", "text": prompt})
        if options["provider"] == "responses":
            body = {"model": options["model"], "instructions": system, "input": [{"role": "user", "content": content}], "max_output_tokens": limit, "store": False}
            if is_deepseek(options) and max_output is not None and max_output <= 512:
                # 连接探针只需短 JSON，避免默认思考耗尽探针输出预算。
                body["reasoning"] = {"effort": "none"}
            if schema and options["structured_output"]:
                body["text"] = {"format": {"type": "json_schema", "name": "paperboard_card", "strict": True, "schema": strict_schema(schema)}}
            return "/responses", {"Authorization": "Bearer " + self.key}, body
        if options["provider"] == "claude":
            return "/messages", {"x-api-key": self.key, "anthropic-version": "2023-06-01"}, {"model": options["model"], "system": system, "messages": [{"role": "user", "content": content}], "max_tokens": limit}
        body = {"model": options["model"], "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}], "max_tokens": limit}
        if is_deepseek(options) and max_output is not None and max_output <= 512:
            body["thinking"] = {"type": "disabled"}
        if schema and options["structured_output"]:
            body["response_format"] = {"type": "json_object"}
        return "/chat/completions", {"Authorization": "Bearer " + self.key}, body

    async def generate(self, prompt, system, attachments=(), schema=None, request_id=None, max_output=None):
        try:
            async with asyncio.timeout(self.options["timeout_seconds"]):
                return await self._generate(prompt, system, attachments, schema, request_id, max_output)
        except TimeoutError:
            raise ProviderError("模型请求超过总超时上限，远端可能仍在处理并计费。", "network_uncertain", True, True)

    async def _generate(self, prompt, system, attachments=(), schema=None, request_id=None, max_output=None):
        path, headers, body = self.build(prompt, system, attachments, schema, max_output)
        serialized = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(serialized) > self.options["max_request_bytes"]:
            raise ProviderError("本次输入超过服务请求大小限制，请减少每批页数或提高允许的请求大小。", "input_too_large")
        url = self.options["base_url"].rstrip("/") + path
        if self.transport is None:
            target, authority, host = await asyncio.to_thread(pinned_address, url, self.allow_local)
            headers["Host"] = authority
            extensions = {"sni_hostname": host}
        else:
            target, extensions = url, {}
        headers["Content-Type"] = "application/json"
        if request_id:
            headers["X-Client-Request-Id"] = request_id
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.options["timeout_seconds"], connect=15), follow_redirects=False, trust_env=False, transport=self.transport) as client:
                async with client.stream("POST", target, headers=headers, content=serialized, extensions=extensions) as response:
                    if response.status_code >= 300:
                        status = response.status_code
                        if status in {401, 403}:
                            raise ProviderError("模型鉴权或权限检查失败，请检查密钥与模型权限。", "authentication_failed")
                        if status == 429 or status >= 500:
                            try:
                                delay = int(response.headers.get("retry-after", "0"))
                            except ValueError:
                                delay = 0
                            raise ProviderError("模型服务暂时不可用或限流，请稍后重试。", "rate_limited" if status == 429 else "provider_unavailable", True, status >= 500, delay)
                        if status in {404, 405}:
                            raise ProviderError(f"模型接口不可用（HTTP {status}），请检查服务基础地址及接口类型，避免重复填写接口路径。", "endpoint_not_found")
                        if status == 413:
                            raise ProviderError("服务商拒绝了过大的输入（HTTP 413），请减少每批页数或图片尺寸。", "input_too_large")
                        raise ProviderError(f"模型接口拒绝了请求（HTTP {status}），请检查 API 模型标识、输入模式及结构化输出设置。", "unsupported_request")
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > 2 * 1024 * 1024:
                            raise ProviderError("模型响应超过大小限制。", "output_too_large", uncertain=True)
                    try:
                        data = json.loads(content)
                    except (ValueError, UnicodeError):
                        raise ProviderError("模型服务没有返回有效响应。", "invalid_response", uncertain=True)
                    try:
                        return self.parse(data, response.headers.get("x-request-id"))
                    except ProviderError as error:
                        usage = data.get("usage") or {} if isinstance(data, dict) else {}
                        incoming = usage.get("prompt_tokens" if self.options["provider"] == "chat" else "input_tokens")
                        outgoing = usage.get("completion_tokens" if self.options["provider"] == "chat" else "output_tokens")
                        error.input_tokens = incoming if type(incoming) is int and 0 <= incoming <= 1000000000 else None
                        error.output_tokens = outgoing if type(outgoing) is int and 0 <= outgoing <= 1000000000 else None
                        error.uncertain = error.input_tokens is None or error.output_tokens is None
                        raise
        except (httpx.TimeoutException, httpx.NetworkError):
            raise ProviderError("模型响应超时或连接中断，远端可能仍在处理并计费。", "network_uncertain", True, True)
        except httpx.HTTPError:
            raise ProviderError("模型连接未完成，请检查服务地址与网络。", "connection_failed", True, True)

    def parse(self, data, request_id=None):
        try:
            if self.options["provider"] == "responses":
                if data.get("status") not in {None, "completed"}:
                    raise ProviderError("模型输出尚未完成或达到输出上限，请调整设置。", "incomplete_output", uncertain=True)
                content = [item for message in data.get("output", []) if message.get("type") == "message" for item in message.get("content", [])]
                if any(item.get("type") == "refusal" for item in content):
                    raise ProviderError("模型未提供可用分析结果。", "model_refusal")
                text = "".join(item.get("text", "") for item in content if item.get("type") == "output_text")
            elif self.options["provider"] == "claude":
                if data.get("stop_reason") not in {None, "end_turn", "stop_sequence"}:
                    raise ProviderError("模型输出达到上限或未正常结束。", "incomplete_output", uncertain=True)
                text = "".join(item.get("text", "") for item in data["content"] if item.get("type") == "text")
            else:
                choice = data["choices"][0]
                if choice.get("finish_reason") not in {None, "stop"}:
                    raise ProviderError("模型输出达到上限或未正常结束。", "incomplete_output", uncertain=True)
                text = choice["message"]["content"]
            if not isinstance(text, str) or not text.strip() or len(text) > 150000:
                raise ProviderError("模型没有返回可用文本。", "invalid_response", uncertain=True)
            usage = data.get("usage") or {}
            def number(name):
                value = usage.get(name)
                return value if type(value) is int and 0 <= value <= 1000000000 else None
            incoming = number("prompt_tokens" if self.options["provider"] == "chat" else "input_tokens")
            outgoing = number("completion_tokens" if self.options["provider"] == "chat" else "output_tokens")
            identifier = str(request_id or data.get("id") or "")[:200]
            return ModelResult(text.replace(self.key, "[已隐藏]") if self.key else text, incoming, outgoing, identifier.replace(self.key, "[已隐藏]") if self.key else identifier)
        except (TypeError, KeyError, IndexError, AttributeError):
            raise ProviderError("模型返回结构与所选接口不兼容。", "invalid_response", uncertain=True)
