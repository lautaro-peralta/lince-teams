"""Storage layer with two interchangeable backends:

- SQLite (default): zero-config local file in data/whisperflow.db.
- Postgres (e.g. Supabase): set DATABASE_URL and it's used instead.

Queries are written once with `?` placeholders; they're translated to
psycopg's `%s` style when running against Postgres.
"""

import os
import sqlite3
from pathlib import Path

DATABASE_URL = os.environ.get("DATABASE_URL", "")
IS_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))

if IS_PG:
    import psycopg
    from psycopg.rows import dict_row

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "whisperflow.db"

# Dialect-specific SQL fragment for "current UTC timestamp".
NOW = "now()" if IS_PG else "datetime('now')"

_ID = "SERIAL PRIMARY KEY" if IS_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
_TS = "TIMESTAMPTZ DEFAULT now()" if IS_PG else "TEXT DEFAULT (datetime('now'))"

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS users(
  id {_ID},
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at {_TS}
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at {_TS}
);
CREATE TABLE IF NOT EXISTS tasks(
  id {_ID},
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date TEXT,
  created_at {_TS},
  updated_at {_TS}
);
CREATE TABLE IF NOT EXISTS transcripts(
  id {_ID},
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  language TEXT,
  duration REAL,
  created_at {_TS}
);
CREATE TABLE IF NOT EXISTS activity(
  id {_ID},
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  created_at {_TS}
);
"""


def _sql(sql: str) -> str:
    return sql.replace("?", "%s") if IS_PG else sql


def connect():
    if IS_PG:
        return psycopg.connect(DATABASE_URL, row_factory=dict_row)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init() -> None:
    statements = [s.strip() for s in SCHEMA.split(";") if s.strip()]
    with connect() as conn:
        for stmt in statements:
            conn.execute(stmt)


def query_all(sql: str, params: tuple = ()) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(_sql(sql), params).fetchall()
        return [dict(r) for r in rows]


def query_one(sql: str, params: tuple = ()) -> dict | None:
    with connect() as conn:
        row = conn.execute(_sql(sql), params).fetchone()
        return dict(row) if row else None


def execute(sql: str, params: tuple = (), returning_id: bool = False) -> int:
    """Run a write. With returning_id=True, returns the new row's id
    (INSERT statements on tables that have an `id` column only)."""
    with connect() as conn:
        if IS_PG:
            if returning_id:
                cur = conn.execute(_sql(sql) + " RETURNING id", params)
                return cur.fetchone()["id"]
            conn.execute(_sql(sql), params)
            return 0
        cur = conn.execute(sql, params)
        return cur.lastrowid
