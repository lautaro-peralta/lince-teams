# Lince

Suite privada de voz y trabajo en equipo, autoalojada. Dos piezas que comparten
el mismo motor de transcripción local
([faster-whisper](https://github.com/SYSTRAN/faster-whisper)):

1. **Lince Dictado** (`lince/`) — dictado de escritorio: mantén una tecla,
   habla, suelta, y el texto aparece donde esté tu cursor. 100% en tu máquina.
2. **Lince Teams** (`server/`) — espacio de trabajo web para tu equipo:
   panel con gráficos, tablero kanban, pizarra colaborativa en tiempo real y
   transcripciones compartidas que se procesan **en vuestro propio servidor**.
   Sin cuentas de terceros, sin telemetría.

La interfaz sigue el [Lince Design System](DESIGN_SYSTEM.md): Fraunces +
Source Sans 3 + JetBrains Mono, paleta tierra sobre blanco roto.

## Lince Dictado (escritorio)

```
install.bat
run.bat --check   # verifica micrófono, modelo y portapapeles
run.bat           # mantén F9 para dictar; F10 alterna manos libres
```

La primera ejecución descarga el modelo Whisper (~460 MB para `small`) y lo
cachea; es el único acceso a red que hará. Configuración en `config.json`
(idioma, modelo, hotkeys, diccionario personal, muletillas extra).

## Lince Teams (web)

```
install.bat
run_server.bat    # http://localhost:8000
```

- **Panel** — tareas por estado (gráfico de dona), completadas por día,
  carga por miembro, tus pendientes y actividad en vivo.
- **Tablero** — kanban con arrastrar y soltar; prioridades, fechas límite y
  **asignación de tareas a cualquier miembro**.
- **Pizarra** — lienzo compartido en tiempo real: notas adhesivas, dibujo a
  mano alzada e imágenes. Todos los conectados ven los cambios al instante.
- **Transcripciones** — graba desde el navegador; el audio se transcribe con
  el modelo local del servidor y queda compartido con el equipo.
- **Equipo** (admins) — control de acceso: cada registro nuevo queda
  **pendiente hasta que un administrador lo apruebe**; roles admin/miembro,
  revocación de acceso y eliminación de cuentas.

El primer usuario registrado se convierte en administrador automáticamente.

> **Login unificado con Lince Automate (opcional).** Si ya usás el panel de
> Lince (sobre Supabase), Teams puede **compartir ese mismo login** en vez de
> tener cuentas propias: el navegador usa el JWT de Supabase y los miembros son
> los `profiles` con rol `admin`/`socio`. Se activa con `SUPABASE_URL` +
> `SUPABASE_ANON_KEY` en el entorno (el registro/aprobación propios se
> desactivan y la pestaña Equipo se oculta). Transcripciones y tiempo real
> siguen igual. Guía en [DEPLOY.md](DEPLOY.md#modo-unificado-un-solo-login-con-lince-automate).

### API de transcripción (n8n, scripts)

Cada miembro aprobado puede crear **tokens de API** (`lince_…`) desde la vista
Transcripciones. Solo se almacena su hash; revocables en un clic.

```
POST /api/transcribe
Authorization: Bearer lince_xxxxxxxxxxxx
Content-Type: multipart/form-data  →  campo "audio" = archivo de audio

→ { "text": "…", "language": "es", "duration": 12.4 }
```

En n8n: nodo **HTTP Request** → Method `POST` → Body `Form-Data` con campo
binario `audio` → Header `Authorization: Bearer <token>`. Nadie fuera del
equipo aprobado puede usar el servicio.

## Despliegue

- **Red local:** `run_server.bat` y comparte `http://<tu-ip>:8000` (o Tailscale
  para acceso remoto seguro).
- **Docker:** `docker compose up -d --build` en cualquier VPS.
- **Nube (Supabase + Render + Vercel):** guía paso a paso en [DEPLOY.md](DEPLOY.md).
  Con `DATABASE_URL` el backend pasa de SQLite a Postgres automáticamente.

## Privacidad

- El audio se procesa en tu máquina (Dictado) o en tu servidor (Teams) y se
  descarta; solo se guarda el texto.
- El único acceso a red del motor es la descarga única del modelo
  (`HF_HUB_OFFLINE=1` la bloquea después).
- El servicio de transcripción requiere cuenta aprobada por un admin: sin
  aprobación no hay sesión ni token válido.
