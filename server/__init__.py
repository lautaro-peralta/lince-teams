"""Lince Teams — self-hosted team workspace with local transcription."""

# Carga variables desde un archivo .env si existe (dev local, Docker, bare
# uvicorn), igual que el backend Express hace con dotenv. Se hace ACÁ, en el
# __init__ del paquete, para que corra ANTES de que server.db / server.auth lean
# el entorno. No pisa variables ya definidas por la plataforma (Render, systemd
# EnvironmentFile, docker `environment:`), que siempre ganan. Opcional: si no
# está instalado python-dotenv, simplemente no hace nada.
try:  # pragma: no cover - conveniencia de arranque
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass
