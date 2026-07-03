"""WhisperFlow Teams API: auth, kanban tasks, shared transcriptions,
dashboard stats, and a WebSocket that keeps every connected teammate in sync.

Run with: uvicorn server.main:app --host 0.0.0.0 --port 8000
"""

import asyncio
import json
import os
import tempfile
import threading
from pathlib import Path

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from whisperflow import config as wf_config
from whisperflow.cleanup import clean

from . import auth, db

app = FastAPI(title="WhisperFlow Teams")
db.init()

# Frontend served from another origin (e.g. Vercel)? List it here:
#   WF_CORS_ORIGINS=https://tuapp.vercel.app,https://otradominio.com
_cors = [o.strip() for o in os.environ.get("WF_CORS_ORIGINS", "").split(",") if o.strip()]
if _cors:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors,
        allow_methods=["*"],
        allow_headers=["*"],
    )

STATUSES = {"todo", "doing", "done"}
PRIORITIES = {"low", "medium", "high"}

# -- transcription (lazy-loaded, serialized) ---------------------------------

_transcriber = None
_transcriber_lock = threading.Lock()


def get_transcriber():
    global _transcriber
    with _transcriber_lock:
        if _transcriber is None:
            from whisperflow.transcribe import Transcriber

            cfg = wf_config.load()
            # Hosted deployments tune the model by env var instead of config.json
            # (e.g. WF_MODEL=base on instances with little RAM).
            cfg.model = os.environ.get("WF_MODEL", cfg.model)
            cfg.device = os.environ.get("WF_DEVICE", cfg.device)
            cfg.compute_type = os.environ.get("WF_COMPUTE_TYPE", cfg.compute_type)
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

    def broadcast(self, scope: str, by: str) -> None:
        """Thread-safe: callable from worker threads running sync endpoints."""
        if not self.clients or self.loop is None:
            return
        message = json.dumps({"type": "changed", "scope": scope, "by": by})

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
    user = auth.user_for_token(token)
    if not user:
        raise HTTPException(401, "No autorizado")
    return user


class Credentials(BaseModel):
    username: str
    password: str
    display_name: str | None = None


@app.post("/api/register")
def register(body: Credentials):
    username = body.username.strip().lower()
    if len(username) < 2 or len(body.password) < 6:
        raise HTTPException(400, "Usuario mínimo 2 caracteres y contraseña mínimo 6.")
    if db.query_one("SELECT id FROM users WHERE username = ?", (username,)):
        raise HTTPException(409, "Ese usuario ya existe.")
    salt, digest = auth.hash_password(body.password)
    user_id = db.execute(
        "INSERT INTO users(username, display_name, salt, password_hash) VALUES(?,?,?,?)",
        (username, (body.display_name or body.username).strip(), salt, digest),
        returning_id=True,
    )
    token = auth.create_session(user_id)
    user = db.query_one("SELECT id, username, display_name FROM users WHERE id=?", (user_id,))
    log_activity(user, f"{user['display_name']} se unió al equipo")
    hub.broadcast("users", user["display_name"])
    return {"token": token, "user": user}


@app.post("/api/login")
def login(body: Credentials):
    row = db.query_one(
        "SELECT * FROM users WHERE username = ?", (body.username.strip().lower(),)
    )
    if not row or not auth.verify_password(body.password, row["salt"], row["password_hash"]):
        raise HTTPException(401, "Usuario o contraseña incorrectos.")
    token = auth.create_session(row["id"])
    return {
        "token": token,
        "user": {k: row[k] for k in ("id", "username", "display_name")},
    }


@app.post("/api/logout")
def logout(user: dict = Depends(current_user), authorization: str = Header(default="")):
    auth.destroy_session(authorization[7:])
    return {"ok": True}


@app.get("/api/me")
def me(user: dict = Depends(current_user)):
    return user


@app.get("/api/users")
def users(user: dict = Depends(current_user)):
    return db.query_all("SELECT id, username, display_name FROM users ORDER BY display_name")


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
    log_activity(user, f"{user['display_name']} creó la tarea «{body.title.strip()}»")
    hub.broadcast("tasks", user["display_name"])
    return db.query_one(TASK_SELECT + " WHERE t.id = ?", (task_id,))


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
        if changes.get("status") == "done" and task["status"] != "done":
            log_activity(user, f"{user['display_name']} completó «{task['title']}»")
        else:
            log_activity(user, f"{user['display_name']} actualizó «{task['title']}»")
        hub.broadcast("tasks", user["display_name"])
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

    text = clean(text, wf_config.load())
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
    if row["user_id"] != user["id"]:
        raise HTTPException(403, "Solo el autor puede borrar su transcripción.")
    db.execute("DELETE FROM transcripts WHERE id = ?", (tid,))
    hub.broadcast("transcripts", user["display_name"])
    return {"ok": True}


class ToTask(BaseModel):
    title: str | None = None


@app.post("/api/transcripts/{tid}/to-task")
def transcript_to_task(tid: int, body: ToTask, user: dict = Depends(current_user)):
    row = db.query_one("SELECT * FROM transcripts WHERE id = ?", (tid,))
    if not row:
        raise HTTPException(404, "Transcripción no encontrada.")
    title = (body.title or row["text"][:70]).strip()
    task_id = db.execute(
        """INSERT INTO tasks(title, description, status, priority, creator_id)
           VALUES(?,?,'todo','medium',?)""",
        (title, row["text"], user["id"]),
        returning_id=True,
    )
    log_activity(user, f"{user['display_name']} convirtió una transcripción en tarea")
    hub.broadcast("tasks", user["display_name"])
    return db.query_one(TASK_SELECT + " WHERE t.id = ?", (task_id,))


# -- dashboard --------------------------------------------------------------------

@app.get("/api/dashboard")
def dashboard(user: dict = Depends(current_user)):
    counts = {s: 0 for s in STATUSES}
    for row in db.query_all("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status"):
        counts[row["status"]] = row["n"]
    per_user = db.query_all(
        """SELECT u.display_name AS name, COUNT(t.id) AS open
           FROM users u LEFT JOIN tasks t
             ON t.assignee_id = u.id AND t.status != 'done'
           GROUP BY u.id ORDER BY open DESC, name"""
    )
    mine = db.query_all(
        TASK_SELECT + " WHERE t.assignee_id = ? AND t.status != 'done'"
        " ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,"
        " t.due_date IS NULL, t.due_date",
        (user["id"],),
    )
    activity = db.query_all(
        """SELECT a.text, a.created_at FROM activity a
           ORDER BY a.id DESC LIMIT 12"""
    )
    transcript_count = db.query_one("SELECT COUNT(*) AS n FROM transcripts")["n"]
    return {
        "counts": counts,
        "per_user": per_user,
        "mine": mine,
        "activity": activity,
        "transcripts": transcript_count,
    }


@app.get("/api/health")
def health():
    return {"ok": True, "model_loaded": _transcriber is not None}


# -- websocket ---------------------------------------------------------------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, token: str = ""):
    if not auth.user_for_token(token):
        await ws.close(code=4401)
        return
    await ws.accept()
    await hub.register(ws)
    try:
        while True:
            await ws.receive_text()  # keepalive pings from the client
    except WebSocketDisconnect:
        hub.clients.discard(ws)


# -- static frontend (must be mounted last) -----------------------------------------

app.mount(
    "/",
    StaticFiles(directory=Path(__file__).resolve().parent / "static", html=True),
    name="static",
)
