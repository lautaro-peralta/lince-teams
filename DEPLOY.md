# Despliegue: Supabase + Render + Vercel

Arquitectura: **Vercel** sirve el frontend estático (`server/static/`),
**Render** ejecuta el backend FastAPI (Docker) con el modelo Whisper, y
**Supabase** aporta el Postgres donde viven usuarios, tareas y transcripciones.

> Nota de privacidad: con este stack los datos y el audio pasan por esas tres
> nubes (bajo tus cuentas). Para mantenerlo 100% en tu infraestructura, usa
> `docker compose up -d` en un servidor propio — el código es el mismo.

## 1. Supabase (base de datos)

1. Crea un proyecto en [supabase.com](https://supabase.com) (plan free sirve).
2. En **Project Settings → Database → Connection string**, copia la URI del
   **Session pooler** (IPv4), algo como:
   `postgresql://postgres.xxxx:TU_PASSWORD@aws-0-us-east-1.pooler.supabase.com:5432/postgres`
3. No hace falta crear tablas: el backend ejecuta su esquema al arrancar.

## 2. Render (backend + Whisper)

1. En [render.com](https://render.com): **New → Blueprint**, conecta el repo
   `whisper-flow` — detecta `render.yaml` automáticamente.
   (O **New → Web Service** con runtime Docker, mismo resultado.)
2. Variables de entorno:
   - `DATABASE_URL` → la URI de Supabase del paso 1.
   - `WF_CORS_ORIGINS` → la URL de Vercel del paso 3 (puedes añadirla después).
   - `WF_MODEL` → `small` con 2 GB de RAM; `base` si usas la instancia free
     de 512 MB (el modelo `small` no cabe).
3. El primer arranque tarda unos minutos (descarga el modelo). Comprueba
   `https://<tu-servicio>.onrender.com/api/health`.

## 3. Vercel (frontend)

1. En [vercel.com](https://vercel.com): **Add New → Project**, importa el repo.
   `vercel.json` ya indica que se sirva `server/static/` sin build.
2. Edita `server/static/config.js` y apunta al backend:
   ```js
   window.WF_API_BASE = "https://<tu-servicio>.onrender.com";
   ```
   Commit + push: Vercel redespliega solo.
3. Vuelve a Render y pon `WF_CORS_ORIGINS=https://<tu-proyecto>.vercel.app`.

Listo: comparte la URL de Vercel con tu equipo. Micrófono funciona porque
ambas plataformas sirven HTTPS.

## Alternativa todo-en-uno (sin Vercel)

El backend ya sirve el frontend él solo. Si prefieres una sola pieza:
despliega solo Render (con o sin Supabase) y comparte la URL de Render.
`config.js` con `WF_API_BASE = ""` funciona sin tocar nada.

## Desarrollo local

`run_server.bat` → http://localhost:8000 (SQLite, sin variables de entorno).
Con `DATABASE_URL` definida localmente, usa Supabase también en local.
