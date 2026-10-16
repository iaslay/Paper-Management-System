"""ACL 官方元数据的独立索引；新代次完整验证后才切换可用版本。"""
import json
import re
import sqlite3
import time
import uuid
from pathlib import Path
from .models import now
from .reading_service import fail
from .literature_providers import LiteratureRecord, identifier, ACL_ID, text, year_of


class ACLIndex:
    format_version = 1
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.pointer = self.root / "active.json"

    def state(self):
        try:
            data = json.loads(self.pointer.read_text(encoding="utf-8"))
            if not re.fullmatch(r"[0-9a-f]{32}", data["generation"]) or not (self.root / (data["generation"] + ".sqlite3")).is_file():
                return {}
            return data
        except (OSError, ValueError, KeyError, TypeError):
            return {}

    def activate(self, data):
        previous = self.state()
        temporary = self.root / ("pointer-" + uuid.uuid4().hex + ".json")
        temporary.write_text(json.dumps(data), encoding="utf-8")
        temporary.replace(self.pointer)
        # 保留当前与上一代索引，较新的旧文件给并发查询留出读取时间。
        keep = {data["generation"], previous.get("generation")}
        for path in self.root.glob("*.sqlite3"):
            if path.stem in keep or not re.fullmatch(r"[0-9a-f]{32}", path.stem) or path.is_symlink():
                continue
            try:
                if path.resolve().parent == self.root.resolve() and path.stat().st_mtime < time.time() - 600:
                    path.unlink()
            except OSError:
                pass

    def build(self, anthology, revision, progress, changed=None):
        previous = self.state()
        if previous.get("source_revision") == revision and previous.get("format_version") == self.format_version:
            self.activate({**previous, "checked_at": now()})
            return previous
        generation = uuid.uuid4().hex
        path = self.root / (generation + ".sqlite3")
        db = sqlite3.connect(path)
        try:
            # 官方数据可能先于 SDK 增加会议字段，只读取检索需要的简称，避免无关字段阻断同步。
            venues = None
            if getattr(anthology, "datadir", None):
                venues = json.loads((Path(anthology.datadir) / "json" / "venues.json").read_text(encoding="utf-8"))
            if previous and changed is not None and previous.get("format_version") == self.format_version:
                with sqlite3.connect(self.root / (previous["generation"] + ".sqlite3")) as source:
                    source.backup(db)
                for collection in changed:
                    db.execute("DELETE FROM search WHERE rowid IN (SELECT rowid FROM records WHERE collection=?)", (collection,))
                    db.execute("DELETE FROM records WHERE collection=?", (collection,))
                def updated_papers():
                    for collection in changed:
                        item = anthology.get_collection(collection)
                        if item is not None:
                            yield from item.papers()
                papers = updated_papers()
            else:
                db.executescript("""
                    CREATE TABLE records(source_id TEXT UNIQUE, collection TEXT, year INTEGER, venue TEXT, volume TEXT, doi TEXT, data TEXT);
                    CREATE INDEX records_year ON records(year);
                    CREATE INDEX records_doi ON records(doi);
                    CREATE VIRTUAL TABLE search USING fts5(title, authors, abstract, tokenize='unicode61');
                """)
                papers = anthology.papers()
            processed = 0
            for paper in papers:
                if paper.is_frontmatter or paper.is_deleted:
                    continue
                volume = paper.parent
                venue = "-".join(str(venues.get(v, {}).get("acronym", v)) for v in volume.venue_ids if v != "ws") if venues is not None else volume.venue_acronym
                record = LiteratureRecord(provider="acl", source_id=str(paper.full_id), title=text(paper.title, 500),
                    authors=[text(a.name.as_full() if hasattr(a.name, "as_full") else a.name, 200) for a in paper.authors][:100], abstract=text(paper.abstract),
                    year=year_of(paper.year), published=str(paper.year or ""), date_precision="year" if year_of(paper.year) else "unknown",
                    doi=str(paper.doi) if paper.doi else None, venue=text(venue or volume.title, 500),
                    volume_id=str(volume.full_id), url=str(paper.web_url), pdf_url=str(paper.pdf.url) if paper.pdf else None,
                    source_revision=revision).model_dump()
                row = db.execute("INSERT INTO records VALUES(?,?,?,?,?,?,?)", (record["source_id"], paper.collection_id,
                    record["year"], record["venue"], record["volume_id"], (record["doi"] or "").casefold(), json.dumps(record, ensure_ascii=False))).lastrowid
                db.execute("INSERT INTO search(rowid,title,authors,abstract) VALUES(?,?,?,?)", (row, record["title"], "\n".join(record["authors"]), record["abstract"]))
                processed += 1
                if processed % 200 == 0:
                    progress(processed)
            progress(processed)
            total = db.execute("SELECT count(*) FROM records").fetchone()[0]
            if not total or total != db.execute("SELECT count(*) FROM search").fetchone()[0]:
                fail("ACL 索引校验未通过，继续保留旧索引。", "acl_index_invalid", 503)
            db.commit()
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                fail("ACL 索引文件不完整，继续保留旧索引。", "acl_index_invalid", 503)
            db.close()
            result = {"generation": generation, "format_version": self.format_version, "source_revision": revision, "records": total, "updated_at": now(), "checked_at": now()}
            self.activate(result)
            return result
        except BaseException:
            db.close()
            path.unlink(missing_ok=True)
            raise

    def search(self, q, *, field="all", page=1, sort="relevance", year_from=None, year_to=None, venue="", volume_id="", generation=None):
        state = self.state()
        if not state:
            fail("先初始化 ACL 论文索引，完成后即可检索。", "source_not_ready", 409)
        if generation and generation != state["generation"]:
            fail("论文索引已更新，请重新检索；原查询条件已保留。", "index_changed", 409)
        clauses, params = [], []
        exact = None
        if ACL_ID.fullmatch(q) or q.startswith(("https://aclanthology.org/", "https://www.aclanthology.org/")):
            exact = identifier("acl", q)
            clauses.append("r.source_id=?")
            params.append(exact)
        elif q.removeprefix("https://doi.org/").startswith("10."):
            clauses.append("r.doi=?")
            params.append(q.removeprefix("https://doi.org/").casefold())
        else:
            parts = re.findall(r'"([^\"]+)"|(\w+)', q, re.UNICODE)
            tokens = ['"' + (a or b).replace('"', '""') + '"' for a, b in parts]
            if not tokens:
                fail("请输入至少一个有效关键词。", "invalid_query")
            expression = " AND ".join(tokens)
            if field != "all":
                expression = {"title": "title", "author": "authors", "abstract": "abstract"}[field] + ": (" + expression + ")"
            clauses.append("search MATCH ?")
            params.append(expression)
        for column, value, operator in [("year", year_from, ">="), ("year", year_to, "<="), ("venue", venue, "="), ("volume", volume_id, "=")]:
            if value:
                clauses.append(f"r.{column}{operator}?")
                params.append(value)
        match = any(c == "search MATCH ?" for c in clauses)
        source = "records r JOIN search ON search.rowid=r.rowid" if match else "records r"
        where = " AND ".join(clauses)
        order = "r.year DESC,r.source_id" if sort == "year_desc" or not match else "bm25(search,5,2,1),r.source_id"
        with sqlite3.connect(self.root / (state["generation"] + ".sqlite3")) as db:
            total = db.execute(f"SELECT count(*) FROM {source} WHERE {where}", params).fetchone()[0]
            rows = db.execute(f"SELECT r.data FROM {source} WHERE {where} ORDER BY {order} LIMIT 20 OFFSET ?", [*params, (page - 1) * 20]).fetchall()
        return {"items": [json.loads(row[0]) for row in rows], "total": total, "index_generation": state["generation"], "data_time": state["updated_at"]}

    def get_record(self, source_id):
        source_id = identifier("acl", source_id)
        result = self.search(source_id)
        if not result["items"]:
            fail("当前 ACL 索引未收录该论文，请更新索引或查看官方来源。", "source_not_found", 404)
        return result["items"][0]

    def facets(self):
        state = self.state()
        if not state:
            return []
        with sqlite3.connect(self.root / (state["generation"] + ".sqlite3")) as db:
            return [row[0] for row in db.execute("SELECT DISTINCT venue FROM records WHERE venue!='' ORDER BY venue")]
