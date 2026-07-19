"""Autenticación de Lince Teams, en dos modos:

- **Standalone** (por defecto): hashing PBKDF2 + sesiones bearer propias +
  registro/aprobación local. Todo stdlib, sin dependencias externas.
- **Unificado** (`SUPABASE_URL` + anon key en el entorno): comparte el login del
  panel de Lince. El navegador manda el **JWT de Supabase**; acá se valida
  contra Supabase Auth y se espeja la cuenta en la tabla local `users` (por
  `auth_id`), leyendo rol y nombre de `public.profiles` (admin/socio). Así el
  resto del código (tareas, pizarra, actividad, tokens) sigue usando el id
  entero local sin cambios.

API tokens (n8n, scripts) siguen siendo locales en ambos modos: `lince_<hex>`,
guardando solo su hash SHA-256. Un humano usa su JWT; una máquina, su `lince_…`.
"""

import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.error
import urllib.request

from . import db

ITERATIONS = 120_000
API_TOKEN_PREFIX = "lince_"

_USER_FIELDS = "u.id, u.username, u.display_name, u.role, u.status"

# ── modo unificado con Supabase ──────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_KEY", "")
SUPABASE_MODE = bool(SUPABASE_URL and SUPABASE_ANON_KEY)

# Roles de Supabase con acceso a Teams y su mapeo al rol local (admin/member).
_SUPA_ADMIN_ROLES = {"admin"}
_SUPA_MEMBER_ROLES = {"socio"}

# Cache corto de validaciones de JWT: evita pegarle a Supabase Auth en cada
# request/poll. token -> (expira_en, {id, email}).
_JWT_TTL = 60
_jwt_cache: dict[str, tuple[float, dict]] = {}


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), ITERATIONS
    ).hex()
    return salt, digest


def verify_password(password: str, salt: str, expected: str) -> bool:
    return hmac.compare_digest(hash_password(password, salt)[1], expected)


# -- sesiones de navegador -----------------------------------------------------

def create_session(user_id: int) -> str:
    token = secrets.token_hex(32)
    db.execute("INSERT INTO sessions(token, user_id) VALUES(?, ?)", (token, user_id))
    return token


def destroy_session(token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token = ?", (token,))


# -- resolución de tokens --------------------------------------------------------

def user_for_api_token(token: str) -> dict | None:
    """Cuenta dueña de un token de API `lince_...` (n8n, scripts).

    En modo unificado, además se re-chequea el rol ACTUAL en `profiles`: el
    acceso se gestiona desde el panel (Supabase) y el espejo local queda
    `active` para siempre, así que sin este chequeo un socio dado de baja
    (rol → viewer) seguiría entrando con su token de API indefinidamente —y en
    este modo no hay administración local de miembros que permita revocarlo.
    """
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    row = db.query_one(
        f"""SELECT {_USER_FIELDS}, u.auth_id FROM api_tokens t
            JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?""",
        (token_hash,),
    )
    if not row:
        return None
    if SUPABASE_MODE:
        # Cuentas sin auth_id (creadas en modo standalone) no tienen perfil que
        # las respalde: en modo unificado quedan denegadas, igual que por JWT.
        prof = _profile_for(row["auth_id"]) if row.get("auth_id") else None
        role = _local_role((prof or {}).get("role"))
        if role is None:
            return None
        if role != row["role"]:
            db.execute("UPDATE users SET role = ? WHERE id = ?", (role, row["id"]))
            row["role"] = role
    row.pop("auth_id", None)
    return row


def user_for_session(token: str) -> dict | None:
    """Cuenta dueña de una sesión de navegador local (modo standalone)."""
    return db.query_one(
        f"""SELECT {_USER_FIELDS} FROM sessions s
            JOIN users u ON u.id = s.user_id WHERE s.token = ?""",
        (token,),
    )


def user_for_token(token: str | None) -> dict | None:
    """Resuelve un token a su cuenta local, sea API token, JWT de Supabase
    (modo unificado) o sesión propia (standalone). Usado por el WebSocket."""
    if not token:
        return None
    if token.startswith(API_TOKEN_PREFIX):
        return user_for_api_token(token)
    if SUPABASE_MODE:
        au = supabase_user(token)
        return provision_member(au) if au else None
    return user_for_session(token)


# -- modo unificado: validación de JWT + espejo de cuentas -----------------------

def supabase_user(token: str) -> dict | None:
    """Valida el JWT contra Supabase Auth y devuelve {id, email} o None.

    Espeja lo que hace el backend Express (`supabase.auth.getUser`): un GET a
    `/auth/v1/user` con el token del usuario. Cachea el resultado unos segundos.
    """
    now = time.time()
    hit = _jwt_cache.get(token)
    if hit and hit[0] > now:
        return hit[1]
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None
    if not data or not data.get("id"):
        return None
    user = {"id": data["id"], "email": data.get("email") or ""}
    if len(_jwt_cache) > 500:
        _jwt_cache.clear()
    _jwt_cache[token] = (now + _JWT_TTL, user)
    return user


def _profile_for(auth_id: str) -> dict | None:
    """Fila de `public.profiles` (full_name, role) del usuario, o None.

    Compara con `id::text` porque `profiles.id` es `uuid` y el parámetro viaja
    como texto (psycopg no tiene operador uuid = text). Solo se llama en modo
    Supabase (Postgres); ante cualquier error devuelve None (acceso denegado)."""
    try:
        return db.query_one("SELECT full_name, role FROM profiles WHERE id::text = ?", (str(auth_id),))
    except Exception:
        return None


def _local_role(supa_role: str | None) -> str | None:
    """Rol de Supabase -> rol local (admin/member), o None si no tiene acceso."""
    if supa_role in _SUPA_ADMIN_ROLES:
        return "admin"
    if supa_role in _SUPA_MEMBER_ROLES:
        return "member"
    return None


def _upsert_local(auth_id: str, full_name: str | None, supa_role: str | None,
                  email: str | None = None) -> int | None:
    """Crea/actualiza el espejo local de un perfil de Supabase. Devuelve el id
    local, o None si ese perfil no tiene acceso a Teams (ni admin ni socio)."""
    role = _local_role(supa_role)
    if role is None:
        return None
    auth_id = str(auth_id)  # puede venir como uuid.UUID (desde profiles); users.auth_id es texto
    name = (full_name or email or "Socio").strip() or "Socio"
    existing = db.query_one("SELECT id, display_name, role, status FROM users WHERE auth_id = ?", (auth_id,))
    if existing:
        if existing["display_name"] != name or existing["role"] != role or existing["status"] != "active":
            db.execute(
                "UPDATE users SET display_name = ?, role = ?, status = 'active' WHERE auth_id = ?",
                (name, role, auth_id),
            )
        return existing["id"]
    # `username` es NOT NULL UNIQUE: usamos el email (o el uuid) como identificador
    # legible. salt/password_hash quedan de placeholder: nunca se usan en este modo.
    username = (email or auth_id)
    return db.execute(
        """INSERT INTO users(username, display_name, salt, password_hash, role, status, auth_id)
           VALUES(?,?,?,?,?,'active',?)""",
        (username, name, "supabase", "supabase", role, auth_id),
        returning_id=True,
    )


def provision_member(auth_user: dict) -> dict | None:
    """Dado el usuario validado de Supabase, sincroniza su espejo local y
    devuelve la fila local (id, username, display_name, role, status), o None si
    la cuenta no tiene acceso a Teams."""
    prof = _profile_for(auth_user["id"]) or {}
    local_id = _upsert_local(auth_user["id"], prof.get("full_name"), prof.get("role"), auth_user.get("email"))
    if local_id is None:
        return None
    return db.query_one(
        "SELECT id, username, display_name, role, status FROM users WHERE id = ?", (local_id,)
    )


def sync_members() -> None:
    """Espeja en `users` a todos los perfiles con acceso (admin/socio), para que
    aparezcan en la lista de asignables aunque aún no hayan entrado nunca."""
    if not SUPABASE_MODE:
        return
    try:
        rows = db.query_all(
            "SELECT id, full_name, role FROM profiles WHERE role = ? OR role = ?",
            ("admin", "socio"),
        )
    except Exception:
        return  # sin tabla profiles (p. ej. DB no-Supabase): no hay nada que espejar
    for p in rows:
        _upsert_local(p["id"], p.get("full_name"), p.get("role"))


# -- tokens de API ---------------------------------------------------------------

def create_api_token(user_id: int, name: str) -> tuple[str, int]:
    """Returns (raw_token, row_id). The raw token is shown only once."""
    raw = API_TOKEN_PREFIX + secrets.token_hex(20)
    token_hash = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    row_id = db.execute(
        "INSERT INTO api_tokens(user_id, name, prefix, token_hash) VALUES(?,?,?,?)",
        (user_id, name, raw[:14] + "…", token_hash),
        returning_id=True,
    )
    return raw, row_id
