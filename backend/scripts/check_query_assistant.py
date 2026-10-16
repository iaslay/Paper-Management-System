"""显式使用本机已保存模型，在隔离库验收自然语言检索词，不修改正式论文或记录。"""
import argparse
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from fastapi.testclient import TestClient
from app.config import Settings
from app.database import connect_database
from app.main import create_app
from app.models import ModelConfiguration, User
from app.ai_secrets import SecretStore
from app import ai_service as ai
from app.query_assistant import AssistCreate, view
from app.discovery_models import SearchQueryTask
from app.reading_service import ReadingError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--use-saved-model", action="store_true", help="明确允许发送本次问题，可能产生模型用量")
    parser.add_argument("--question", default="想找近三年多轮对话中长期记忆更新的论文，重点关注如何处理过时信息")
    parser.add_argument("--provider", choices=["arxiv", "acl", "ieee"], default="acl")
    parser.add_argument("--directory", default="query-assistant-live", help="项目 .test-data 的直接子目录名")
    args = parser.parse_args()
    if not args.use_saved_model:
        print("未调用模型。真实验收请加 --use-saved-model；仅发送 --question，不附带论文或笔记。")
        return 0
    base = (ROOT / ".test-data").resolve()
    target = (base / args.directory).resolve()
    if target.parent != base:
        parser.error("验收目录只能是 .test-data 的直接子目录")
    request = AssistCreate(request_id=uuid.uuid4().hex, provider=args.provider, text=args.question)
    source_settings = Settings(data_dir=ROOT / "data")
    source_engine, source_factory = connect_database(source_settings)
    with source_factory() as db:
        current = ai.latest_config(db, 1)
        if not current or not current.settings_json["enabled"]:
            print("正式模型尚未启用，未发送验收问题。")
            return 1
        options, sealed = dict(current.settings_json), current.encrypted_key
    source_engine.dispose()
    app = create_app(Settings(data_dir=target, ai_worker_enabled=False, discovery_worker_enabled=False))
    with TestClient(app, base_url="http://localhost", headers={"X-Paperboard-Request": "1"}) as client:
        with app.state.session_factory() as db:
            initialized = db.get(User, 1) is not None
        if not initialized:
            response = client.post("/api/v1/setup", json={"username": "query-check", "password": "Isolated-query-2026!"})
            if response.status_code != 200:
                raise RuntimeError("隔离库初始化失败")
        # 密钥只在内存中转换为验收目录的加密格式，不回显、不写入问题或输出。
        encrypted = SecretStore(target).encrypt(SecretStore(source_settings.data_dir).decrypt(sealed))
        with app.state.session_factory() as db:
            previous = ai.latest_config(db, 1)
            config = ModelConfiguration(workspace_id=1, revision=previous.revision + 1 if previous else 1,
                settings_json=options, encrypted_key=encrypted)
            db.add(config); db.commit()
            user = db.get(User, 1)
            task = app.state.query_assistant.create(db, user, request)
            task_id = task.id
        client.portal.call(app.state.query_assistant.process_one)
        with app.state.session_factory() as db:
            result = view(db, db.get(SearchQueryTask, task_id))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "succeeded" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReadingError as error:
        print(json.dumps({"状态": "失败", "说明": error.body["detail"]}, ensure_ascii=False))
        raise SystemExit(1)
