"""Password hashing (PBKDF2) and bearer-token sessions, stdlib only."""

import hashlib
import hmac
import secrets

from . import db

ITERATIONS = 120_000


def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), ITERATIONS
    ).hex()
    return salt, digest


def verify_password(password: str, salt: str, expected: str) -> bool:
    return hmac.compare_digest(hash_password(password, salt)[1], expected)


def create_session(user_id: int) -> str:
    token = secrets.token_hex(32)
    db.execute("INSERT INTO sessions(token, user_id) VALUES(?, ?)", (token, user_id))
    return token


def user_for_token(token: str | None) -> dict | None:
    if not token:
        return None
    return db.query_one(
        """SELECT u.id, u.username, u.display_name FROM sessions s
           JOIN users u ON u.id = s.user_id WHERE s.token = ?""",
        (token,),
    )


def destroy_session(token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token = ?", (token,))
