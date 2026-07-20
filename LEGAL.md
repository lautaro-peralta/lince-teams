# Cuestiones legales — Lince (Dictado y Teams)

Análisis legal de esta suite de voz y trabajo en equipo, pensado para dos
lectores: **quien despliega** Lince Teams para su equipo y **Lince** como
autor/operador del software. El marco de referencia es el derecho argentino;
si desplegás para usuarios de otros países, revisá la normativa local (p. ej.
GDPR en la Unión Europea).

> ⚠️ **Esto no es asesoramiento legal.** Es documentación de trabajo; para
> decisiones con consecuencias (contratos, despliegues con datos sensibles,
> publicación con otra licencia) consultá a un abogado. Las cuestiones
> legales del emprendimiento en su conjunto (impuestos, contratos con
> clientes, marca) están en el repo principal:
> [`lince-automatizations/docs/LEGAL.md`](https://github.com/lautaro-peralta/lince-automatizations/blob/main/docs/LEGAL.md).

## 1. Quién es responsable de los datos

Lince Teams es **autoalojado**: el audio y las transcripciones se procesan y
guardan en el servidor de quien lo despliega, sin telemetría hacia Lince.
Consecuencia jurídica directa (Ley 25.326):

| Escenario | Rol de quien despliega | Rol de Lince |
|-----------|------------------------|--------------|
| Un equipo instala Teams en su propio servidor | **Responsable del tratamiento** de los datos de sus miembros y transcripciones | Proveedor de software, sin acceso a los datos |
| Lince opera Teams para un cliente (hosting administrado) | Responsable | **Encargado de tratamiento** → firmar el [anexo de datos](https://github.com/lautaro-peralta/lince-automatizations/blob/main/docs/legal/ANEXO-DATOS.md) |
| Lince Dictado (escritorio) | El propio usuario: todo ocurre en su máquina | Proveedor de software |

Quien despliega debe, como responsable: informar a su equipo qué se guarda y
para qué, atender pedidos de acceso/rectificación/supresión (arts. 14-16),
proteger el servidor (art. 9) y, en Argentina, considerar la inscripción de
la base ante la AAIP (art. 21) si el uso excede lo puramente doméstico.

## 2. Grabación y transcripción de voz

Es el punto más delicado de la suite. Reglas prácticas para Argentina:

- **Grabar una conversación en la que participás** no es delito (el art. 153
  del Código Penal castiga interceptar comunicaciones **ajenas**). Ahora
  bien, **difundir** una conversación privada o usar la grabación fuera de
  contexto puede generar responsabilidad civil (arts. 52, 1770 CCyC —
  protección de la intimidad) e incluso penal según el caso.
- **Grabar a terceros que no participan** (dejar el micrófono abierto en una
  reunión ajena, interceptar llamadas) es ilícito. No usar la suite para eso.
- **Buena práctica obligatoria en equipos:** avisar **antes** de grabar y
  obtener conformidad de todos los participantes de una reunión. La interfaz
  de Transcripciones la inicia una persona presente, pero el aviso al resto
  es responsabilidad de quien graba. Sugerencia operativa: incluir en el
  reglamento interno del equipo una regla del estilo *"toda grabación se
  anuncia al inicio de la reunión; quien no esté de acuerdo puede pedir que
  no se grabe"*.
- **La voz y lo dicho son datos personales.** La transcripción resultante
  (texto) identifica personas y puede contener datos de terceros o incluso
  datos sensibles si alguien los menciona (salud, opiniones políticas —
  art. 2 y 7, Ley 25.326). Tratar las transcripciones con el mismo cuidado
  que cualquier documento interno confidencial y depurarlas periódicamente.
- **Mitigación ya incorporada en el diseño:** el audio se procesa localmente
  y **se descarta**; sólo persiste el texto. No se construyen perfiles de voz
  ni identificación biométrica de hablantes.

## 3. Cuentas, aprobación y tokens de API

- El acceso requiere **aprobación de un administrador** (o el padrón de
  `profiles` en modo unificado): no hay tratamiento de datos de extraños.
- Los administradores pueden **revocar acceso y eliminar cuentas**; al
  eliminar una cuenta conviene también depurar sus datos asociados si el
  titular lo pide (derecho de supresión, art. 16).
- Los **tokens de API** (`lince_…`) se guardan sólo hasheados ✔. Cada
  miembro es responsable del uso de sus tokens; el flujo de n8n u otros
  scripts que los usen queda bajo la responsabilidad del equipo que los creó.
- En **modo unificado** (login por Supabase), el JWT se valida contra el
  proyecto de Supabase del equipo: aplican además las condiciones y el DPA de
  Supabase, y la transferencia internacional se cubre como se describe en el
  repo principal.

## 4. Adjuntos e integraciones (Drive, GitHub)

Las conexiones a Google Drive y GitHub se configuran con credenciales del
propio equipo y por las **APIs oficiales**. Cada integración implica aceptar
los términos del proveedor (Google API Services User Data Policy, GitHub
Terms); usar los permisos mínimos necesarios (scopes de sólo lectura cuando
alcance) y revocar credenciales al desvincular la herramienta.

## 5. Licencias de software

**Dependencias principales** (todas permiten uso comercial):

| Componente | Licencia | Obligación práctica |
|------------|----------|---------------------|
| faster-whisper (SYSTRAN) | MIT | Conservar aviso de copyright |
| Modelos Whisper (OpenAI) | MIT | Ídem |
| FastAPI / Starlette / Uvicorn | MIT / BSD | Ídem |
| CTranslate2 | MIT | Ídem |

Ninguna dependencia copyleft (GPL/AGPL) forma parte del runtime, así que
distribuir o vender la suite no obliga a liberar el código.

**Licencia de este repo:** hoy **no hay archivo `LICENSE`**, de modo que el
código queda "todos los derechos reservados" (Ley 11.723): quien lo
encuentre en GitHub puede leerlo pero **no tiene derecho a usarlo, copiarlo
ni desplegarlo** sin permiso. Decisión pendiente y consciente:

- Mantenerlo propietario (agregar un `LICENSE` que lo diga expresamente y
  bajo qué condiciones se entrega a clientes), o
- abrirlo con una licencia real (MIT si se busca adopción; AGPL-3.0 si se
  quiere impedir que terceros lo ofrezcan como servicio cerrado).

Hasta decidirlo, no aceptar contribuciones externas de código (un PR de un
tercero sin acuerdo de cesión enturbia la titularidad).

## 6. Checklist para un despliegue responsable

- [ ] Definir por escrito la política interna del equipo: qué se graba, quién
      accede, cada cuánto se depuran transcripciones y pizarras.
- [ ] Avisar y obtener conformidad de los participantes antes de grabar
      reuniones (regla anunciada y repetible).
- [ ] Servir siempre detrás de HTTPS (o red privada/Tailscale) y mantener el
      sistema operativo y dependencias actualizados.
- [ ] Backups del volumen de datos y prueba de restauración.
- [ ] Alta/baja de miembros documentada; borrar datos de quien se va si lo
      pide.
- [ ] Si Lince lo opera para un cliente: contrato + anexo de tratamiento de
      datos firmados (repo principal, `docs/legal/`).
- [ ] Si se venden despliegues del software: resolver la licencia del repo
      (punto 5) antes de la primera entrega.
