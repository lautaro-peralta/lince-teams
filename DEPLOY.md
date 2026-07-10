# Despliegue: Supabase + Render + Vercel

Arquitectura: **Vercel** sirve el frontend estático (`server/static/`),
**Render** ejecuta el backend FastAPI (Docker) con el modelo Whisper, y
**Supabase** aporta el Postgres donde viven usuarios, tareas, pizarra y
transcripciones.

> Nota de privacidad: con este stack los datos y el audio pasan por esas tres
> nubes (bajo tus cuentas). Para mantenerlo 100% en tu infraestructura, usa
> `docker compose up -d` en un servidor propio — el código es el mismo.

> **¿Querés unificarlo con Lince Automate (un solo login)?** Lince Teams puede
> compartir el login del panel de Lince en vez de tener cuentas propias. Es un
> modo opcional que se activa por variables de entorno; ver
> [Modo unificado](#modo-unificado-un-solo-login-con-lince-automate) al final.

## 1. Supabase (base de datos)

1. Crea un proyecto en [supabase.com](https://supabase.com) (plan free sirve).
2. En **Project Settings → Database → Connection string**, copia la URI del
   **Session pooler** (IPv4), algo como:
   `postgresql://postgres.xxxx:TU_PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres`
3. No hace falta crear tablas: el backend ejecuta su esquema al arrancar.

## 2. Render (backend + Whisper)

1. En [render.com](https://render.com): **New → Blueprint**, conecta el repo
   `lince` — detecta `render.yaml` automáticamente.
2. Variables de entorno:
   - `DATABASE_URL` → la URI de Supabase del paso 1.
   - `LINCE_CORS_ORIGINS` → la URL de Vercel del paso 3 (puedes añadirla después).
   - `LINCE_MODEL` → `small` con 2 GB de RAM; `base` si usas la instancia free
     de 512 MB (el modelo `small` no cabe).
3. El primer arranque tarda unos minutos (descarga el modelo). Comprueba
   `https://<tu-servicio>.onrender.com/api/health`.
4. **Regístrate tú primero**: la primera cuenta creada es el administrador.

> Las imágenes de la pizarra se guardan en disco del contenedor; en Render
> añade un **Persistent Disk** montado en `/app/data` si quieres que
> sobrevivan a los redeploys (la base de datos ya vive en Supabase).

## 3. Vercel (frontend)

1. En [vercel.com](https://vercel.com): **Add New → Project**, importa el repo.
   `vercel.json` ya indica que se sirva `server/static/` sin build.
2. Edita `server/static/config.js` y apunta al backend:
   ```js
   window.LINCE_API_BASE = "https://<tu-servicio>.onrender.com";
   ```
   Commit + push: Vercel redespliega solo.
3. Vuelve a Render y pon `LINCE_CORS_ORIGINS=https://<tu-proyecto>.vercel.app`.

Listo: comparte la URL de Vercel con tu equipo. Cada compañero crea su cuenta
desde su máquina y **queda en espera hasta que tú lo apruebes** en la vista
Equipo. El micrófono funciona porque ambas plataformas sirven HTTPS.

## Conectar n8n

1. En Lince Teams → **Transcripciones → Acceso por API**, crea un token.
2. En n8n, nodo **HTTP Request**:
   - Method: `POST` — URL: `https://<tu-servicio>.onrender.com/api/transcribe`
   - Authentication: none; añade Header `Authorization` = `Bearer <token>`
   - Body Content Type: `Form-Data`; campo tipo *Binary* llamado `audio`
3. La respuesta trae `text`, `language` y `duration` para usar en el flujo.

Los tokens se revocan desde la misma pantalla; revocar el acceso de un
miembro (vista Equipo) invalida también todos sus tokens.

## Alternativa todo-en-uno (sin Vercel)

El backend ya sirve el frontend él solo: despliega solo Render (con o sin
Supabase) y comparte la URL de Render. `config.js` con `LINCE_API_BASE = ""`
funciona sin tocar nada.

## Desarrollo local

`run_server.bat` → http://localhost:8000 (SQLite, sin variables de entorno).
Con `DATABASE_URL` definida localmente, usa Supabase también en local.

## Modo unificado: un solo login con Lince Automate

Por defecto Lince Teams tiene su propio registro/aprobación de cuentas. Si ya
usás **Lince Automate** (el panel + Startup OS, sobre Supabase), podés hacer que
Teams **comparta ese mismo login** en vez de mantener dos padrones.

### Cómo funciona

- El navegador manda el **JWT de Supabase** (la misma sesión del panel `/admin`).
  El backend lo valida contra Supabase Auth y **espeja** la cuenta en su tabla
  local `users` por `auth_id`, leyendo rol y nombre de `public.profiles`.
- Los **miembros** son los `profiles` con rol `admin` o `socio` (los mismos del
  panel y el Startup OS). No hay registro ni aprobación acá: se gestionan en el
  panel de Lince. La pestaña **Equipo** se oculta.
- Las **transcripciones** y el **tiempo real** (WebSocket) siguen igual: son la
  razón de tener este servicio Python.

### Variables de entorno (en Render)

Además de `DATABASE_URL` (que debe apuntar al **mismo** Postgres de Supabase que
usa Lince Automate, para compartir `profiles`):

| Variable | Valor |
|----------|-------|
| `SUPABASE_URL` | `https://TU-PROYECTO.supabase.co` |
| `SUPABASE_ANON_KEY` | la anon key pública del proyecto |
| `LINCE_LOGIN_URL` | a dónde mandar a iniciar sesión (por defecto `/admin`) |

Con esas dos primeras presentes, el modo unificado se activa solo (lo confirma
`GET /api/config` → `{"supabase": true, …}`). Si faltan, Teams sigue en modo
standalone con su login propio.

### SSO real: servir Teams en el mismo origen

La sesión de Supabase vive en el `localStorage` del navegador, que es **por
origen**. Para que Teams reutilice la sesión del panel **sin volver a loguear**,
servilo en el **mismo dominio** que Lince Automate, bajo una ruta (p. ej.
`https://lince-automate.com/teams`), con un reverse-proxy hacia el servicio de
Render. En Cloudflare (donde ya vive el frontend) alcanza con una regla que
enrute `/teams/*`, `/api/*` de Teams y el `/ws` (upgrade de WebSocket) al
servicio Python.

- Sin sesión, Teams redirige a `LINCE_LOGIN_URL` (`/admin`) con `?next=/teams/`,
  y el panel lo trae de vuelta al iniciar sesión (ese redirect ya está soportado
  en el panel para `/teams`).
- **Alternativa por subdominio** (`teams.lince-automate.com`): funciona con las
  mismas cuentas, pero al ser otro origen el usuario inicia sesión una segunda
  vez en Teams (Supabase reconoce el mismo proyecto). Poné `LINCE_LOGIN_URL` con
  la URL completa del panel si elegís este camino.

### En Supabase

No hace falta esquema nuevo para Teams: sus tablas (`users`, `tasks`,
`board_items`, etc.) las crea el backend al arrancar, y `profiles` ya existe por
Lince Automate. Solo asegurate de que las cuentas del equipo tengan rol `admin`
o `socio` (se hace desde el panel / SQL Editor, igual que para el Startup OS).
