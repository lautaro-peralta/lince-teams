"""Avisos por correo de Lince Teams, delegados a n8n.

Teams **no manda mails**: hace un POST con un JSON a un webhook de n8n
(`LINCE_N8N_TASK_WEBHOOK`) y el workflow arma y envía el correo. Así no hay
credenciales SMTP en el servidor y se apoya en la automatización que el equipo ya
usa. Se usa `urllib` de la stdlib —mismo patrón que `auth.py` con Supabase e
`integrations.py` con GitHub— para no sumar dependencias.

El payload lleva `subject`, `body_text` y `body_html` **ya armados**, así el
workflow puede ser de dos nodos (Webhook → Gmail) sin lógica propia.

Sin `LINCE_N8N_TASK_WEBHOOK` en el entorno la función queda apagada y todo sigue
funcionando igual. Ver SETUP-AVISOS.md para el paso a paso.
"""

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone

from . import db

WEBHOOK_URL = os.environ.get("LINCE_N8N_TASK_WEBHOOK", "").strip()
WEBHOOK_SECRET = os.environ.get("LINCE_N8N_WEBHOOK_SECRET", "").strip()
APP_URL = os.environ.get("LINCE_APP_URL", "").strip().rstrip("/")

_HTTP_TIMEOUT = 10
_UA = "lince-teams"

# Validación laxa a propósito: solo descarta lo que claramente no es una
# dirección (los `username` que en realidad son un uuid o un alias local).
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]+$")

_PRIORITY_ES = {"low": "baja", "medium": "media", "high": "alta"}
_STATUS_ES = {"todo": "Por hacer", "doing": "En curso", "done": "Hecho"}


def is_email(value: str | None) -> bool:
    return bool(value and _EMAIL_RE.match(value.strip()))


def email_for_user(user_id: int | None) -> str | None:
    """Dirección de un miembro: la columna `email` si está cargada; si no, el
    `username` cuando ya es un email (modo unificado, ver auth._upsert_local)."""
    if not user_id:
        return None
    row = db.query_one("SELECT email, username FROM users WHERE id = ?", (user_id,))
    if not row:
        return None
    for candidate in (row.get("email"), row.get("username")):
        if is_email(candidate):
            return candidate.strip()
    return None


def task_url() -> str:
    """Enlace al tablero. La SPA rutea por hash con la clave de la vista
    (ver `viewFromHash` en static/app.js) y todavía no tiene ruta por tarea, así
    que el correo lleva al tablero."""
    return f"{APP_URL}/#board" if APP_URL else ""


def _esc(text: str) -> str:
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _compose(task: dict, actor_name: str, event: str) -> tuple[str, str, str]:
    """(asunto, cuerpo de texto, cuerpo HTML) del aviso."""
    title = task.get("title") or "(sin título)"
    verb = "te asignó" if event == "task.assigned" else "creó y te asignó"
    subject = f"{actor_name} {verb} «{title}»"

    detalles = [
        f"Prioridad: {_PRIORITY_ES.get(task.get('priority'), task.get('priority') or '-')}",
        f"Estado: {_STATUS_ES.get(task.get('status'), task.get('status') or '-')}",
    ]
    if task.get("due_date"):
        detalles.append(f"Vence: {task['due_date']}")

    url = task_url()
    description = (task.get("description") or "").strip()

    lines = [subject, "", *detalles]
    if description:
        lines += ["", description]
    if url:
        lines += ["", f"Abrir en Lince Teams: {url}"]
    body_text = "\n".join(lines)

    html = [
        '<div style="font-family:Georgia,serif;font-size:16px;color:#1B2B23">',
        f"<p>{_esc(actor_name)} {verb} <strong>{_esc(title)}</strong>.</p>",
        '<ul style="font-family:system-ui,sans-serif;font-size:14px">',
        *[f"<li>{_esc(d)}</li>" for d in detalles],
        "</ul>",
    ]
    if description:
        html.append(
            '<p style="font-family:system-ui,sans-serif;font-size:14px;'
            f'white-space:pre-wrap">{_esc(description)}</p>'
        )
    if url:
        html.append(
            f'<p><a href="{_esc(url)}" style="font-family:system-ui,sans-serif">'
            "Abrir en Lince Teams</a></p>"
        )
    html.append("</div>")
    return subject, body_text, "".join(html)


def _post(payload: dict) -> tuple[int, str]:
    """POST al webhook. Devuelve (status, detalle). Levanta si falla la red."""
    data = json.dumps(payload, default=str).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": _UA}
    if WEBHOOK_SECRET:
        headers["X-Lince-Token"] = WEBHOOK_SECRET
    req = urllib.request.Request(WEBHOOK_URL, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
        return resp.status, resp.read(500).decode("utf-8", "replace")


def _post_in_background(payload: dict) -> None:
    """Dispara el POST sin bloquear el request.

    Los endpoints son `def` sincrónicos y el deploy corre un solo worker a
    propósito (ver deploy/lince-teams.service), así que esperar a n8n le sumaría
    latencia a cada creación de tarea. Un aviso perdido no debe romper nada: los
    errores van a stderr y se descartan.
    """
    def run():
        try:
            _post(payload)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
            print(f"[notify] no se pudo avisar a {payload['to']['email']}: {err}",
                  file=sys.stderr)

    threading.Thread(target=run, daemon=True).start()


def build_payload(task: dict, actor: dict, event: str, email: str) -> dict:
    subject, body_text, body_html = _compose(task, actor.get("display_name") or "Alguien", event)
    return {
        "event": event,
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "to": {
            "user_id": task.get("assignee_id"),
            "name": task.get("assignee_name"),
            "email": email,
        },
        "actor": {"user_id": actor.get("id"), "name": actor.get("display_name")},
        "task": {
            "id": task.get("id"),
            "title": task.get("title"),
            "description": task.get("description") or "",
            "status": task.get("status"),
            "priority": task.get("priority"),
            "due_date": task.get("due_date"),
            "url": task_url(),
        },
        "subject": subject,
        "body_text": body_text,
        "body_html": body_html,
    }


def task_assigned(task: dict, actor: dict, event: str = "task.assigned") -> None:
    """Avisa al asignado de una tarea. Silenciosa por diseño: no hace nada si no
    hay webhook configurado, si la tarea no tiene asignado, si el asignado es
    quien hizo el cambio, o si no tenemos su email."""
    if not WEBHOOK_URL or not task:
        return
    assignee_id = task.get("assignee_id")
    if not assignee_id or assignee_id == actor.get("id"):
        return
    email = email_for_user(assignee_id)
    if not email:
        return
    _post_in_background(build_payload(task, actor, event, email))


def send_test(actor: dict) -> dict:
    """Payload de prueba, enviado de forma **sincrónica** para que un admin pueda
    verificar la configuración desde la app. Nunca levanta."""
    if not WEBHOOK_URL:
        return {"ok": False, "detail": "Falta LINCE_N8N_TASK_WEBHOOK en el entorno."}
    email = email_for_user(actor.get("id"))
    if not email:
        return {"ok": False,
                "detail": "Tu cuenta no tiene un email cargado: agregalo en Equipo."}
    task = {
        "id": 0,
        "title": "Prueba de avisos de Lince Teams",
        "description": "Si recibís este correo, el webhook de n8n está bien configurado.",
        "status": "todo",
        "priority": "medium",
        "due_date": None,
        "assignee_id": actor.get("id"),
        "assignee_name": actor.get("display_name"),
    }
    payload = build_payload(task, actor, "task.test", email)
    try:
        status, body = _post(payload)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as err:
        return {"ok": False, "detail": f"No se pudo contactar al webhook: {err}"}
    return {"ok": 200 <= status < 300, "status": status, "to": email,
            "detail": body.strip() or f"El webhook respondió {status}."}
