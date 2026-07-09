"""Password hashing (PBKDF2), bearer-token sessions, and API tokens for
machine access (n8n, scripts). All stdlib.

API tokens look like `lince_<hex>`; only their SHA-256 hash is stored, so a
leaked database doesn't leak usable tokens.
"""

import hashlib
import hmac
import secrets

from . import db

ITERATIONS = 120_000
API_TOKEN_PREFIX = "lince_"

_USER_FIELDS = "u.id, u.username, u.display_name, u.role, u.status"


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

def user_for_token(token: str | None) -> dict | None:
    """Resolve either a browser session token or a `lince_...` API token."""
    if not token:
        return None
    if token.startswith(API_TOKEN_PREFIX):
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        return db.query_one(
            f"""SELECT {_USER_FIELDS} FROM api_tokens t
                JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?""",
            (token_hash,),
        )
    return db.query_one(
        f"""SELECT {_USER_FIELDS} FROM sessions s
            JOIN users u ON u.id = s.user_id WHERE s.token = ?""",
        (token,),
    )


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
