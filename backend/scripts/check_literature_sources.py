"""只读检查公开论文检索接口，不使用学校账号、密钥或浏览器会话。"""
import json
import time
import xml.etree.ElementTree as ET

import httpx


def main():
    queries = [
        ("arXiv", "https://export.arxiv.org/api/query", {"search_query": "all:memory AND cat:cs.CL", "start": 0, "max_results": 3}),
        ("IEEE 未配置密钥", "https://ieeexploreapi.ieee.org/api/v1/search/articles", {"querytext": "long term memory", "max_records": 3, "format": "json"}),
    ]
    results = []
    with httpx.Client(timeout=httpx.Timeout(25, connect=10), trust_env=False, follow_redirects=False,
                      headers={"User-Agent": "Paperboard (personal connectivity check)"}) as client:
        for source, url, params in queries:
            started = time.monotonic()
            try:
                response = client.get(url, params=params)
                item = {"source": source, "http_status": response.status_code,
                        "elapsed_seconds": round(time.monotonic() - started, 2),
                        "content_type": response.headers.get("content-type", "")}
                if source == "arXiv" and response.status_code == 200:
                    feed = ET.fromstring(response.content)
                    namespace = {"a": "http://www.w3.org/2005/Atom", "o": "http://a9.com/-/spec/opensearch/1.1/"}
                    item["total_results"] = feed.findtext("o:totalResults", namespaces=namespace)
                    item["papers"] = [{"id": entry.findtext("a:id", namespaces=namespace),
                                       "title": " ".join((entry.findtext("a:title", namespaces=namespace) or "").split())}
                                      for entry in feed.findall("a:entry", namespace)]
                else:
                    # 只请求无认证的公开接口，截取少量错误信息，不探测用户的其他凭据。
                    item["response_excerpt"] = response.text[:400]
            except (httpx.HTTPError, ET.ParseError) as error:
                item = {"source": source, "error_type": type(error).__name__, "error": str(error)[:250],
                        "elapsed_seconds": round(time.monotonic() - started, 2)}
            results.append(item)
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
