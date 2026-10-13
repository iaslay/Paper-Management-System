"""运行配置与私有数据目录。"""

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class Settings:
    data_dir: Path
    database_url: str = ""
    max_file_bytes: int = 50 * 1024 * 1024
    max_pages: int = 300
    quota_bytes: int = 10 * 1024 * 1024 * 1024
    session_seconds: int = 24 * 60 * 60
    secure_cookie: bool = False
    ai_worker_enabled: bool = True
    allow_local_model: bool = False
    frontend_dir: Path | None = None
    allowed_origins: tuple[str, ...] = (
        "http://127.0.0.1:8000", "http://localhost:8000",
        "http://127.0.0.1:5173", "http://localhost:5173",
    )

    def __post_init__(self):
        self.data_dir = self.data_dir.resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "files").mkdir(exist_ok=True)
        (self.data_dir / "tmp").mkdir(exist_ok=True)
        if not self.database_url:
            self.database_url = "sqlite:///" + (self.data_dir / "paperboard.sqlite3").as_posix()
        self.frontend_dir = (self.frontend_dir or PROJECT_ROOT / "frontend" / "dist").resolve()

    @classmethod
    def from_env(cls):
        origins = os.getenv("PAPERBOARD_ALLOWED_ORIGINS")
        options = {"allowed_origins": tuple(origins.split(","))} if origins else {}
        return cls(
            data_dir=Path(os.getenv("PAPERBOARD_DATA_DIR", str(PROJECT_ROOT / "data"))),
            database_url=os.getenv("PAPERBOARD_DATABASE_URL", ""),
            secure_cookie=os.getenv("PAPERBOARD_COOKIE_SECURE", "0") == "1",
            ai_worker_enabled=os.getenv("PAPERBOARD_AI_WORKER", "1") == "1",
            allow_local_model=os.getenv("PAPERBOARD_ALLOW_LOCAL_MODEL", "0") == "1",
            frontend_dir=Path(os.environ["PAPERBOARD_FRONTEND_DIR"]) if os.getenv("PAPERBOARD_FRONTEND_DIR") else None,
            **options,
        )
