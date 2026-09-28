#!/usr/bin/env python3
"""Build a private, isolated Story database from the checked-in interview benchmark."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "benchmark/interview-quality/interview-quality-benchmark.db.gz"
FIXTURE_DIR = ROOT / "data/next-question-benchmark"
DATABASE = FIXTURE_DIR / "fixture.db"
MANIFEST = FIXTURE_DIR / "fixture.json"
CONTEXT_PATH = ROOT / "benchmark/next-question/fixture-context.json"
COLLECTION = "life-interview-transcripts"
EXPECTED_SESSIONS = [f"bench-session-q{index:02d}" for index in range(1, 7)]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if not SOURCE.is_file():
        raise SystemExit(f"Missing source benchmark database: {SOURCE}")
    if DATABASE.exists() or MANIFEST.exists():
        raise SystemExit(f"Fixture already exists; preserving it: {FIXTURE_DIR}")

    context = json.loads(CONTEXT_PATH.read_text(encoding="utf-8"))
    fixture_dir_created = not FIXTURE_DIR.exists()
    FIXTURE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(FIXTURE_DIR, 0o700)

    owner_id, account_id, stage_id, story_id = [str(uuid.uuid4()) for _ in range(4)]
    fd, temporary_name = tempfile.mkstemp(prefix="fixture-", suffix=".db", dir=FIXTURE_DIR)
    os.close(fd)
    temporary_database = Path(temporary_name)
    try:
        with gzip.open(SOURCE, "rb") as source, temporary_database.open("wb") as target:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                target.write(chunk)
        os.chmod(temporary_database, 0o600)

        connection = sqlite3.connect(temporary_database)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            with connection:
                user_rows = connection.execute("SELECT user_id, account_id FROM users").fetchall()
                session_rows = connection.execute(
                    "SELECT session_id, status, ended_at, transcript_json FROM interview_sessions ORDER BY session_id"
                ).fetchall()
                if len(user_rows) != 1 or [row["session_id"] for row in session_rows] != EXPECTED_SESSIONS:
                    raise RuntimeError("Source benchmark database does not match the expected six-session fixture.")
                if any(row["status"] != "completed" or not row["ended_at"] for row in session_rows):
                    raise RuntimeError("All source interview sessions must already be completed.")

                remote_refs = connection.execute(
                    "SELECT count(*) FROM retriever_index_jobs WHERE retriever_job_id IS NOT NULL OR retriever_document_id IS NOT NULL"
                ).fetchone()[0]
                if remote_refs:
                    raise RuntimeError("Source fixture contains Retriever references; refusing to discard them.")

                source_facts = "\n".join(
                    message["text"]
                    for row in session_rows
                    for message in json.loads(row["transcript_json"])
                    if message["role"] == "user"
                )
                required_facts = (
                    "两年", "回家务农", "盖好了房子", "杨立苗老师推荐", "正式高考", "7月15日",
                    "王明晨", "发烧", "输液", "水深得没过腰", "相互搀扶", "行李举过头顶",
                    "486分", "450分", "99.5分", "语文58分", "硅酸盐专业",
                )
                missing = [fact for fact in required_facts if fact not in source_facts]
                if missing:
                    raise RuntimeError(f"Source benchmark answers are missing required facts: {', '.join(missing)}")

                connection.execute(
                    "UPDATE accounts SET account_id = ?, updated_at = ?",
                    (account_id, datetime.now(timezone.utc).isoformat()),
                )
                connection.execute(
                    """UPDATE users SET user_id = ?, updated_at = ?, name = NULL, nickname = NULL,
                       email = NULL, birth_date = NULL, birth_date_precision = NULL, gender = NULL,
                       birth_place = NULL, current_location = NULL, current_status = NULL,
                       occupation_summary = NULL, family_summary = NULL, profile_summary = NULL,
                       extra_profile_json = NULL""",
                    (owner_id, datetime.now(timezone.utc).isoformat()),
                )

                now = datetime.now(timezone.utc).isoformat()
                connection.execute(
                    """INSERT INTO life_stages
                       (stage_id, user_id, title, start_date, end_date, date_precision, summary,
                        sort_order, status, created_source_session_id, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'year', ?, 1, 'active', NULL, ?, ?)""",
                    (stage_id, owner_id, context["life_stage_title"], context["life_stage_start_date"],
                     context["life_stage_end_date"], context["story_summary"], now, now),
                )
                connection.execute(
                    """INSERT INTO stories
                       (story_id, user_id, stage_id, title, summary, agent_memory, status, gaps_json,
                        created_source_session_id, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?)""",
                    (story_id, owner_id, stage_id, context["story_title"], context["story_summary"],
                     context["agent_memory"], context["story_status"], now, now),
                )
                connection.execute(
                    "UPDATE interview_sessions SET story_id = ?, stage_id = ?, updated_at = ?",
                    (story_id, stage_id, now),
                )
                connection.execute("DELETE FROM stories WHERE story_id != ?", (story_id,))
                connection.execute("DELETE FROM life_stages WHERE stage_id != ?", (stage_id,))
                # The copied source jobs are placeholders without remote references. Let the real
                # RetrieverIndexService recreate and transition these rows from the actual ingest.
                connection.execute("DELETE FROM retriever_index_jobs")

                scope = connection.execute(
                    """SELECT count(*) AS count FROM interview_sessions
                       WHERE user_id = ? AND story_id = ? AND stage_id = ?
                         AND status = 'completed' AND ended_at IS NOT NULL""",
                    (owner_id, story_id, stage_id),
                ).fetchone()["count"]
                if scope != len(EXPECTED_SESSIONS):
                    raise RuntimeError("Fixture sessions failed owner/story/stage scope validation.")
                if connection.execute("PRAGMA foreign_key_check").fetchall():
                    raise RuntimeError("Fixture has foreign-key violations.")
                if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("Fixture SQLite integrity check failed.")
        finally:
            connection.close()

        os.replace(temporary_database, DATABASE)
        manifest = {
            "schema_version": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "database_path": "fixture.db",
            "source_database": "benchmark/interview-quality/interview-quality-benchmark.db.gz",
            "source_sha256": sha256(SOURCE),
            "owner_id": owner_id,
            "account_id": account_id,
            "stage_id": stage_id,
            "story_id": story_id,
            "session_ids": EXPECTED_SESSIONS,
            "retriever_collection": COLLECTION,
            "story_context": context,
        }
        temporary_manifest = MANIFEST.with_suffix(".json.tmp")
        temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary_manifest, 0o600)
        os.replace(temporary_manifest, MANIFEST)
        os.chmod(DATABASE, 0o600)
        os.chmod(MANIFEST, 0o600)
        print(json.dumps({
            "status": "FIXTURE_CREATED",
            "directory": str(FIXTURE_DIR),
            "owner_id": owner_id,
            "story_id": story_id,
            "stage_id": stage_id,
            "sessions": len(EXPECTED_SESSIONS),
            "source_sha256": manifest["source_sha256"],
        }, ensure_ascii=False))
    finally:
        temporary_database.unlink(missing_ok=True)
        if fixture_dir_created and not DATABASE.exists():
            try:
                FIXTURE_DIR.rmdir()
            except OSError:
                pass


if __name__ == "__main__":
    main()
