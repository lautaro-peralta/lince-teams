"""Integraciones de Lince Teams con herramientas externas.

Cada integración es una **conexión** que el equipo registra (un repo de GitHub,
una carpeta/archivo de Google Drive, o cualquier otra herramienta por enlace).
Se guardan en la tabla `integrations`:

- `provider`  — 'github' | 'google_drive' | 'other'.
- `name`      — etiqueta visible.
- `url`       — enlace canónico (repo, carpeta de Drive, panel de la herramienta…).
- `config`    — JSON con datos NO sensibles del proveedor (owner/repo, id de Drive…).
- `secret`    — credencial (p. ej. un PAT de GitHub). NUNCA se devuelve al cliente.

Solo GitHub tiene integración "viva" (API REST): listar issues/PRs, crear un
issue, o importar un issue como tarea. Se usa `urllib` de la stdlib —mismo patrón
que `auth.py` con Supabase— para no sumar dependencias. Google Drive y "otras"
son lanzadores por enlace (con vista previa incrustada cuando el enlace lo
permite), sin OAuth: encaja con el enfoque autoalojado y sin cuentas de terceros.
"""

import json
import re
import urllib.error
import urllib.request

PROVIDERS = {"github", "google_drive", "other"}

GITHUB_API = "https://api.github.com"
_UA = "lince-teams"
_HTTP_TIMEOUT = 12


class IntegrationError(Exception):
    """Error legible para el usuario al hablar con un servicio externo."""


# ── GitHub ───────────────────────────────────────────────────────────────────

_GH_URL_RE = re.compile(
    r"(?:https?://)?(?:www\.)?github\.com/(?P<owner>[^/\s]+)/(?P<repo>[^/\s#?]+)",
    re.IGNORECASE,
)
_GH_SLUG_RE = re.compile(r"^\s*(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+)\s*$")


def parse_github_repo(text: str | None) -> tuple[str, str] | None:
    """Extrae (owner, repo) de una URL de GitHub o de un slug `owner/repo`."""
    if not text:
        return None
    m = _GH_URL_RE.search(text) or _GH_SLUG_RE.match(text)
    if not m:
        return None
    repo = m.group("repo")
    if repo.endswith(".git"):
        repo = repo[:-4]
    owner = m.group("owner").strip()
    repo = repo.strip()
    if not owner or not repo:
        return None
    return owner, repo


def _github(method: str, path: str, token: str = "", payload: dict | None = None) -> object:
    """Llama a la API REST de GitHub y devuelve el JSON decoderado.

    Lanza IntegrationError con un mensaje legible ante cualquier fallo (repo
    inexistente, token inválido, sin permisos, red caída…)."""
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": _UA,
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(GITHUB_API + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            body = resp.read()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = json.loads(e.read()).get("message", "")
        except Exception:
            pass
        if e.code == 401:
            raise IntegrationError("GitHub rechazó el token (401). Revisá el PAT.")
        if e.code == 403:
            raise IntegrationError(detail or "GitHub denegó el acceso (403 · límite o permisos).")
        if e.code == 404:
            raise IntegrationError("Repositorio o recurso no encontrado en GitHub (404).")
        raise IntegrationError(detail or f"GitHub respondió {e.code}.")
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        raise IntegrationError(f"No se pudo contactar con GitHub: {e}")


def _issue_view(raw: dict) -> dict:
    """Normaliza un issue/PR de GitHub a lo justo que usa el frontend."""
    return {
        "number": raw.get("number"),
        "title": raw.get("title") or "(sin título)",
        "url": raw.get("html_url") or "",
        "state": raw.get("state") or "open",
        "author": (raw.get("user") or {}).get("login") or "",
        "labels": [
            {"name": l.get("name", ""), "color": l.get("color", "")}
            for l in (raw.get("labels") or [])
            if isinstance(l, dict)
        ],
        "comments": raw.get("comments") or 0,
        "updated_at": raw.get("updated_at") or "",
        "is_pr": "pull_request" in raw,
        "body": raw.get("body") or "",
    }


def list_github_issues(owner: str, repo: str, token: str = "",
                       state: str = "open", limit: int = 30) -> list[dict]:
    """Issues y PRs del repo (GitHub mezcla ambos en /issues). Se devuelven
    normalizados; el frontend los separa por `is_pr`."""
    state = state if state in ("open", "closed", "all") else "open"
    limit = max(1, min(int(limit or 30), 100))
    data = _github(
        "GET",
        f"/repos/{owner}/{repo}/issues?state={state}&per_page={limit}&sort=updated&direction=desc",
        token,
    )
    if not isinstance(data, list):
        return []
    return [_issue_view(r) for r in data]


def get_github_issue(owner: str, repo: str, number: int, token: str = "") -> dict:
    data = _github("GET", f"/repos/{owner}/{repo}/issues/{int(number)}", token)
    if not isinstance(data, dict):
        raise IntegrationError("Respuesta inesperada de GitHub.")
    return _issue_view(data)


def create_github_issue(owner: str, repo: str, token: str,
                        title: str, body: str = "") -> dict:
    """Crea un issue (requiere token con permiso sobre el repo)."""
    if not token:
        raise IntegrationError("Crear issues en GitHub requiere un token (PAT) en la conexión.")
    if not title.strip():
        raise IntegrationError("El issue necesita un título.")
    data = _github(
        "POST", f"/repos/{owner}/{repo}/issues", token,
        {"title": title.strip(), "body": body or ""},
    )
    if not isinstance(data, dict):
        raise IntegrationError("GitHub no devolvió el issue creado.")
    return _issue_view(data)


# ── Google Drive / Docs / Sheets / Slides ────────────────────────────────────

# Cada patrón captura el id del recurso; el segundo grupo (si existe) es el tipo
# de documento de Google (document/spreadsheets/presentation) para la vista previa.
_DRIVE_FILE_RE = re.compile(r"drive\.google\.com/file/d/([\w-]+)", re.I)
_DRIVE_FOLDER_RE = re.compile(r"drive\.google\.com/drive/(?:u/\d+/)?folders/([\w-]+)", re.I)
_DRIVE_OPEN_RE = re.compile(r"drive\.google\.com/open\?id=([\w-]+)", re.I)
_GOOGLE_DOC_RE = re.compile(r"docs\.google\.com/(document|spreadsheets|presentation)/d/([\w-]+)", re.I)


def parse_drive(url: str | None) -> dict:
    """Deconstruye un enlace de Google Drive/Docs en algo mostrable.

    Devuelve {kind, id, open_url, embeddable, embed_url}. `embeddable` indica si
    se puede incrustar una vista previa en un iframe (archivos y documentos sí;
    las carpetas no)."""
    url = (url or "").strip()
    info = {"kind": "link", "id": "", "open_url": url, "embeddable": False, "embed_url": ""}
    if not url:
        return info

    m = _GOOGLE_DOC_RE.search(url)
    if m:
        kind, fid = m.group(1), m.group(2)
        info.update(kind=kind, id=fid, embeddable=True,
                    embed_url=f"https://docs.google.com/{kind}/d/{fid}/preview")
        return info

    m = _DRIVE_FILE_RE.search(url) or _DRIVE_OPEN_RE.search(url)
    if m:
        fid = m.group(1)
        info.update(kind="file", id=fid, embeddable=True,
                    embed_url=f"https://drive.google.com/file/d/{fid}/preview")
        return info

    m = _DRIVE_FOLDER_RE.search(url)
    if m:
        info.update(kind="folder", id=m.group(1))
        return info

    return info


# ── serialización segura hacia el cliente ────────────────────────────────────

def public_view(row: dict) -> dict:
    """Fila de `integrations` lista para el frontend: sin el secreto, con el
    `config` ya parseado y un flag `has_token` en su lugar."""
    try:
        config = json.loads(row.get("config") or "{}")
    except (ValueError, TypeError):
        config = {}
    out = {
        "id": row["id"],
        "provider": row["provider"],
        "name": row["name"],
        "url": row.get("url") or "",
        "config": config,
        "has_token": bool((row.get("secret") or "").strip()),
        "created_at": row.get("created_at"),
        "author": row.get("author"),
    }
    if row["provider"] == "google_drive":
        out["drive"] = parse_drive(row.get("url"))
    return out
