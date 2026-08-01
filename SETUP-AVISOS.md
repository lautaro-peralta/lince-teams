# Avisos por correo al asignar una tarea — paso a paso

Cuando alguien **crea una tarea ya asignada** o **reasigna** una existente, Lince Teams
manda un aviso por correo al asignado.

Teams **no envía los mails**: hace un `POST` con un JSON a un webhook de **n8n**, y el
workflow arma y manda el correo. Así no hay credenciales SMTP en el servidor y el envío se
apoya en la automatización que ya usás.

> Sin la variable `LINCE_N8N_TASK_WEBHOOK` configurada, la función queda **apagada** y
> todo lo demás sigue funcionando igual. No hay nada que desinstalar.

Todo lo que tenés que hacer vos está en los 5 pasos de abajo. Toma unos 10 minutos.

---

## Paso 1 — Crear el workflow en n8n

1. Entrá a tu n8n → **Workflows** → botón **⋯** (arriba a la derecha) → **Import from
   File**.
2. Elegí el archivo [`n8n/lince-teams-tarea-asignada.json`](n8n/lince-teams-tarea-asignada.json)
   de este repositorio.
3. Te quedan 4 nodos: **Webhook → ¿Tiene email? → Enviar correo → Respuesta**.

## Paso 2 — Conectar la credencial de correo

1. Abrí el nodo **Enviar correo** (Gmail).
2. En **Credential to connect with**, elegí tu credencial de Gmail o creá una nueva
   (*Sign in with Google*).
3. Si preferís SMTP en vez de Gmail: borrá ese nodo, agregá un **Send Email**, conectalo
   igual y completá los campos con las mismas expresiones:

   | Campo | Valor |
   |---|---|
   | To | `{{ $json.body.to.email }}` |
   | Subject | `{{ $json.body.subject }}` |
   | HTML | `{{ $json.body.body_html }}` |
   | Text (opcional) | `{{ $json.body.body_text }}` |

4. **Guardá** el workflow y activalo con el interruptor **Active** de arriba a la derecha.

## Paso 3 — Copiar la URL del webhook

1. Abrí el nodo **Webhook**.
2. Copiá la **Production URL** (la que termina en `/webhook/lince-teams/tarea-asignada`).
   Ojo: *no* la de Test, que solo vale mientras tenés el editor abierto escuchando.

## Paso 4 — Configurar Lince Teams

Poné estas variables donde corra tu servidor y **reiniciá**:

```bash
LINCE_N8N_TASK_WEBHOOK=https://TU-N8N/webhook/lince-teams/tarea-asignada
LINCE_APP_URL=https://lince-automate.com.ar/teams   # para el enlace dentro del correo
LINCE_N8N_WEBHOOK_SECRET=una-clave-larga-al-azar    # opcional, ver abajo
```

Dónde ponerlas, según tu despliegue:

| Despliegue | Dónde | Cómo reiniciar |
|---|---|---|
| Local / Docker Compose | archivo `.env` (copiá de `.env.example`) | `docker compose up -d --build` |
| Oracle / systemd | `/etc/lince-teams/teams.env` | `sudo systemctl restart lince-teams` |
| Render | *Environment* del servicio | redeploy automático |

**Sobre `LINCE_N8N_WEBHOOK_SECRET` (opcional pero recomendado):** si la definís, Teams
manda su valor en el header `X-Lince-Token`. Para que n8n lo verifique, en el nodo
**Webhook** activá *Authentication → Header Auth* y creá una credencial con nombre
`X-Lince-Token` y ese mismo valor. Sin esto, cualquiera que adivine la URL puede disparar
correos.

## Paso 5 — Cargar los emails del equipo

Los avisos van al email de cada miembro, que ahora se guarda en Teams.

1. Entrá como admin → pestaña **Equipo**.
2. Cada miembro tiene una columna **Email para avisos**: escribí la dirección y salí del
   campo (se guarda solo).
3. Los que quedan vacíos muestran *"sin email · no recibe avisos"* y simplemente no
   reciben nada.

**En modo unificado (Supabase) la mayoría ya viene cargada sola**, porque Teams toma el
email de la cuenta de Supabase al iniciar sesión y al sincronizar los socios. Solo vas a
tener que completar a mano los casos raros (perfiles que nunca entraron y cuyo email no es
legible desde la base).

---

## Probar que funciona

1. **Prueba directa:** pestaña **Equipo** → botón **Probar avisos por correo**. Manda un
   correo de prueba a tu propia dirección y te muestra el error exacto si algo falla.
2. **Prueba real:** creá una tarea y asignásela a otra persona. Le tiene que llegar el
   correo en unos segundos.

## Si no llega el correo

| Síntoma | Causa probable | Solución |
|---|---|---|
| "Falta LINCE_N8N_TASK_WEBHOOK en el entorno." | La variable no está o no reiniciaste | Paso 4 |
| "Tu cuenta no tiene un email cargado" | Tu propio usuario no tiene email | Paso 5 |
| "No se pudo contactar al webhook" | URL mal copiada, o el workflow no está **Active** | Pasos 1-3 |
| El webhook responde 403 | El secreto no coincide | Revisá `X-Lince-Token` en ambos lados |
| Llega la prueba pero no los avisos reales | El asignado no tiene email cargado | Paso 5 |
| Te asignás a vos mismo y no llega nada | Es a propósito: no te avisás a vos | — |
| Editás el título de una tarea asignada y no llega nada | Es a propósito: solo avisa al **cambiar** el asignado | — |

Los errores de envío quedan en el log del servidor con el prefijo `[notify]`
(`journalctl -u lince-teams -f` en Oracle, `docker compose logs -f` en Docker). Un aviso
que falla nunca rompe la creación de la tarea.

---

## Apéndice — el JSON que recibe n8n

Llega en `body`. Trae `subject`, `body_text` y `body_html` **ya armados**, así el workflow
no necesita lógica propia:

```json
{
  "event": "task.assigned",
  "sent_at": "2026-08-01T12:00:00+00:00",
  "to":    { "user_id": 4, "name": "Ana", "email": "ana@ejemplo.com" },
  "actor": { "user_id": 1, "name": "Lautaro" },
  "task":  {
    "id": 12,
    "title": "Preparar la propuesta",
    "description": "…",
    "status": "todo",
    "priority": "high",
    "due_date": "2026-08-05",
    "url": "https://…/#board"
  },
  "subject": "Lautaro te asignó «Preparar la propuesta»",
  "body_text": "…",
  "body_html": "<div>…</div>"
}
```

Valores de `event`:

- `task.created` — la tarea nació ya asignada.
- `task.assigned` — se reasignó una tarea que ya existía.
- `task.test` — el botón *Probar avisos por correo*.

Si querés distinguirlos (por ejemplo, mandar el de prueba a otro lado), agregá un nodo
**Switch** sobre `{{ $json.body.event }}`.
