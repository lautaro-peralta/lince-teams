"""Smoke tests de Lince Teams (sin dependencias de test, sin DB externa).

Ejecutar con:  python tests/smoke.py

Mismo enfoque que `api/test/smoke.mjs` en el repo del panel: un script suelto
que arranca la app contra una SQLite temporal y verifica lo que se puede
verificar sin desplegar. Nada de faster-whisper acá: el modelo se carga de
forma perezosa (`get_transcriber`), así que la app importa sin él.

Cubre:
  1. Auth: rutas protegidas responden 401 sin token; los tokens de API
     resuelven; un perfil dado de baja pierde el acceso (modo unificado).
  2. WebSocket: auth por primer mensaje, compatibilidad con ?token= y
     rechazo (4401) de un token inválido.
  3. Rutas: health, config público, CRUD de tareas y validaciones.
"""

import os
import sys
import tempfile
from pathlib import Path

# La base y los uploads van a un temporal ANTES de importar server.db, que fija
# sus rutas al importarse.
_TMP = tempfile.mkdtemp(prefix="lince-smoke-")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.pop("DATABASE_URL", None)  # forzamos SQLite aunque el entorno traiga PG

from server import db  # noqa: E402

db.DB_PATH = Path(_TMP) / "lince.db"
db.UPLOADS_DIR = Path(_TMP) / "uploads"

from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from server import auth, main  # noqa: E402

passed = failed = 0


def check(name: str, ok: bool) -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ {name}")


client = TestClient(main.app)

# Cuenta activa de referencia + su token de API.
USER_ID = db.execute(
    """INSERT INTO users(username, display_name, salt, password_hash, role, status)
       VALUES(?,?,?,?,?,?)""",
    ("smoke", "Smoke", "s", "h", "admin", "active"),
    returning_id=True,
)
TOKEN, _ = auth.create_api_token(USER_ID, "smoke")
AUTH = {"Authorization": f"Bearer {TOKEN}"}


print("\nauth")
for method, path in [
    ("GET", "/api/me"),
    ("GET", "/api/tasks"),
    ("POST", "/api/tasks"),
    ("GET", "/api/board"),
    ("GET", "/api/dashboard"),
    ("GET", "/api/transcripts"),
    ("GET", "/api/integrations"),
    ("GET", "/api/tokens"),
    ("GET", "/api/admin/members"),
]:
    r = client.request(method, path, json={})
    check(f"{method} {path} => {r.status_code} (esperado 401)", r.status_code == 401)

check("token de API inválido => 401", client.get("/api/me", headers={"Authorization": "Bearer lince_nope"}).status_code == 401)
check("token de API válido => 200", client.get("/api/me", headers=AUTH).status_code == 200)

# Modo unificado: el rol se re-chequea contra `profiles` en CADA uso del token,
# así que un socio dado de baja en el panel pierde el acceso al instante.
_real_profile_for, _real_mode = auth._profile_for, auth.SUPABASE_MODE
db.execute("UPDATE users SET auth_id = ? WHERE id = ?", ("uuid-smoke", USER_ID))
auth.SUPABASE_MODE = True
try:
    auth._profile_for = lambda _a: {"full_name": "Smoke", "role": "socio"}
    check("perfil vigente => token sigue sirviendo", auth.user_for_api_token(TOKEN) is not None)
    auth._profile_for = lambda _a: {"full_name": "Smoke", "role": "viewer"}
    check("perfil dado de baja => token revocado", auth.user_for_api_token(TOKEN) is None)
    auth._profile_for = lambda _a: None
    check("perfil inexistente => token revocado", auth.user_for_api_token(TOKEN) is None)
finally:
    auth._profile_for, auth.SUPABASE_MODE = _real_profile_for, _real_mode
    db.execute("UPDATE users SET auth_id = NULL, role = 'admin' WHERE id = ?", (USER_ID,))


print("\nwebsocket")
# El token va como PRIMER MENSAJE: en la query string quedaría en los access
# logs de nginx/Cloudflare.
try:
    with client.websocket_connect("/ws") as ws:
        ws.send_text(TOKEN)
        ws.send_text("ping")
    check("auth por primer mensaje", True)
except Exception as e:  # noqa: BLE001
    check(f"auth por primer mensaje ({e})", False)

try:
    with client.websocket_connect(f"/ws?token={TOKEN}") as ws:
        ws.send_text("ping")
    check("?token= sigue aceptado (compatibilidad)", True)
except Exception as e:  # noqa: BLE001
    check(f"?token= sigue aceptado ({e})", False)

try:
    with client.websocket_connect("/ws") as ws:
        ws.send_text("lince_invalido")
        ws.receive_text()
    check("token inválido => cierre 4401", False)
except WebSocketDisconnect as e:
    check("token inválido => cierre 4401", e.code == 4401)


print("\nrutas")
r = client.get("/api/health")
check("GET /api/health => 200", r.status_code == 200 and r.json()["ok"] is True)
check("modelo NO cargado al arrancar (carga perezosa)", r.json()["model_loaded"] is False)

r = client.get("/api/config")
check("GET /api/config => 200 sin auth", r.status_code == 200)
check("standalone => supabase: false", r.json()["supabase"] is False)

r = client.get("/config.js")
check("GET /config.js => javascript sin cachear",
      r.status_code == 200 and "no-cache" in r.headers.get("cache-control", ""))

r = client.post("/api/tasks", headers=AUTH, json={"title": "  "})
check("tarea sin título => 400", r.status_code == 400)
r = client.post("/api/tasks", headers=AUTH, json={"title": "T", "status": "inventado"})
check("estado inválido => 400", r.status_code == 400)
r = client.post("/api/tasks", headers=AUTH, json={"title": "T", "priority": "urgentísima"})
check("prioridad inválida => 400", r.status_code == 400)

r = client.post("/api/tasks", headers=AUTH, json={"title": "Tarea de prueba"})
check("crear tarea => 200", r.status_code == 200)
task_id = r.json().get("id")
r = client.patch(f"/api/tasks/{task_id}", headers=AUTH, json={"status": "done"})
check("mover tarea a done => 200", r.status_code == 200 and r.json()["status"] == "done")
check("PATCH de tarea inexistente => 404",
      client.patch("/api/tasks/999999", headers=AUTH, json={"status": "todo"}).status_code == 404)
check("DELETE de tarea => 200", client.delete(f"/api/tasks/{task_id}", headers=AUTH).status_code == 200)

check("adjunto sin enlace => 400",
      client.post("/api/tasks/1/links", headers=AUTH, json={}).status_code in (400, 404))
check("integración con proveedor no soportado => 400",
      client.post("/api/integrations", headers=AUTH, json={"provider": "dropbox"}).status_code == 400)

r = client.get("/api/dashboard", headers=AUTH)
check("GET /api/dashboard => 200 con las claves esperadas",
      r.status_code == 200 and {"counts", "per_user", "mine", "activity"} <= set(r.json()))


print(f"\n{passed} OK, {failed} fallidos")
sys.exit(1 if failed else 0)
