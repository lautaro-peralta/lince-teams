"""Lince Teams API: auth with admin approval, kanban tasks, shared
transcriptions (usable from n8n via API tokens), a realtime whiteboard,
dashboard stats, and a WebSocket that keeps every teammate in sync.

Run with: uvicorn server.main:app --host 0.0.0.0 --port 8000
"""

import asyncio
import hashlib
import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from lince import config as lince_config
from lince.cleanup import clean

from . import auth, db, integrations

app = FastAPI(title="Lince Teams")
db.init()

# Frontend served from another origin (e.g. Vercel)? List it here:
#   LINCE_CORS_ORIGINS=https://tuapp.vercel.app,https://otradominio.com
_cors = [o.strip() for o in os.environ.get("LINCE_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_methods=["*"],
        allow_headers=["*"],
    )

STATUSES = {"todo", "doing", "done"}
PRIORITIES = {"low", "medium", "high"}
ROLES = {"admin", "member"}
USER_STATUSES = {"active", "pending"}
BOARD_KINDS = {"note", "stroke", "image", "shape", "text"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}

# -- transcription (lazy-loaded, serialized) ---------------------------------

_transcriber = None
_transcriber_lock = threading.Lock()


def get_transcriber():
    global _transcriber
    with _transcriber_lock:
        if _transcriber is None:
            from lince.transcribe import Transcriber

            cfg = lince_config.load()
            # Hosted deployments tune the model by env var instead of config.json
            # (e.g. LINCE_MODEL=base on instances with little RAM).
            cfg.model = os.environ.get("LINCE_MODEL", cfg.model)
            cfg.device = os.environ.get("LINCE_DEVICE", cfg.device)
            cfg.compute_type = os.environ.get("LINCE_COMPUTE_TYPE", cfg.compute_type)
            _transcriber = Transcriber(cfg)
        return _transcriber


# -- live updates --------------------------------------------------------------

class Hub:
    def __init__(self):
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def register(self, ws: WebSocket) -> None:
        self.loop = asyncio.get_running_loop()
        self.clients.add(ws)

    def broadcast(self, scope: str, by: str, data: dict | None = None) -> None:
        """Thread-safe: callable from worker threads running sync endpoints."""
        if not self.clients or self.loop is None:
            return
        message = json.dumps(
            {"type": "changed", "scope": scope, "by": by, "data": data},
            default=str,
        )

        async def _send():
            dead = set()
            for ws in self.clients:
                try:
                    await ws.send_text(message)
                except Exception:
                    dead.add(ws)
            self.clients -= dead

        asyncio.run_coroutine_threadsafe(_send(), self.loop)


hub = Hub()


def log_activity(user: dict, text: str) -> None:
    db.execute("INSERT INTO activity(user_id, text) VALUES(?, ?)", (user["id"], text))


# -- auth ----------------------------------------------------------------------

def current_user(authorization: str | None = Header(default=None)) -> dict:
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:]
    if not token:
        raise HTTPException(401, "No autorizado")

    if token.startswith(auth.API_TOKEN_PREFIX):
        user = auth.user_for_api_token(token)
    elif auth.SUPABASE_MODE:
        # Login unificado: el token es un JWT de Supabase (mismo del panel).
        au = auth.supabase_user(token)
        if not au:
            raise HTTPException(401, "Sesión inválida o expirada.")
        user = auth.provision_member(au)
        if not user:
            raise HTTPException(403, "Tu cuenta no tiene acceso a Lince Teams.")
    else:
        user = auth.user_for_session(token)

    if not user:
        raise HTTPException(401, "No autorizado")
    if user["status"] != "active":
        raise HTTPException(403, "Tu cuenta está pendiente de aprobación.")
    return user


def current_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Solo para administradores.")
    return user


class Credentials(BaseModel):
    username: str
    password: str
    display_name: str | None = None


def _reject_local_auth() -> None:
    """En modo unificado no hay registro/login propios: se usa el del panel."""
    if auth.SUPABASE_MODE:
        raise HTTPException(403, "El acceso se gestiona desde el panel de Lince.")


@app.post("/api/register")
def register(body: Credentials):
    _reject_local_auth()
    username = body.username.strip().lower()
    if len(username) < 2 or len(body.password) < 6:
        raise HTTPException(400, "Usuario mínimo 2 caracteres y contraseña mínimo 6.")
    if db.query_one("SELECT id FROM users WHERE username = ?", (username,)):
        raise HTTPException(409, "Ese usuario ya existe.")

    first_user = db.query_one("SELECT COUNT(*) AS n FROM users")["n"] == 0
    role = "admin" if first_user else "member"
    status = "active" if first_user else "pending"

    salt, digest = auth.hash_password(body.password)
    user_id = db.execute(
        """INSERT INTO users(username, display_name, salt, password_hash, role, status)
           VALUES(?,?,?,?,?,?)""",
        (username, (body.display_name or body.username).strip(), salt, digest, role, status),
        returning_id=True,
    )
    user = db.query_one(
        "SELECT id, username, display_name, role, status FROM users WHERE id = ?",
        (user_id,),
    )

    if status == "pending":
        log_activity(user, f"{user['display_name']} solicitó unirse al equipo")
        hub.broadcast("users", user["display_name"])
        return {"pending": True,
                "detail": "Cuenta creada. Un administrador debe aprobarla antes de entrar."}

    log_activity(user, f"{user['display_name']} creó el equipo")
    return {"token": auth.create_session(user_id), "user": user}


@app.post("/api/login")
def login(body: Credentials):
    _reject_local_auth()
    row = db.query_one(
        "SELECT * FROM users WHERE username = ?", (body.username.strip().lower(),)
    )
    if not row or not auth.verify_password(body.password, row["salt"], row["password_hash"]):
        raise HTTPException(401, "Usuario o contraseña incorrectos.")
    if row["status"] != "active":
        raise HTTPException(403, "Tu cuenta espera la aprobación del administrador.")
    return {
        "token": auth.create_session(row["id"]),
        "user": {k: row[k] for k in ("id", "username", "display_name", "role", "status")},
    }


@app.post("/api/logout")
def logout(user: dict = Depends(current_user), authorization: str = Header(default="")):
    token = authorization[7:]
    if not token.startswith(auth.API_TOKEN_PREFIX):
        auth.destroy_session(token)
    return {"ok": True}


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return user


@app.get("/api/users")
def users(user: dict = Depends(current_user)):
    auth.sync_members()  # modo unificado: refleja a todos los socios/admins de Supabase
    return db.query_all(
        """SELECT id, username, display_name FROM users
           WHERE status = 'active' ORDER BY display_name"""
    )


# -- administración del equipo -----------------------------------------------------

@app.get("/api/admin/members")
def admin_members(admin: dict = Depends(current_admin)):
    auth.sync_members()  # modo unificado: trae a los socios/admins aunque no hayan entrado
    return db.query_all(
        """SELECT id, username, display_name, role, status, created_at
           FROM users ORDER BY status DESC, created_at"""
    )


class MemberPatch(BaseModel):
    role: str | None = None
    status: str | None = None


@app.patch("/api/admin/members/{member_id}")
def admin_update_member(member_id: int, body: MemberPatch,
                        admin: dict = Depends(current_admin)):
    if auth.SUPABASE_MODE:
        raise HTTPException(403, "Gestioná miembros y roles desde el panel de Lince (Supabase).")
    member = db.query_one("SELECT * FROM users WHERE id = ?", (member_id,))
    if not member:
        raise HTTPException(404, "Miembro no encontrado.")
    changes = body.model_dump(exclude_unset=True)
    if "role" in changes and changes["role"] not in ROLES:
        raise HTTPException(400, "Rol inválido.")
    if "status" in changes and changes["status"] not in USER_STATUSES:
        raise HTTPException(400, "Estado inválido.")
    if member_id == admin["id"] and (
        changes.get("role") == "member" or changes.get("status") == "pending"
    ):
        raise HTTPException(400, "No puedes quitarte el acceso a ti mismo.")
    if changes:
        sets = ", ".join(f"{k} = ?" for k in changes)
        db.execute(f"UPDATE users SET {sets} WHERE id = ?", (*changes.values(), member_id))
        if changes.get("status") == "active" and member["status"] != "active":
            log_activity(admin, f"{admin['display_name']} aprobó a {member['display_name']}")
        if changes.get("status") == "pending":
            # Revocar acceso: además, cerramos sus sesiones y tokens.
            db.execute("DELETE FROM sessions WHERE user_id = ?", (member_id,))
            db.execute("DELETE FROM api_tokens WHERE user_id = ?", (member_id,))
            log_activity(admin, f"{admin['display_name']} revocó el acceso de {member['display_name']}")
        hub.broadcast("users", admin["display_name"])
    return db.query_one(
        "SELECT id, username, display_name, role, status, created_at FROM users WHERE id = ?",
        (member_id,),
    )


@app.delete("/api/admin/members/{member_id}")
def admin_delete_member(member_id: int, admin: dict = Depends(current_admin)):
    if auth.SUPABASE_MODE:
        raise HTTPException(403, "Gestioná las cuentas desde el panel de Lince (Supabase).")
    if member_id == admin["id"]:
        raise HTTPException(400, "No puedes eliminarte a ti mismo.")
    member = db.query_one("SELECT * FROM users WHERE id = ?", (member_id,))
    if not member:
        raise HTTPException(404, "Miembro no encontrado.")
    db.execute("DELETE FROM users WHERE id = ?", (member_id,))
    log_activity(admin, f"{admin['display_name']} eliminó la cuenta de {member['display_name']}")
    hub.broadcast("users", admin["display_name"])
    return {"ok": True}


# -- tokens de API (n8n, scripts) ----------------------------------------------------

class TokenIn(BaseModel):
    name: str = "n8n"


@app.post("/api/tokens")
def create_token(body: TokenIn, user: dict = Depends(current_user)):
    raw, row_id = auth.create_api_token(user["id"], body.name.strip() or "token")
    row = db.query_one(
        "SELECT id, name, prefix, created_at FROM api_tokens WHERE id = ?", (row_id,)
    )
    return {**row, "token": raw}  # el token en claro solo se devuelve aquí


@app.get("/api/tokens")
def list_tokens(user: dict = Depends(current_user)):
    return db.query_all(
        """SELECT id, name, prefix, created_at FROM api_tokens
           WHERE user_id = ? ORDER BY created_at DESC""",
        (user["id"],),
    )


@app.delete("/api/tokens/{token_id}")
def delete_token(token_id: int, user: dict = Depends(current_user)):
    row = db.query_one("SELECT * FROM api_tokens WHERE id = ?", (token_id,))
    if not row or row["user_id"] != user["id"]:
        raise HTTPException(404, "Token no encontrado.")
    db.execute("DELETE FROM api_tokens WHERE id = ?", (token_id,))
    return {"ok": True}


# -- tasks -----------------------------------------------------------------------

class TaskIn(BaseModel):
    title: str
    description: str = ""
    status: str = "todo"
    priority: str = "medium"
    assignee_id: int | None = None
    due_date: str | None = None


class TaskPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: str | None = None
    assignee_id: int | None = None
    due_date: str | None = None


TASK_SELECT = """
SELECT t.*, a.display_name AS assignee_name, c.display_name AS creator_name
FROM tasks t
LEFT JOIN users a ON a.id = t.assignee_id
LEFT JOIN users c ON c.id = t.creator_id
"""


@app.get("/api/tasks")
def list_tasks(user: dict = Depends(current_user)):
    return db.query_all(TASK_SELECT + " ORDER BY t.updated_at DESC")


@app.post("/api/tasks")
def create_task(body: TaskIn, user: dict = Depends(current_user)):
    if not body.title.strip():
        raise HTTPException(400, "La tarea necesita un título.")
    if body.status not in STATUSES or body.priority not in PRIORITIES:
        raise HTTPException(400, "Estado o prioridad inválidos.")
    task_id = db.execute(
        """INSERT INTO tasks(title, description, status, priority, assignee_id,
           creator_id, due_date) VALUES(?,?,?,?,?,?,?)""",
        (body.title.strip(), body.description, body.status, body.priority,
         body.assignee_id, user["id"], body.due_date),
        returning_id=True,
    )
    task = db.query_one(TASK_SELECT + " WHERE t.id = ?", (task_id,))
    if task["assignee_name"] and task["assignee_id"] != user["id"]:
        log_activity(user, f"{user['display_name']} asignó «{task['title']}» a {task['assignee_name']}")
    else:
        log_activity(user, f"{user['display_name']} creó la tarea «{task['title']}»")
    hub.broadcast("tasks", user["display_name"])
    return task


@app.patch("/api/tasks/{task_id}")
def update_task(task_id: int, body: TaskPatch, user: dict = Depends(current_user)):
    task = db.query_one("SELECT * FROM tasks WHERE id = ?", (task_id,))
    if not task:
        raise HTTPException(404, "Tarea no encontrada.")
    changes = body.model_dump(exclude_unset=True)
    if "status" in changes and changes["status"] not in STATUSES:
        raise HTTPException(400, "Estado inválido.")
    if "priority" in changes and changes["priority"] not in PRIORITIES:
        raise HTTPException(400, "Prioridad inválida.")
    if changes:
        sets = ", ".join(f"{k} = ?" for k in changes)
        db.execute(
            f"UPDATE tasks SET {sets}, updated_at = {db.NOW} WHERE id = ?",
            (*changes.values(), task_id),
        )
        new = db.query_one(TASK_SELECT + " WHERE t.id = ?", (task_id,))
        if changes.get("status") == "done" and task["status"] != "done":
            log_activity(user, f"{user['display_name']} completó «{task['title']}»")
        elif "assignee_id" in changes and new["assignee_name"] and changes["assignee_id"] != user["id"]:
            log_activity(user, f"{user['display_name']} asignó «{task['title']}» a {new['assignee_name']}")
        else:
            log_activity(user, f"{user['display_name']} actualizó «{task['title']}»")
        hub.broadcast("tasks", user["display_name"])
        return new
    return db.query_one(TASK_SELECT + " WHERE t.id = ?", (task_id,))


@app.delete("/api/tasks/{task_id}")
def delete_task(task_id: int, user: dict = Depends(current_user)):
    task = db.query_one("SELECT * FROM tasks WHERE id = ?", (task_id,))
    if not task:
        raise HTTPException(404, "Tarea no encontrada.")
    db.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    log_activity(user, f"{user['display_name']} eliminó «{task['title']}»")
    hub.broadcast("tasks", user["display_name"])
    return {"ok": True}


# -- transcriptions ---------------------------------------------------------------

@app.post("/api/transcribe")
def transcribe(audio: UploadFile, user: dict = Depends(current_user)):
    suffix = Path(audio.filename or "rec.webm").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio.file.read())
        tmp_path = Path(tmp.name)
    try:
        transcriber = get_transcriber()
        with _transcriber_lock:
            text, language, duration = transcriber.transcribe_with_info(str(tmp_path))
    finally:
        tmp_path.unlink(missing_ok=True)

    text = clean(text, lince_config.load())
    if not text:
        raise HTTPException(422, "No se reconoció voz en el audio.")
    tid = db.execute(
        "INSERT INTO transcripts(user_id, text, language, duration) VALUES(?,?,?,?)",
        (user["id"], text, language, duration),
        returning_id=True,
    )
    log_activity(user, f"{user['display_name']} añadió una transcripción")
    hub.broadcast("transcripts", user["display_name"])
    return db.query_one(
        """SELECT t.*, u.display_name AS author FROM transcripts t
           LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?""",
        (tid,),
    )


@app.get("/api/transcripts")
def list_transcripts(user: dict = Depends(current_user)):
    return db.query_all(
        """SELECT t.*, u.display_name AS author FROM transcripts t
           LEFT JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT 200"""
    )


@app.delete("/api/transcripts/{tid}")
def delete_transcript(tid: int, user: dict = Depends(current_user)):
    row = db.query_one("SELECT * FROM transcripts WHERE id = ?", (tid,))
    if not row:
        raise HTTPException(404, "Transcripción no encontrada.")
    if row["user_id"] != user["id"] and user["role"] != "admin":
        raise HTTPException(403, "Solo el autor o un admin puede borrarla.")
    db.execute("DELETE FROM transcripts WHERE id = ?", (tid,))
    hub.broadcast("transcripts", user["display_name"])
    return {"ok": True}


class ToTask(BaseModel):
    title: str | None = None
    assignee_id: int | None = None


@app.post("/api/transcripts/{tid}/to-task")
def transcript_to_task(tid: int, body: ToTask, user: dict = Depends(current_user)):
    row = db.query_one("SELECT * FROM transcripts WHERE id = ?", (tid,))
    if not row:
        raise HTTPException(404, "Transcripción no encontrada.")
    title = (body.title or row["text"][:70]).strip()
    task_id = db.execute(
        """INSERT INTO tasks(title, description, status, priority, assignee_id, creator_id)
           VALUES(?,?,'todo','medium',?,?)""",
        (title, row["text"], body.assignee_id, user["id"]),
        returning_id=True,
    )
    log_activity(user, f"{user['display_name']} convirtió una transcripción en tarea")
    hub.broadcast("tasks", user["display_name"])
    return db.query_one(TASK_SELECT + " WHERE t.id = ?", (task_id,))


# -- pizarra colaborativa -----------------------------------------------------------

BOARD_SELECT = """
SELECT b.*, u.display_name AS author FROM board_items b
LEFT JOIN users u ON u.id = b.created_by
"""


class BoardItemIn(BaseModel):
    kind: str
    x: float = 0
    y: float = 0
    w: float | None = None
    h: float | None = None
    z: int = 0
    color: str | None = None
    content: str = ""


class BoardItemPatch(BaseModel):
    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None
    z: int | None = None
    color: str | None = None
    content: str | None = None


@app.get("/api/board")
def board_items(user: dict = Depends(current_user)):
    return db.query_all(BOARD_SELECT + " ORDER BY b.z, b.id")


@app.post("/api/board")
def board_create(body: BoardItemIn, user: dict = Depends(current_user)):
    if body.kind not in BOARD_KINDS:
        raise HTTPException(400, "Tipo de elemento inválido.")
    if len(body.content) > 200_000:
        raise HTTPException(413, "Elemento demasiado grande.")
    item_id = db.execute(
        """INSERT INTO board_items(kind, x, y, w, h, z, color, content, created_by)
           VALUES(?,?,?,?,?,?,?,?,?)""",
        (body.kind, body.x, body.y, body.w, body.h, body.z, body.color,
         body.content, user["id"]),
        returning_id=True,
    )
    item = db.query_one(BOARD_SELECT + " WHERE b.id = ?", (item_id,))
    hub.broadcast("board", user["display_name"], {"action": "upsert", "item": item})
    return item


@app.patch("/api/board/{item_id}")
def board_update(item_id: int, body: BoardItemPatch, user: dict = Depends(current_user)):
    if not db.query_one("SELECT id FROM board_items WHERE id = ?", (item_id,)):
        raise HTTPException(404, "Elemento no encontrado.")
    changes = body.model_dump(exclude_unset=True)
    if changes:
        sets = ", ".join(f"{k} = ?" for k in changes)
        db.execute(
            f"UPDATE board_items SET {sets}, updated_at = {db.NOW} WHERE id = ?",
            (*changes.values(), item_id),
        )
    item = db.query_one(BOARD_SELECT + " WHERE b.id = ?", (item_id,))
    hub.broadcast("board", user["display_name"], {"action": "upsert", "item": item})
    return item


@app.delete("/api/board")
def board_clear(user: dict = Depends(current_user)):
    """Vacía la pizarra por completo (para todo el equipo)."""
    for row in db.query_all("SELECT content FROM board_items WHERE kind = 'image'"):
        content = row["content"] or ""
        if content.startswith("/uploads/"):
            (db.UPLOADS_DIR / Path(content).name).unlink(missing_ok=True)
    db.execute("DELETE FROM board_items")
    hub.broadcast("board", user["display_name"], {"action": "clear"})
    return {"ok": True}


@app.delete("/api/board/{item_id}")
def board_delete(item_id: int, user: dict = Depends(current_user)):
    item = db.query_one("SELECT * FROM board_items WHERE id = ?", (item_id,))
    if not item:
        raise HTTPException(404, "Elemento no encontrado.")
    if item["kind"] == "image" and item["content"].startswith("/uploads/"):
        (db.UPLOADS_DIR / Path(item["content"]).name).unlink(missing_ok=True)
    db.execute("DELETE FROM board_items WHERE id = ?", (item_id,))
    hub.broadcast("board", user["display_name"], {"action": "delete", "id": item_id})
    return {"ok": True}


@app.post("/api/board/image")
def board_upload_image(image: UploadFile, user: dict = Depends(current_user)):
    ext = Path(image.filename or "").suffix.lower()
    if ext not in IMAGE_EXTS:
        raise HTTPException(400, f"Formato no soportado ({ext or 'sin extensión'}).")
    data = image.file.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(413, "Imagen demasiado grande (máx. 5 MB).")
    name = f"{uuid.uuid4().hex}{ext}"
    (db.UPLOADS_DIR / name).write_bytes(data)
    return {"url": f"/uploads/{name}"}


# -- integraciones (Google Drive, GitHub, otras herramientas) -----------------

class IntegrationIn(BaseModel):
    provider: str
    name: str = ""
    url: str = ""
    owner: str | None = None   # GitHub: alternativa a pegar la URL del repo
    repo: str | None = None
    token: str | None = None   # credencial (p. ej. PAT de GitHub) → columna `secret`


class IntegrationPatch(BaseModel):
    name: str | None = None
    url: str | None = None
    owner: str | None = None
    repo: str | None = None
    token: str | None = None   # "" borra el token guardado; None lo deja igual


INTEGRATION_SELECT = """
SELECT i.*, u.display_name AS author FROM integrations i
LEFT JOIN users u ON u.id = i.created_by
"""


def _load_integration(iid: int) -> dict:
    row = db.query_one(INTEGRATION_SELECT + " WHERE i.id = ?", (iid,))
    if not row:
        raise HTTPException(404, "Integración no encontrada.")
    return row


def _github_coords(row: dict) -> tuple[str, str, str]:
    """(owner, repo, token) de una conexión de GitHub; 400 si está incompleta."""
    if row["provider"] != "github":
        raise HTTPException(400, "Esta acción es solo para conexiones de GitHub.")
    try:
        cfg = json.loads(row.get("config") or "{}")
    except ValueError:
        cfg = {}
    owner, repo = cfg.get("owner"), cfg.get("repo")
    if not owner or not repo:
        raise HTTPException(400, "La conexión de GitHub no tiene un repositorio configurado.")
    return owner, repo, (row.get("secret") or "")


@app.get("/api/integrations")
def list_integrations(user: dict = Depends(current_user)):
    rows = db.query_all(INTEGRATION_SELECT + " ORDER BY i.provider, i.created_at DESC")
    return [integrations.public_view(r) for r in rows]


@app.post("/api/integrations")
def create_integration(body: IntegrationIn, admin: dict = Depends(current_admin)):
    provider = body.provider.strip()
    if provider not in integrations.PROVIDERS:
        raise HTTPException(400, "Proveedor no soportado.")
    name, url, config = body.name.strip(), body.url.strip(), {}
    if provider == "github":
        source = f"{body.owner}/{body.repo}" if body.owner and body.repo else url
        coords = integrations.parse_github_repo(source)
        if not coords:
            raise HTTPException(400, "Indicá el repo de GitHub como owner/repo o su URL.")
        owner, repo = coords
        config = {"owner": owner, "repo": repo}
        # Siempre guardamos la URL canónica del repo (aunque hayan pegado un slug
        # `owner/repo`), para que el enlace "Abrir" no quede relativo.
        url = f"https://github.com/{owner}/{repo}"
        name = name or f"{owner}/{repo}"
    elif provider == "google_drive":
        if not url:
            raise HTTPException(400, "Pegá el enlace de Google Drive/Docs.")
        name = name or "Google Drive"
    else:  # other
        if not url:
            raise HTTPException(400, "Indicá el enlace de la herramienta.")
        if not name:
            raise HTTPException(400, "Poné un nombre para la herramienta.")
    iid = db.execute(
        "INSERT INTO integrations(provider, name, url, config, secret, created_by) VALUES(?,?,?,?,?,?)",
        (provider, name, url, json.dumps(config), (body.token or "").strip(), admin["id"]),
        returning_id=True,
    )
    log_activity(admin, f"{admin['display_name']} conectó «{name}»")
    hub.broadcast("integrations", admin["display_name"])
    return integrations.public_view(_load_integration(iid))


@app.patch("/api/integrations/{iid}")
def update_integration(iid: int, body: IntegrationPatch, admin: dict = Depends(current_admin)):
    row = _load_integration(iid)
    sets: list[str] = []
    params: list = []
    if body.name is not None and body.name.strip():
        sets.append("name = ?"); params.append(body.name.strip())
    if row["provider"] == "github":
        # En GitHub, repo y URL van juntos: recalculamos config + URL canónica.
        if body.owner or body.repo or body.url is not None:
            source = f"{body.owner}/{body.repo}" if body.owner and body.repo else (body.url or row["url"])
            coords = integrations.parse_github_repo(source)
            if not coords:
                raise HTTPException(400, "Repo de GitHub inválido (usá owner/repo o su URL).")
            sets += ["config = ?", "url = ?"]
            params += [json.dumps({"owner": coords[0], "repo": coords[1]}),
                       f"https://github.com/{coords[0]}/{coords[1]}"]
    elif body.url is not None:
        sets.append("url = ?"); params.append(body.url.strip())
    if body.token is not None:  # "" borra el token; un valor lo reemplaza
        sets.append("secret = ?"); params.append(body.token.strip())
    if sets:
        db.execute(f"UPDATE integrations SET {', '.join(sets)} WHERE id = ?", (*params, iid))
        hub.broadcast("integrations", admin["display_name"])
    return integrations.public_view(_load_integration(iid))


@app.delete("/api/integrations/{iid}")
def delete_integration(iid: int, admin: dict = Depends(current_admin)):
    row = _load_integration(iid)
    db.execute("DELETE FROM integrations WHERE id = ?", (iid,))
    log_activity(admin, f"{admin['display_name']} quitó la integración «{row['name']}»")
    hub.broadcast("integrations", admin["display_name"])
    return {"ok": True}


@app.get("/api/integrations/{iid}/github/issues")
def github_issues(iid: int, state: str = "open", user: dict = Depends(current_user)):
    owner, repo, token = _github_coords(_load_integration(iid))
    try:
        items = integrations.list_github_issues(owner, repo, token, state=state)
    except integrations.IntegrationError as e:
        raise HTTPException(502, str(e))
    return {
        "repo": f"{owner}/{repo}",
        "issues": [i for i in items if not i["is_pr"]],
        "pulls": [i for i in items if i["is_pr"]],
    }


class GithubIssueIn(BaseModel):
    title: str = ""
    body: str = ""
    task_id: int | None = None   # crear el issue a partir de una tarea existente


@app.post("/api/integrations/{iid}/github/issues")
def github_create_issue(iid: int, body: GithubIssueIn, user: dict = Depends(current_user)):
    owner, repo, token = _github_coords(_load_integration(iid))
    title, text = body.title.strip(), body.body
    if body.task_id:
        task = db.query_one("SELECT * FROM tasks WHERE id = ?", (body.task_id,))
        if not task:
            raise HTTPException(404, "Tarea no encontrada.")
        title = title or task["title"]
        text = text or task["description"] or ""
        text = f"{text}\n\n— Creado desde Lince Teams por {user['display_name']}.".strip()
    try:
        issue = integrations.create_github_issue(owner, repo, token, title, text)
    except integrations.IntegrationError as e:
        raise HTTPException(502, str(e))
    log_activity(user, f"{user['display_name']} creó el issue #{issue['number']} en {owner}/{repo}")
    hub.broadcast("integrations", user["display_name"])
    return issue


@app.post("/api/integrations/{iid}/github/import/{number}")
def github_import_issue(iid: int, number: int, user: dict = Depends(current_user)):
    owner, repo, token = _github_coords(_load_integration(iid))
    try:
        issue = integrations.get_github_issue(owner, repo, number, token)
    except integrations.IntegrationError as e:
        raise HTTPException(502, str(e))
    desc = (issue["body"] or "").strip()
    description = f"{desc}\n\n{issue['url']}".strip() if desc else issue["url"]
    task_id = db.execute(
        """INSERT INTO tasks(title, description, status, priority, creator_id)
           VALUES(?,?,'todo','medium',?)""",
        (issue["title"][:200], description, user["id"]),
        returning_id=True,
    )
    log_activity(user, f"{user['display_name']} importó el issue #{number} de {owner}/{repo} como tarea")
    hub.broadcast("tasks", user["display_name"])
    return db.query_one(TASK_SELECT + " WHERE t.id = ?", (task_id,))


# -- dashboard --------------------------------------------------------------------

def _done_by_day(days: int = 14) -> list[dict]:
    """Completed tasks bucketed by day, timezone-agnostic across both DBs."""
    rows = db.query_all("SELECT updated_at FROM tasks WHERE status = 'done'")
    today = datetime.now(timezone.utc).date()
    buckets = {today - timedelta(days=i): 0 for i in range(days)}
    for r in rows:
        ts = r["updated_at"]
        if isinstance(ts, str):
            ts = datetime.fromisoformat(ts.replace(" ", "T")).replace(tzinfo=timezone.utc)
        day = ts.astimezone(timezone.utc).date()
        if day in buckets:
            buckets[day] += 1
    return [
        {"day": d.isoformat(), "n": buckets[d]}
        for d in sorted(buckets)
    ]


@app.get("/api/dashboard")
def dashboard(user: dict = Depends(current_user)):
    counts = {s: 0 for s in STATUSES}
    for row in db.query_all("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status"):
        counts[row["status"]] = row["n"]
    per_user = db.query_all(
        """SELECT u.display_name AS name, COUNT(t.id) AS open
           FROM users u LEFT JOIN tasks t
             ON t.assignee_id = u.id AND t.status != 'done'
           WHERE u.status = 'active'
           GROUP BY u.id ORDER BY open DESC, name"""
    )
    mine = db.query_all(
        TASK_SELECT + " WHERE t.assignee_id = ? AND t.status != 'done'"
        " ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,"
        " t.due_date IS NULL, t.due_date",
        (user["id"],),
    )
    activity = db.query_all(
        "SELECT a.text, a.created_at FROM activity a ORDER BY a.id DESC LIMIT 12"
    )
    transcript_count = db.query_one("SELECT COUNT(*) AS n FROM transcripts")["n"]
    pending_members = db.query_one(
        "SELECT COUNT(*) AS n FROM users WHERE status = 'pending'"
    )["n"]
    return {
        "counts": counts,
        "per_user": per_user,
        "mine": mine,
        "activity": activity,
        "transcripts": transcript_count,
        "done_by_day": _done_by_day(),
        "pending_members": pending_members,
    }


@app.get("/api/health")
def health():
    return {"ok": True, "model_loaded": _transcriber is not None}


@app.get("/api/config")
def public_config():
    """Config pública para el frontend (sin auth). En modo unificado devuelve la
    URL + anon key de Supabase (valores públicos) para que el navegador use la
    MISMA sesión que el panel; en standalone, `supabase: false` y el frontend
    muestra su login propio."""
    if not auth.SUPABASE_MODE:
        return {"supabase": False}
    return {
        "supabase": True,
        "supabaseUrl": auth.SUPABASE_URL,
        "supabaseAnonKey": auth.SUPABASE_ANON_KEY,
        # A dónde mandar a iniciar sesión cuando no hay sesión. En un despliegue
        # unificado (mismo origen, /teams tras el panel) alcanza con /admin.
        "loginUrl": os.environ.get("LINCE_LOGIN_URL", "/admin"),
    }


@app.get("/config.js")
def config_js():
    """Sirve config.js de forma DINÁMICA a partir de la variable LINCE_API_BASE,
    para no tener que editar el archivo estático (que es trackeado por git y se
    pisaría en cada `git pull`). Tras el reverse-proxy same-origin se setea
    LINCE_API_BASE=/teams en el entorno; vacío = mismo origen (standalone).
    Esta ruta va antes del `mount("/")`, así que gana sobre el archivo estático."""
    base = os.environ.get("LINCE_API_BASE", "")
    body = f"window.LINCE_API_BASE = {json.dumps(base)};\n"
    # Dinámico: no debe quedar cacheado (ni en el navegador ni en Cloudflare).
    return Response(body, media_type="application/javascript",
                    headers={"Cache-Control": "no-cache"})


# -- websocket ---------------------------------------------------------------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = ""):
    user = auth.user_for_token(token)
    if not user or user["status"] != "active":
        await ws.close(code=4401)
        return
    await ws.accept()
    await hub.register(ws)
    try:
        while True:
            await ws.receive_text()  # keepalive pings from the client
    except WebSocketDisconnect:
        hub.clients.discard(ws)


# -- static (mounted last so /api and /ws win) ---------------------------------------

STATIC_DIR = Path(__file__).resolve().parent / "static"


def _asset_version() -> str:
    """Hash corto del contenido de los estáticos que cambian entre deploys, para
    "cache-bustear" app.js/style.css. Se calcula una vez al arrancar; como el
    deploy reinicia el proceso, siempre refleja los archivos desplegados."""
    h = hashlib.md5()
    for name in ("app.js", "style.css"):
        try:
            h.update((STATIC_DIR / name).read_bytes())
        except FileNotFoundError:
            pass
    return h.hexdigest()[:8]


ASSET_VERSION = _asset_version()


@app.get("/")
@app.get("/index.html")
def index():
    """Sirve index.html con las URLs de los estáticos versionadas (?v=hash) y
    Cache-Control: no-cache. Así, al cambiar app.js/style.css cambia su URL y el
    navegador —y Cloudflare, que cachea .js/.css por extensión— piden la versión
    nueva en vez de servir una vieja. Va antes del mount('/'), así que gana."""
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="style.css"', f'href="style.css?v={ASSET_VERSION}"')
    html = html.replace('src="app.js"', f'src="app.js?v={ASSET_VERSION}"')
    return Response(
        html,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-cache"},
    )


app.mount("/uploads", StaticFiles(directory=db.UPLOADS_DIR), name="uploads")
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
