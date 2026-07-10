# Levantar Lince Teams en Oracle Cloud — Always Free

Guía para correr el backend de **Lince Teams** (FastAPI + Whisper) en una VM del
tier gratuito de Oracle Cloud, detrás de nginx con HTTPS y **WebSocket** (el
tiempo real de la pizarra). La VM **no se duerme**: sin cold starts y el modelo
queda caliente en RAM.

> Reemplazá `teams-origin.TU-DOMINIO.com` por tu subdominio real en todos los pasos.

Este servicio se sirve luego en `TU-DOMINIO.com/teams` mediante el reverse-proxy
de Cloudflare del repo de Lince Automate (`deploy/teams-proxy/`), para compartir
el login del panel **sin doble inicio de sesión**. Este `teams-origin.…` es solo
el "origen" al que ese proxy apunta.

---

## 1. Crear la instancia (Always Free)

1. Oracle Cloud Console → **Compute → Instances → Create instance**.
2. **Image & shape:**
   - Image: **Canonical Ubuntu 22.04**.
   - Shape: **VM.Standard.A1.Flex** (ARM, Always Free hasta 4 OCPU / 24 GB).
     Elegí **2 OCPU / 12 GB** — Whisper agradece la RAM. *Si da "out of
     capacity", probá otra Availability Domain.* El AMD `E2.1.Micro` (1 GB) **no
     alcanza** para el modelo `small`; ahí solo entraría `tiny`/`base`.
3. **SSH keys:** subí tu clave pública.
4. **Create.** Anotá la **Public IP**.

## 2. Abrir puertos en la red (Security List)

**Networking → Virtual Cloud Networks →** tu VCN **→ Security Lists →** Default →
**Add Ingress Rules** (Source `0.0.0.0/0`, TCP):

- Puerto **80** y puerto **443**.

## 3. Entrar por SSH y abrir el firewall del SO

```bash
ssh ubuntu@<PUBLIC_IP>
```

La imagen de Ubuntu en Oracle bloquea todo menos SSH con iptables; abrí 80/443:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 4. Instalar dependencias del sistema

```bash
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip git ffmpeg
```

> `ffmpeg` cubre la decodificación de audio para la transcripción. Python 3.10
> (el de Ubuntu 22.04) alcanza; no hace falta 3.11.

## 5. Traer el código

El repo es privado: cloná con un **token de GitHub** (Settings → Developer
settings → Personal access tokens, permiso `repo`) o una deploy key.

```bash
sudo mkdir -p /opt/lince-teams && sudo chown -R ubuntu:ubuntu /opt/lince-teams
git clone https://github.com/lautaro-peralta/lince-teams.git /opt/lince-teams
cd /opt/lince-teams
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements-server.txt
```

## 6. Variables de entorno

```bash
sudo mkdir -p /etc/lince-teams
sudo cp /opt/lince-teams/.env.example /etc/lince-teams/teams.env
sudo nano /etc/lince-teams/teams.env
```

Completá (ver comentarios en el archivo):

- `DATABASE_URL` → el **Session pooler** de tu Supabase (mismo proyecto que Lince
  Automate, para compartir `public.profiles`).
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` → activan el **modo unificado** (login del
  panel). `LINCE_LOGIN_URL=/admin`.
- `LINCE_MODEL=small` (o `medium` con A1) y `LINCE_COMPUTE_TYPE=int8`.

## 7. Correr como servicio (systemd)

```bash
sudo cp /opt/lince-teams/deploy/lince-teams.service /etc/systemd/system/lince-teams.service
sudo systemctl daemon-reload
sudo systemctl enable --now lince-teams
sudo systemctl status lince-teams        # active (running)
curl -s http://127.0.0.1:8000/api/health # {"ok":true,"model_loaded":false}
curl -s http://127.0.0.1:8000/api/config # {"supabase":true,...}
```

> La primera transcripción descarga el modelo y tarda; después queda en RAM.
> **Un solo worker** a propósito (el hub del WebSocket y el modelo viven en el
> proceso): no agregues `--workers`.

### Alternativa: Docker

Si preferís no instalar Python a mano, el repo trae `Dockerfile` +
`docker-compose.yml`. Instalá Docker y:

```bash
# pasá las variables por un archivo .env junto al compose (o env_file:)
docker compose up -d --build
```

Recordá montar `hf-cache` (ya está en el compose) para no re-descargar el modelo.

## 8. HTTPS con nginx + Let's Encrypt (con WebSocket)

En tu DNS creá un registro **A**: `teams-origin.TU-DOMINIO.com → <PUBLIC_IP>`,
en **DNS only** (nube gris) para que el Worker lo alcance directo y para emitir
el certificado.

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx

sudo cp /opt/lince-teams/deploy/nginx-lince-teams.conf /etc/nginx/sites-available/lince-teams
sudo nano /etc/nginx/sites-available/lince-teams     # poné tu teams-origin.TU-DOMINIO.com
sudo ln -s /etc/nginx/sites-available/lince-teams /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d teams-origin.TU-DOMINIO.com
```

El `nginx-lince-teams.conf` ya trae el `map $http_upgrade` y los headers
`Upgrade`/`Connection` para que el WebSocket `/ws` funcione, más
`client_max_body_size 25m` para audio e imágenes.

Probá: `https://teams-origin.TU-DOMINIO.com/api/health`.

## 9. Enganchar el proxy same-origin (/teams)

En el repo de **Lince Automate**, en `deploy/teams-proxy/`:

1. `wrangler.jsonc` → `TEAMS_ORIGIN=https://teams-origin.TU-DOMINIO.com`.
2. En `server/static/config.js` de este repo, dejá `window.LINCE_API_BASE = "/teams"`
   y volvé a desplegar (systemd: `git pull` + `systemctl restart`; el archivo es
   estático).
3. `wrangler deploy` desde `deploy/teams-proxy/`.

Verificación final: entrá al panel `TU-DOMINIO.com/admin`, luego abrí
`TU-DOMINIO.com/teams` → debería entrar **sin** volver a loguear. La pizarra debe
sincronizar en vivo (WebSocket) y la transcripción grabar/subir audio.

## Actualizar más adelante

```bash
cd /opt/lince-teams && git pull
.venv/bin/pip install -r requirements-server.txt   # si cambiaron deps
sudo systemctl restart lince-teams
```

## Solución de problemas

- **Responde con `curl` local pero no desde afuera** → faltan puertos: revisá el
  Security List (paso 2) **y** iptables (paso 3). Son dos firewalls.
- **La pizarra no sincroniza en vivo** → el WebSocket no pasa: confirmá los
  headers `Upgrade`/`Connection` del nginx (paso 8) y, si usás el Worker de
  Cloudflare, que reenvíe `/teams/ws`.
- **`/api/config` devuelve `{"supabase":false}`** → faltan `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` en `/etc/lince-teams/teams.env` (o no reiniciaste el
  servicio tras editarlo).
- **403 "sin acceso a Lince Teams"** → esa cuenta no tiene rol `admin`/`socio` en
  `public.profiles` (se asigna desde el panel / SQL Editor de Supabase).
- **Subir audio/imagen da 413** → subí `client_max_body_size` en el nginx.
- **Out of memory al transcribir** → bajá `LINCE_MODEL` (`base`) o subí la RAM de
  la shape A1.
- **Ver logs** → `journalctl -u lince-teams -f`.
