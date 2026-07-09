# Lince — Design System

Sistema de diseño para la plataforma de automatización Lince. Este documento es la fuente de verdad para tokens, componentes y patrones visuales del proyecto.

---

## Índice

1. [Fundamentos](#1-fundamentos)
   - [Paleta de color](#11-paleta-de-color)
   - [Tipografía](#12-tipografía)
   - [Espaciado](#13-espaciado)
   - [Radios y bordes](#14-radios-y-bordes)
   - [Sombras](#15-sombras)
   - [Animaciones y movimiento](#16-animaciones-y-movimiento)
2. [Componentes](#2-componentes)
   - [Botones](#21-botones)
   - [Formularios](#22-formularios)
   - [Tarjetas](#23-tarjetas)
   - [Badges y etiquetas](#24-badges-y-etiquetas)
   - [Tablas](#25-tablas)
   - [Pestañas (Tabs)](#26-pestañas-tabs)
   - [Estados de carga y feedback](#27-estados-de-carga-y-feedback)
3. [Patrones de layout](#3-patrones-de-layout)
4. [Accesibilidad](#4-accesibilidad)
5. [Uso de las variables CSS](#5-uso-de-las-variables-css)

---

## 1. Fundamentos

### 1.1 Paleta de color

Todos los colores se expresan como variables CSS declaradas en `:root`. **Nunca usar valores hex directamente en los componentes**; siempre referenciar la variable.

```css
:root {
  --bg:          #F7F5F0;               /* Fondo principal — blanco roto cálido */
  --ink:         #1B2B23;               /* Verde bosque profundo — texto primario */
  --moss:        #3D5A45;               /* Verde musgo — acentos, bordes activos */
  --rust:        #C9622E;               /* Óxido — interactivos, foco, CTA secundario */
  --card:        #EFEAE0;               /* Beige cálido — fondos de tarjetas */
  --sage:        #6E8579;               /* Salvia — texto secundario, placeholders */
  --line:        rgba(27,43,35,0.12);   /* Borde sutil */
  --line-strong: rgba(27,43,35,0.22);   /* Borde definido */
}
```

#### Usos por rol semántico

| Variable        | Uso principal                                                      |
|-----------------|--------------------------------------------------------------------|
| `--bg`          | `background` de `<body>`, inputs, áreas de contenido              |
| `--ink`         | Texto principal, bordes de botones primarios, fondo CTA primario  |
| `--moss`        | Labels de formulario, estados hover de links, acentos             |
| `--rust`        | Estado focus, botones de acción secundaria, badges de alerta      |
| `--card`        | Fondo de tarjetas, fila de encabezado de tablas                   |
| `--sage`        | Texto secundario / descriptivo, placeholder, breadcrumbs          |
| `--line`        | Bordes de separadores, líneas de tabla                            |
| `--line-strong` | Bordes de inputs, divisores entre secciones                       |

#### Combinaciones aprobadas (contraste WCAG AA)

| Texto       | Fondo    | Relación de contraste | Estado    |
|-------------|----------|-----------------------|-----------|
| `--ink`     | `--bg`   | ~10 : 1               | ✅ AAA    |
| `--ink`     | `--card` | ~9 : 1                | ✅ AAA    |
| `--moss`    | `--bg`   | ~5.5 : 1              | ✅ AA     |
| `--rust`    | `--bg`   | ~4.6 : 1              | ✅ AA     |
| `--sage`    | `--bg`   | ~3.5 : 1              | ⚠️ Solo decorativo / >18px |
| Blanco      | `--ink`  | ~10 : 1               | ✅ AAA    |

---

### 1.2 Tipografía

Tres familias, cada una con un rol específico. Se cargan desde Google Fonts.

```html
<!-- Orden de import: display → body → mono -->
<link href="https://fonts.googleapis.com/css2?
  family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600
  &family=Source+Sans+3:wght@400;500;600
  &family=JetBrains+Mono:wght@400;500
  &display=swap" rel="stylesheet">
```

#### Escala tipográfica

| Token              | Familia          | Tamaño | Peso | Letter-spacing | Uso                          |
|--------------------|------------------|--------|------|----------------|------------------------------|
| `.display`         | Fraunces         | Fluido | 500  | -0.01em        | Hero principal               |
| `h1`               | Fraunces         | 2.6rem | 500  | -0.01em        | Título de sección            |
| `h2`               | Fraunces         | 2rem   | 500  | -0.01em        | Subtítulo de sección         |
| `h3`               | Fraunces         | 1.35rem| 500  | -0.01em        | Título de tarjeta / panel    |
| `body` (landing)   | Source Sans 3    | 17px   | 400  | 0              | Texto corrido landing        |
| `body` (admin)     | Source Sans 3    | 16px   | 400  | 0              | Texto corrido panel          |
| `.label`           | JetBrains Mono   | 11px   | 500  | 0.07em         | Eyebrow, etiquetas de campo  |
| `.meta`            | JetBrains Mono   | 12px   | 400  | 0.05em         | Timestamps, IDs, datos       |
| `th` (tablas)      | JetBrains Mono   | 11px   | 500  | 0.06em         | Encabezados de tabla         |

**Regla:** `Fraunces` solo para encabezados y display. `Source Sans 3` para todo texto narrativo. `JetBrains Mono` para metadatos, etiquetas de UI y valores de datos.

---

### 1.3 Espaciado

Escala basada en múltiplos de 4px.

| Token  | Valor | Uso típico                            |
|--------|-------|---------------------------------------|
| `4px`  | 4px   | Gaps internos mínimos, icon margins   |
| `8px`  | 8px   | Padding interno de badges             |
| `12px` | 12px  | Gap entre label e input               |
| `16px` | 16px  | Padding horizontal de botones pequeños|
| `20px` | 20px  | Padding de tarjeta compacta           |
| `24px` | 24px  | Padding horizontal de botón estándar  |
| `32px` | 32px  | Padding de tarjeta estándar           |
| `36px` | 36px  | Padding de tarjeta amplia             |
| `48px` | 48px  | Margen entre secciones (mobile)       |
| `80px` | 80px  | Margen entre secciones (desktop)      |

**Ancho máximo de contenido:** `1060px`, centrado con `margin-inline: auto`.

---

### 1.4 Radios y bordes

| Token   | Valor | Uso                              |
|---------|-------|----------------------------------|
| `4px`   | 4px   | Badges, chips pequeños           |
| `7px`   | 7px   | Botones                          |
| `8px`   | 8px   | Inputs, textareas                |
| `12px`  | 12px  | Tarjetas estándar                |
| `16px`  | 16px  | Tarjetas hero / destacadas       |
| `50%`   | 50%   | Avatares, íconos circulares      |

**Grosor de borde estándar:** `1px` usando `--line` o `--line-strong`.

---

### 1.5 Sombras

```css
/* Nivel 1 — tarjeta en reposo */
box-shadow: 0 1px 3px rgba(27,43,35,0.07);

/* Nivel 2 — tarjeta o botón en hover */
box-shadow: 0 4px 14px rgba(27,43,35,0.10);

/* Focus ring — estado de foco en interactivos */
box-shadow: 0 0 0 3px rgba(201,98,46,0.22);  /* --rust con 22% opacidad */
```

---

### 1.6 Animaciones y movimiento

#### Curvas de easing

```css
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);   /* Entradas principales */
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1);     /* Transiciones de estado */
```

#### Duraciones

| Uso                         | Duración |
|-----------------------------|----------|
| Micro-interacción (hover)   | 0.15s    |
| Transición de estado        | 0.2s     |
| Entrada de elemento         | 0.8s     |
| Animaciones decorativas     | 2.4s–22s |

#### Scroll reveal (patrón base)

```css
.reveal {
  opacity: 0;
  transform: translateY(22px);
  transition: opacity 0.8s var(--ease-out-expo),
              transform 0.8s var(--ease-out-expo);
}
.reveal.visible {
  opacity: 1;
  transform: translateY(0);
}
```

Los elementos con `.reveal` se activan vía `IntersectionObserver` en `reveal.js`. El delay se incrementa en `0.05s` por elemento en el viewport.

#### Accesibilidad de movimiento

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 2. Componentes

### 2.1 Botones

Dos variantes principales. Siempre usar `<button>` o `<a>` con `role="button"`.

#### Primario (CTA)

```html
<button class="btn-primary">Empezar ahora</button>
```

```css
.btn-primary {
  background: var(--ink);
  color: var(--bg);
  border: 1.5px solid var(--ink);
  border-radius: 7px;
  padding: 13px 24px;
  font-family: 'Source Sans 3', sans-serif;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(27,43,35,0.15);
}

.btn-primary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(201,98,46,0.35);
}

.btn-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}
```

#### Ghost / Secundario

```html
<button class="btn-ghost">Ver más</button>
```

```css
.btn-ghost {
  background: transparent;
  color: var(--ink);
  border: 1.5px solid var(--ink);
  border-radius: 7px;
  padding: 13px 24px;
  font-family: 'Source Sans 3', sans-serif;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, transform 0.15s;
}

.btn-ghost:hover {
  background: rgba(27,43,35,0.05);
  transform: translateY(-1px);
}
```

**Regla de uso:** Un solo botón primario por sección visual. Los secundarios siempre son ghost o enlaces de texto.

---

### 2.2 Formularios

#### Grupo de campo

```html
<div class="field">
  <label for="nombre" class="field-label">Nombre</label>
  <input id="nombre" type="text" class="field-input" placeholder="Tu nombre">
</div>
```

```css
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-family: 'Source Sans 3', sans-serif;
  font-size: 13px;
  font-weight: 600;
  color: var(--moss);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.field-input,
.field-textarea {
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 11px 14px;
  font-family: 'Source Sans 3', sans-serif;
  font-size: 15px;
  width: 100%;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.field-input:focus,
.field-textarea:focus {
  outline: none;
  border-color: var(--rust);
  box-shadow: 0 0 0 3px rgba(201,98,46,0.18);
}

.field-input:invalid:not(:placeholder-shown),
.field-textarea:invalid:not(:placeholder-shown) {
  border-color: #b23b3b;
}
```

#### Mensaje de error

```html
<span class="field-error">Este campo es requerido.</span>
```

```css
.field-error {
  font-size: 12px;
  color: #b23b3b;
  margin-top: 2px;
}
```

---

### 2.3 Tarjetas

#### Tarjeta estándar

```html
<div class="card">
  <h3>Título</h3>
  <p>Contenido de la tarjeta.</p>
</div>
```

```css
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 24px;
}
```

#### Tarjeta destacada (hero / feature)

```css
.card-featured {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 36px;
}
```

#### Tarjeta de panel admin

```css
.panel-card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 20px 24px;
  box-shadow: 0 1px 3px rgba(27,43,35,0.07);
}
```

---

### 2.4 Badges y etiquetas

```html
<!-- Estado positivo -->
<span class="badge badge-moss">Activo</span>

<!-- Estado de alerta -->
<span class="badge badge-rust">Pendiente</span>

<!-- Neutro -->
<span class="badge badge-neutral">Archivado</span>
```

```css
.badge {
  display: inline-block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 4px;
}

.badge-moss {
  background: rgba(61,90,69,0.12);
  color: var(--moss);
}

.badge-rust {
  background: rgba(201,98,46,0.12);
  color: var(--rust);
}

.badge-neutral {
  background: var(--line);
  color: var(--sage);
}
```

---

### 2.5 Tablas

```html
<div class="table-wrap">
  <table class="data-table">
    <thead>
      <tr>
        <th>Nombre</th>
        <th>Estado</th>
        <th>Fecha</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Ejemplo S.A.</td>
        <td><span class="badge badge-moss">Activo</span></td>
        <td class="meta">2026-06-22</td>
      </tr>
    </tbody>
  </table>
</div>
```

```css
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: 12px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.data-table th {
  background: var(--card);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sage);
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--line-strong);
}

.data-table td {
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  color: var(--ink);
  vertical-align: middle;
}

.data-table tbody tr:last-child td {
  border-bottom: none;
}

.data-table tbody tr:hover td {
  background: rgba(27,43,35,0.025);
}

/* Columna de datos (timestamp, ID) */
.meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--sage);
}
```

---

### 2.6 Pestañas (Tabs)

```html
<nav class="tabs" role="tablist">
  <button class="tab active" role="tab" aria-selected="true">Resumen</button>
  <button class="tab" role="tab" aria-selected="false">Leads</button>
  <button class="tab" role="tab" aria-selected="false">Presupuestos</button>
  <button class="tab" role="tab" aria-selected="false">Reseñas</button>
</nav>
```

```css
.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--line-strong);
  padding-bottom: 0;
  margin-bottom: 24px;
}

.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 10px 16px;
  font-family: 'Source Sans 3', sans-serif;
  font-size: 14px;
  font-weight: 500;
  color: var(--sage);
  cursor: pointer;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}

.tab:hover {
  color: var(--ink);
}

.tab.active,
.tab[aria-selected="true"] {
  color: var(--ink);
  border-bottom-color: var(--rust);
  font-weight: 600;
}
```

---

### 2.7 Estados de carga y feedback

#### Indicador de guardado

```html
<span class="save-status save-status--ok">Guardado</span>
<span class="save-status save-status--error">Error al guardar</span>
```

```css
.save-status {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  letter-spacing: 0.04em;
  opacity: 0;
  transition: opacity 0.2s;
}

.save-status.visible {
  opacity: 1;
}

.save-status--ok    { color: var(--moss); }
.save-status--error { color: #b23b3b; }
```

#### Punto de estado activo (live indicator)

```html
<span class="live-dot"></span>
```

```css
.live-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--rust);
  animation: pulse-dot 2.4s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.5; transform: scale(0.8); }
}
```

#### Skeleton / carga (patrón)

```css
.skeleton {
  background: linear-gradient(
    90deg,
    var(--card) 25%,
    rgba(239,234,224,0.7) 50%,
    var(--card) 75%
  );
  background-size: 200% 100%;
  border-radius: 6px;
  animation: shimmer 1.4s ease-in-out infinite;
}

@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

---

## 3. Patrones de layout

### Contenedor principal

```css
.container {
  max-width: 1060px;
  margin-inline: auto;
  padding-inline: 24px;
}
```

### Grid de tarjetas (3 columnas)

```css
.card-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

@media (max-width: 860px) {
  .card-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 600px) {
  .card-grid { grid-template-columns: 1fr; }
}
```

### Banda decorativa diagonal

```css
.band {
  width: 100%;
  height: 2px;
  background: repeating-linear-gradient(
    90deg,
    var(--line) 0px,
    var(--line) 8px,
    transparent 8px,
    transparent 16px
  );
  margin-block: 64px;
}
```

### Breakpoints

| Nombre   | Valor    | Contexto                          |
|----------|----------|-----------------------------------|
| Desktop  | > 860px  | Layout multi-columna completo     |
| Tablet   | ≤ 860px  | Grid colapsado a 2 columnas       |
| Mobile L | ≤ 760px  | Nav hamburguesa, stack vertical   |
| Mobile S | ≤ 600px  | 1 columna, padding reducido       |

---

## 4. Accesibilidad

- **Foco visible**: Todo interactivo muestra `box-shadow` con `--rust` al recibir foco por teclado. Nunca `outline: none` sin reemplazo visible.
- **Contraste**: Ver tabla de combinaciones en §1.1. `--sage` sobre `--bg` solo para texto decorativo ≥18px.
- **Roles ARIA**: Tabs usan `role="tablist"` / `role="tab"` + `aria-selected`. Botones deshabilitados llevan `aria-disabled="true"`.
- **Reducción de movimiento**: Toda animación se desactiva con `prefers-reduced-motion: reduce`.
- **Touch targets**: Mínimo 44×44px para elementos interactivos en mobile.
- **Semántica HTML**: Usar `<button>` para acciones, `<a>` para navegación, `<label>` asociado a cada input.

---

## 5. Uso de las variables CSS

### ¿Dónde se declaran?

En `web/src/styles/landing.css` y `web/src/admin/admin.css`, ambas en el selector `:root`.

### Reglas de extensión

1. **Nunca** agregar un color hex nuevo directamente en un componente. Si se necesita un nuevo tono, declararlo como variable en `:root`.
2. Las variables de spacing no se usan como CSS custom properties aún — mantener la escala de 4px implícitamente.
3. Para colores con opacidad: usar `rgba()` a partir de los valores RGB de `--ink` (`27,43,35`) o `--rust` (`201,98,46`).

### Anti-patrones a evitar

```css
/* ❌ Incorrecto: valor hardcoded */
color: #3D5A45;

/* ✅ Correcto */
color: var(--moss);

/* ❌ Incorrecto: nueva sombra arbitraria */
box-shadow: 0 6px 20px black;

/* ✅ Correcto: usar escala de sombras del sistema */
box-shadow: 0 4px 14px rgba(27,43,35,0.10);

/* ❌ Incorrecto: font-family inline */
font-family: Georgia, serif;

/* ✅ Correcto */
font-family: 'Fraunces', serif;
```

---

*Última actualización: Junio 2026 — Lince Automatizaciones*
