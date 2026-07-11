"""Storage layer with two interchangeable backends:

- SQLite (default): zero-config local file in data/lince.db.
- Postgres (e.g. Supabase): set DATABASE_URL and it's used instead.

Queries are written once with `?` placeholders; they're translated to
psycopg's `%s` style when running against Postgres.
"""

import os
import sqlite3
from pathlib import Path

DATABASE_URL = os.environ.get("DATABASE_URL", "")
IS_PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# Modo unificado: comparte el login del panel de Lince (Supabase Auth). Se activa
# cuando hay URL + anon key de Supabase; entonces los usuarios se espejan desde
# `public.profiles` (roles admin/socio) y no hay registro/login propios.
IS_SUPABASE = bool(
    os.environ.get("SUPABASE_URL")
    and (os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_KEY"))
)

if IS_PG:
    import psycopg
    from psycopg.rows import dict_row

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "lince.db"
UPLOADS_DIR = DB_PATH.parent / "uploads"

# Renames from earlier versions of the app keep the user's data.
if not IS_PG and not DB_PATH.exists():
    for _legacy_name in ("tinta.db", "whisperflow.db"):
        _legacy = DB_PATH.with_name(_legacy_name)
        if _legacy.exists():
            try:
                _legacy.rename(DB_PATH)
            except OSError:
                DB_PATH = _legacy  # archivo en uso; seguimos usándolo donde está
            break

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
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  auth_id TEXT UNIQUE,
  created_at {_TS}
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at {_TS}
);
CREATE TABLE IF NOT EXISTS api_tokens(
  id {_ID},
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
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
CREATE TABLE IF NOT EXISTS board_items(
  id {_ID},
  kind TEXT NOT NULL,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  w REAL,
  h REAL,
  z INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  content TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at {_TS}
);
CREATE TABLE IF NOT EXISTS integrations(
  id {_ID},
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT DEFAULT '',
  config TEXT DEFAULT '',
  secret TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
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


def _migrate(conn) -> None:
    """Upgrade databases created before roles/approval existed."""
    if IS_PG:
        conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'")
        conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'")
        conn.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id TEXT")
        fresh_columns = False
    else:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
        fresh_columns = "role" not in cols
        if fresh_columns:
            conn.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'")
            conn.execute("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'")
        if "auth_id" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN auth_id TEXT")

    # auth_id enlaza el usuario local con su cuenta de Supabase (modo unificado).
    # Índice único que tolera múltiples NULL (las cuentas legacy no lo tienen).
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_auth_id_idx ON users(auth_id)")

    if fresh_columns:
        # Existing accounts predate the approval flow: keep them working.
        conn.execute("UPDATE users SET status = 'active'")

    # En modo unificado (Supabase) los roles los gestiona el panel de Lince, así
    # que NO auto-promovemos: un socio espejado no debe volverse admin de Teams.
    if IS_SUPABASE:
        return

    # Standalone: siempre debe haber al menos un admin (promueve al más antiguo).
    row = conn.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").fetchone()
    n_admins = row["n"] if isinstance(row, dict) or hasattr(row, "keys") else row[0]
    if n_admins == 0:
        conn.execute(
            "UPDATE users SET role = 'admin', status = 'active' "
            "WHERE id = (SELECT MIN(id) FROM users)"
        )


def init() -> None:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    statements = [s.strip() for s in SCHEMA.split(";") if s.strip()]
    with connect() as conn:
        for stmt in statements:
            conn.execute(stmt)
        _migrate(conn)


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
