"""使用正式适配器验证检索、索引和可选 PDF 入库；只写项目内隔离验收目录。"""
import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.models import User
from app.discovery_models import LiteratureCandidate, PaperImportTask
from app.reading_service import ReadingError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["all", "arxiv", "acl", "ieee"], default="all")
    parser.add_argument("--query", default="long term memory")
    parser.add_argument("--sync-acl", action="store_true", help="从 ACL 官方仓库同步完整元数据，首次可能耗时较长")
    parser.add_argument("--import-pdf", action="store_true", help="将 arXiv / ACL 的第一条结果下载到隔离验收库")
    parser.add_argument("--directory", default="live-discovery", help="项目 .test-data 内的独立目录名")
    args = parser.parse_args()
    base = (ROOT / ".test-data").resolve()
    directory = (base / args.directory).resolve()
    if directory.parent != base or directory == (ROOT / "data").resolve():
        parser.error("验收目录只能是项目 .test-data 的直接子目录")
    app = create_app(Settings(data_dir=directory, ai_worker_enabled=False, discovery_worker_enabled=False))
    results = []
    with TestClient(app, base_url="http://localhost", headers={"X-Paperboard-Request": "1"}) as client:
        # 隔离库使用固定测试账号，不读取或修改实际用户的账号与密钥。
        credentials = {"username": "source-check", "password": "Isolated-check-2026!"}
        with app.state.session_factory() as db:
            initialized = db.get(User, 1) is not None
        if not initialized:
            response = client.post("/api/v1/setup", json=credentials)
            if response.status_code != 200:
                raise RuntimeError("无法初始化隔离验收库")
        service = app.state.discovery_service
        with app.state.session_factory() as db:
            user = db.get(User, 1)
            db.expunge(user)

        async def run():
            for provider in (["arxiv", "acl", "ieee"] if args.provider == "all" else [args.provider]):
                try:
                    if provider == "ieee":
                        key = os.environ.get("IEEE_API_KEY", "").strip()
                        if not key:
                            results.append({"来源": "ieee", "状态": "跳过", "说明": "未设置 IEEE_API_KEY；不发送无密钥请求"})
                            continue
                        # 验收直接使用环境变量，不将真实密钥保存在验收库或命令行参数中。
                        found = await service.remote.ieee(args.query, key)
                    else:
                        if provider == "acl" and args.sync_acl:
                            with app.state.session_factory() as db:
                                service.enqueue_sync(db, user, uuid.uuid4().hex)
                            print("正在同步 ACL 官方元数据并建立索引……", flush=True)
                            await service.process_sync()
                            with app.state.session_factory() as db:
                                status = service.sync_status(db)
                                if status["task"] and status["task"]["status"] == "failed":
                                    results.append({"来源": "acl", "状态": "失败", "说明": status["task"]["error"]})
                                    continue
                        found = await service.search(user, provider, args.query)
                    item = {"来源": provider, "状态": "通过", "匹配数": found["total"],
                            "论文": [{"标识": r["source_id"], "题名": r["title"]} for r in found["items"][:3]]}
                    if args.import_pdf and provider != "ieee" and found["items"]:
                        record = found["items"][0]
                        with app.state.session_factory() as db:
                            saved = service.save_candidate(db, user, record, [])
                            if saved["paper_id"]:
                                item["入库"] = "此前已导入"
                            else:
                                candidate = db.get(LiteratureCandidate, saved["id"])
                                task_id = service.enqueue_import(db, user, candidate, uuid.uuid4().hex).id
                        if not saved["paper_id"]:
                            await service.process_import()
                            with app.state.session_factory() as db:
                                task = db.get(PaperImportTask, task_id)
                                item["入库"] = task.status
                                if task.status != "succeeded":
                                    item["状态"], item["说明"] = "失败", task.error
                    results.append(item)
                except ReadingError as error:
                    results.append({"来源": provider, "状态": "失败", "说明": error.body["detail"]})
                except Exception:
                    results.append({"来源": provider, "状态": "失败", "说明": "验收未完成，请检查依赖和网络；不输出含凭据的异常信息"})
        client.portal.call(run)
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 1 if any(r["状态"] == "失败" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
