/* Lince Teams — single-page client. Vanilla JS, no build step. */

"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const STATUS_LABEL = { todo: "Por hacer", doing: "En curso", done: "Hecho" };
const PRIORITY_LABEL = { low: "Baja", medium: "Media", high: "Alta" };
const PRIORITY_BADGE = { low: "badge-moss", medium: "badge-neutral", high: "badge-rust" };
// Colores de gráficos: tokens del design system (validados CVD), nunca hex aquí.
const CHART_VAR = { todo: "--chart-todo", doing: "--chart-doing", done: "--chart-done" };
// Backend en otro origen (Vercel + Render): se define en config.js
const API_BASE = (window.LINCE_API_BASE || "").replace(/\/$/, "");
const MIC_SVG = `<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`;
// Iconos para adjuntos de tareas (clip, enlace genérico, vista previa, quitar).
const CLIP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8.5l-9.19 9.19a4 4 0 0 1-5.66-5.66l9.2-9.19a2.5 2.5 0 0 1 3.53 3.54l-8.84 8.83a1 1 0 0 1-1.42-1.41l8.13-8.13"/></svg>`;
const LINK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
const X_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

const NOTE_COLORS = ["#F6E7A8", "#EFEAE0", "#DCE8DF", "#F3D9C9", "#FFFFFF"];
const PEN_COLORS = ["#1B2B23", "#C9622E", "#3D5A45", "#3B7EC0"];

const state = {
  token: localStorage.getItem("lince_token"),
  me: null,
  users: [],
  view: "dashboard",
  ws: null,
  renderSeq: 0, // guards against a stale async render overwriting a newer view
  wb: null,     // whiteboard runtime state while that view is mounted
  supabase: null, // cliente de Supabase en modo unificado (login compartido)
  cfg: null,      // respuesta de /api/config
};

/* En el modo unificado el token es el JWT de la sesión de Supabase (compartida
   con el panel /admin). Lo tomamos fresco en cada request; supabase-js lo
   refresca solo. En standalone se usa el token de sesión propio guardado. */
async function currentToken() {
  if (state.supabase) {
    const { data: { session } } = await state.supabase.auth.getSession();
    return session?.access_token || null;
  }
  return state.token;
}

function goToLogin() {
  const url = (state.cfg && state.cfg.loginUrl) || "/admin";
  location.replace(url + "?next=" + encodeURIComponent(location.pathname));
}

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

function avatarHtml(name, cls = "avatar") {
  if (!name) return "";
  return `<span class="${cls}" title="${esc(name)}">${esc(initials(name))}</span>`;
}

function parseTs(ts) {
  // SQLite entrega "YYYY-MM-DD HH:MM:SS" (UTC sin zona); Postgres, ISO con zona.
  const s = String(ts);
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return new Date(s);
  return new Date(s.replace(" ", "T") + "Z");
}

function timeAgo(iso) {
  const secs = (Date.now() - parseTs(iso).getTime()) / 1000;
  if (secs < 60) return "ahora";
  if (secs < 3600) return `hace ${Math.floor(secs / 60)} min`;
  if (secs < 86400) return `hace ${Math.floor(secs / 3600)} h`;
  return `hace ${Math.floor(secs / 86400)} d`;
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("#toast-root").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const tok = await currentToken();
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(`${API_BASE}/api${path}`, { ...options, headers });
  if (res.status === 401 && path !== "/login") {
    if (state.supabase) goToLogin();
    else logoutLocal();
    throw new Error("Sesión caducada, entra de nuevo.");
  }
  if (!res.ok) {
    let detail = `Error ${res.status}`;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  return res.json();
}

/* ---------- auth ---------- */

let authMode = "login";

function setupAuth() {
  const setMode = mode => {
    authMode = mode;
    $("#tab-login").classList.toggle("active", mode === "login");
    $("#tab-register").classList.toggle("active", mode === "register");
    $("#tab-login").setAttribute("aria-selected", mode === "login");
    $("#tab-register").setAttribute("aria-selected", mode === "register");
    $("#field-display").classList.toggle("hidden", mode === "login");
    $("#auth-submit").textContent = mode === "login" ? "Entrar" : "Crear cuenta";
    $("#auth-error").textContent = "";
    $("#auth-notice").textContent = "";
  };
  $("#tab-login").onclick = () => setMode("login");
  $("#tab-register").onclick = () => setMode("register");

  $("#auth-form").onsubmit = async e => {
    e.preventDefault();
    $("#auth-error").textContent = "";
    $("#auth-notice").textContent = "";
    try {
      const body = {
        username: $("#in-username").value,
        password: $("#in-password").value,
        display_name: $("#in-display").value || undefined,
      };
      const data = await api(`/${authMode}`, { method: "POST", body });
      if (data.pending) {
        setMode("login");
        $("#auth-notice").textContent = data.detail;
        return;
      }
      state.token = data.token;
      localStorage.setItem("lince_token", data.token);
      await enterApp();
    } catch (err) {
      $("#auth-error").textContent = err.message;
    }
  };
}

function logoutLocal() {
  state.token = null;
  state.me = null;
  localStorage.removeItem("lince_token");
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  $("#app").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
}

/* ---------- app shell ---------- */

async function enterApp() {
  state.me = await api("/me");
  state.users = await api("/users");
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#me-name").textContent = state.me.display_name;
  $("#me-avatar").outerHTML = avatarHtml(state.me.display_name).replace('class="avatar"', 'class="avatar" id="me-avatar"');
  // En modo unificado los miembros y roles se gestionan en el panel de Lince,
  // así que la pestaña Equipo (aprobación/roles locales) no aplica.
  $("#nav-team").classList.toggle("hidden", state.me.role !== "admin" || !!state.supabase);
  // Enlaces a las otras herramientas del ecosistema (Panel /admin, Startup OS
  // /startup-os/): solo tienen sentido en el despliegue unificado (mismo origen
  // tras el panel). En standalone no existen, así que se ocultan.
  $("#mast-apps").classList.toggle("hidden", !state.supabase);
  connectWs();
  showView(viewFromHash() || state.view);
}

// Enlaces con hash / botón atrás: /teams/#tablero abre esa pestaña.
window.addEventListener("hashchange", () => {
  const v = viewFromHash();
  if (v && state.me && v !== state.view) showView(v);
});

const VIEWS = {
  dashboard: renderDashboard,
  board: renderBoard,
  whiteboard: renderWhiteboard,
  transcripts: renderTranscripts,
  team: renderTeam,
};

/* Vista inicial / enlazable por URL (#/tablero, #/pizarra, …). Solo acepta
   vistas conocidas; el resto cae en el panel. */
function viewFromHash() {
  const key = (location.hash || "").replace(/^#\/?/, "");
  return VIEWS[key] ? key : null;
}

function renderLoading() {
  $("#main").innerHTML = `
    <div class="loading" role="status" aria-live="polite">
      <div class="spinner"></div>
      <span class="loading-label">Cargando…</span>
    </div>`;
}

function showView(view) {
  if (view === "team" && (state.me.role !== "admin" || state.supabase)) view = "dashboard";
  const changed = state.view !== view;
  if (state.view === "whiteboard" && view !== "whiteboard") state.wb = null;
  state.view = view;
  // Refleja la vista en la URL (#/vista) sin ensuciar el historial, para que
  // sea enlazable/recargable. replaceState evita disparar el hashchange.
  if ((location.hash || "").replace(/^#\/?/, "") !== view) {
    history.replaceState(null, "", "#/" + view);
  }
  document.body.classList.toggle("wb-active", view === "whiteboard");
  $$(".nav-item").forEach(b => {
    b.classList.toggle("active", b.dataset.view === view);
    b.setAttribute("aria-selected", b.dataset.view === view);
  });
  // Spinner DIFERIDO: solo aparece si la carga se demora (>250 ms). Así las
  // cargas rápidas (la mayoría) no parpadean, y el indicador aparece únicamente
  // cuando el usuario de verdad necesita saber que algo está cargando. Se cancela
  // en cuanto la vista termina de pintar, y no se programa en refrescos de la
  // misma vista (p. ej. avisos por WebSocket).
  let spinnerTimer = null;
  if (changed || !$("#main").innerHTML.trim()) {
    spinnerTimer = setTimeout(() => {
      if (state.view === view) renderLoading();
    }, 250);
  }
  const clearSpinner = () => { if (spinnerTimer) clearTimeout(spinnerTimer); };
  Promise.resolve(VIEWS[view]()).then(clearSpinner, err => {
    clearSpinner();
    if (state.view === view) {
      $("#main").innerHTML =
        `<div class="view"><div class="panel-card empty">No se pudo cargar la vista: ${esc(err.message)}</div></div>`;
    }
  });
}

async function connectWs() {
  const tok = await currentToken();
  if (!tok) return;
  // Base absoluta del backend: soporta API_BASE vacío (mismo origen), una URL
  // completa (Render en otro dominio) o un prefijo de ruta como "/teams" (cuando
  // se sirve tras el reverse-proxy same-origin). new URL(...) resuelve los tres.
  const httpBase = API_BASE
    ? new URL(API_BASE, location.origin).href.replace(/\/+$/, "")
    : location.origin;
  const ws = new WebSocket(httpBase.replace(/^http/, "ws") + "/ws");
  state.ws = ws;
  // El token se manda como primer mensaje, NUNCA en la URL: la query string
  // queda escrita en los access logs de nginx/Cloudflare y el JWT se filtraría.
  ws.onopen = () => ws.send(tok);
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "changed") return;
    if (msg.by !== state.me.display_name && msg.scope !== "board") {
      toast(`Actualizado por ${msg.by}`);
    }
    if (msg.scope === "users") {
      api("/users").then(u => (state.users = u));
      if (state.view === "team" || state.view === "dashboard") showView(state.view);
    }
    if (msg.scope === "tasks" && (state.view === "board" || state.view === "dashboard")) {
      // No re-renderizar el tablero a mitad de un arrastre: se aplica al soltar.
      if (state.view === "board" && boardDrag.active) boardDrag.pending = true;
      else showView(state.view);
    }
    if (msg.scope === "transcripts" && state.view === "transcripts") showView(state.view);
    if (msg.scope === "board" && state.wb) wbApply(msg.data);
  };
  // Reintenta mientras siga habiendo sesión (token propio o de Supabase).
  ws.onclose = () => setTimeout(() => { if (state.me) connectWs(); }, 3000);
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    else clearInterval(ping);
  }, 25000);
}

/* ---------- panel ---------- */

async function renderDashboard() {
  const seq = ++state.renderSeq;
  const d = await api("/dashboard");
  if (seq !== state.renderSeq || state.view !== "dashboard") return;
  const total = d.counts.todo + d.counts.doing + d.counts.done;
  const today = new Date().toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  const maxLoad = Math.max(1, ...d.per_user.map(u => u.open));

  const banner = (state.me.role === "admin" && d.pending_members > 0) ? `
    <div class="pending-banner">
      <span class="grow"><strong>${d.pending_members}</strong> solicitud${d.pending_members > 1 ? "es" : ""} de acceso pendiente${d.pending_members > 1 ? "s" : ""} de aprobación.</span>
      <button class="btn-primary btn-small" id="go-team">Revisar en Equipo</button>
    </div>` : "";

  $("#main").innerHTML = `<div class="view">
    <div class="view-head">
      <div>
        <h2>Hola, ${esc(state.me.display_name)}.</h2>
        <div class="view-sub">${esc(today)} — ${total} tareas en total</div>
      </div>
      <button class="btn-primary" id="dash-new-task">+ Nueva tarea</button>
    </div>
    ${banner}
    <div class="stat-grid">
      ${stat(d.counts.todo, "Por hacer")}
      ${stat(d.counts.doing, "En curso")}
      ${stat(d.counts.done, "Hechas")}
      ${stat(d.transcripts, "Transcripciones")}
    </div>
    <div class="chart-grid">
      <div class="panel-card">
        <h3>Estado de las tareas</h3>
        ${donutChart(d.counts, total)}
      </div>
      <div class="panel-card">
        <h3>Completadas — últimos 14 días</h3>
        ${barsChart(d.done_by_day)}
      </div>
    </div>
    <div class="dash-cols">
      <div>
        <div class="panel-card">
          <h3>Mis tareas pendientes</h3>
          ${d.mine.length ? d.mine.map(miniTask).join("") : `<div class="empty">Nada pendiente.</div>`}
        </div>
      </div>
      <div>
        <div class="panel-card">
          <h3>Carga del equipo</h3>
          ${d.per_user.length ? d.per_user.map(u => `
            <div class="load-row">
              <span class="name">${esc(u.name)}</span>
              <div class="track"><div class="fill" style="width:${(u.open / maxLoad) * 100}%"></div></div>
              <span class="n meta">${u.open}</span>
            </div>`).join("") : `<div class="empty">Sin miembros aún.</div>`}
        </div>
        <div class="panel-card">
          <h3>Actividad reciente</h3>
          ${d.activity.length ? d.activity.map(a => `
            <div class="feed-item"><span>${esc(a.text)}</span><span class="when meta">${timeAgo(a.created_at)}</span></div>
          `).join("") : `<div class="empty">Todavía no hay actividad.</div>`}
        </div>
      </div>
    </div>
  </div>`;

  $("#dash-new-task").onclick = () => taskModal();
  const goTeam = $("#go-team");
  if (goTeam) goTeam.onclick = () => showView("team");
  $$(".mini-task[data-id]").forEach(el =>
    el.onclick = async () => taskModal(await api(`/tasks`).then(ts => ts.find(t => t.id == el.dataset.id))));

  function stat(num, label) {
    return `<div class="panel-card stat"><span class="label">${esc(label)}</span><div class="num">${num}</div></div>`;
  }
  function miniTask(t) {
    const due = t.due_date ? ` · vence ${t.due_date}` : "";
    return `<div class="mini-task" data-id="${t.id}" style="cursor:pointer">
      <span class="badge ${PRIORITY_BADGE[t.priority]}">${PRIORITY_LABEL[t.priority]}</span>
      <span class="t">${esc(t.title)}</span>
      <span class="meta">${STATUS_LABEL[t.status]}${esc(due)}</span>
    </div>`;
  }
}

/* Dona de estados: identidad por color validado + leyenda con etiqueta y
   valor directos (nunca color solo). Hueco de 2px entre segmentos. */
function donutChart(counts, total) {
  if (!total) return `<div class="empty">Aún no hay tareas.</div>`;
  const R = 54, C = 2 * Math.PI * R, GAP = 2.5;
  const order = ["done", "doing", "todo"];
  let offset = C / 4; // empieza arriba
  const segs = order.filter(k => counts[k] > 0).map(k => {
    const frac = counts[k] / total;
    const len = Math.max(frac * C - GAP, 1);
    const seg = `<circle r="${R}" cx="70" cy="70" fill="none"
      style="stroke:var(${CHART_VAR[k]})" stroke-width="18"
      stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${offset}">
      <title>${STATUS_LABEL[k]}: ${counts[k]}</title></circle>`;
    offset -= frac * C;
    return seg;
  }).join("");
  const legend = order.map(k => `
    <div class="legend-item">
      <span class="dot" style="background:var(${CHART_VAR[k]})"></span>
      ${STATUS_LABEL[k]} <span class="meta">${counts[k]} · ${Math.round((counts[k] / total) * 100)}%</span>
    </div>`).join("");
  return `<div class="donut-row">
    <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Distribución de tareas por estado">
      ${segs}
      <text x="70" y="66" text-anchor="middle" style="font-family:var(--display);font-size:30px;fill:var(--ink)">${total}</text>
      <text x="70" y="86" text-anchor="middle" style="font-family:var(--mono);font-size:9px;letter-spacing:.07em;fill:var(--sage)">TAREAS</text>
    </svg>
    <div class="donut-legend">${legend}</div>
  </div>`;
}

/* Serie única de magnitud en el tiempo: un solo tono, sin leyenda (el título
   la nombra); valor exacto en hover; etiqueta directa solo en el máximo. */
function barsChart(days) {
  const max = Math.max(1, ...days.map(d => d.n));
  const peak = days.reduce((a, b) => (b.n > a.n ? b : a), days[0]);
  const bars = days.map(d => {
    const label = new Date(d.day + "T00:00:00Z").toLocaleDateString("es", { day: "numeric", month: "short", timeZone: "UTC" });
    return `<div class="bar-col" title="${esc(label)}: ${d.n} completada${d.n === 1 ? "" : "s"}">
      <div class="bar ${d.n === 0 ? "zero" : ""}" style="height:${d.n === 0 ? 2 : Math.max(6, (d.n / max) * 100)}%"></div>
    </div>`;
  }).join("");
  const labels = days.map((d, i) => {
    const show = i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2);
    const label = new Date(d.day + "T00:00:00Z").toLocaleDateString("es", { day: "numeric", month: "short", timeZone: "UTC" });
    return `<span>${show ? esc(label) : ""}</span>`;
  }).join("");
  const note = peak && peak.n > 0
    ? `<div class="meta" style="margin-top:8px">Pico: ${peak.n} el ${new Date(peak.day + "T00:00:00Z").toLocaleDateString("es", { day: "numeric", month: "long", timeZone: "UTC" })}</div>`
    : `<div class="empty">Sin tareas completadas en este periodo.</div>`;
  return `<div class="bars14">${bars}</div><div class="bars-labels">${labels}</div>${note}`;
}

/* ---------- tablero kanban ---------- */

/* Arrastre de tarjetas con Pointer Events: funciona igual con mouse y con el
   dedo (el drag & drop nativo de HTML5 no dispara en pantallas táctiles).
   En táctil la tarjeta se "levanta" manteniéndola pulsada ~200 ms; mover el
   dedo antes cede el gesto al scroll (touch-action: pan-y en .task-card).
   Mientras hay un arrastre activo, los re-renders del tablero que llegan por
   WebSocket se posponen hasta soltar (el innerHTML mataría el gesto). */
const boardDrag = { active: false, pending: false };

function startCardDrag(e, card, task) {
  if (e.button !== 0) return;
  const touch = e.pointerType !== "mouse";
  const startX = e.clientX, startY = e.clientY;
  let x = startX, y = startY;
  let lifted = false, ghost = null, overCol = null, offX = 0, offY = 0;
  let liftTimer = 0, rafId = 0;

  const lift = () => {
    lifted = true;
    boardDrag.active = true;
    const r = card.getBoundingClientRect();
    offX = x - r.left; offY = y - r.top;
    ghost = card.cloneNode(true);
    ghost.classList.add("task-ghost");
    ghost.style.width = r.width + "px";
    document.body.appendChild(ghost);
    card.classList.add("dragging");
    card.dataset.dragged = "1";
    document.body.style.cursor = "grabbing";
    placeGhost(); highlight();
    rafId = requestAnimationFrame(tick);
  };

  const placeGhost = () => {
    ghost.style.left = (x - offX) + "px";
    ghost.style.top = (y - offY) + "px";
  };

  const highlight = () => {
    const el = document.elementFromPoint(x, y); // el ghost no estorba (pointer-events: none)
    const col = el ? el.closest(".col") : null;
    if (col !== overCol) {
      if (overCol) overCol.classList.remove("drag-over");
      overCol = col;
      if (overCol) overCol.classList.add("drag-over");
    }
  };

  // Auto-scroll de la página cerca de los bordes (en el teléfono las columnas
  // se apilan en vertical y la columna de destino puede quedar fuera de vista).
  const tick = () => {
    if (!lifted) return;
    const m = 80, vh = window.innerHeight;
    let dy = 0;
    if (y < m) dy = -Math.ceil((m - y) / 6);
    else if (y > vh - m) dy = Math.ceil((y - (vh - m)) / 6);
    if (dy) { window.scrollBy(0, dy); highlight(); }
    rafId = requestAnimationFrame(tick);
  };

  const onMove = ev => {
    x = ev.clientX; y = ev.clientY;
    if (!lifted) {
      const dist = Math.abs(x - startX) + Math.abs(y - startY);
      // Antes de levantar: en táctil mover cancela (gana el scroll nativo);
      // con mouse superar el umbral inicia el arrastre y el clic queda intacto.
      if (touch) { if (dist > 8) cleanup(); }
      else if (dist > 5) lift();
      return;
    }
    placeGhost(); highlight();
  };

  // Con la tarjeta levantada ningún touchmove debe scrollear la página. Como
  // el dedo estuvo quieto durante la pulsación larga, el navegador aún no
  // inició el scroll y el primer touchmove sigue siendo cancelable.
  const onTouchMove = ev => { if (lifted) ev.preventDefault(); };

  const cleanup = () => {
    clearTimeout(liftTimer);
    cancelAnimationFrame(rafId);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("touchmove", onTouchMove);
    document.body.style.cursor = "";
    if (ghost) { ghost.remove(); ghost = null; }
    if (overCol) overCol.classList.remove("drag-over");
    card.classList.remove("dragging");
    // El clic que sigue al pointerup no debe abrir el modal tras un arrastre.
    if (card.dataset.dragged) setTimeout(() => { delete card.dataset.dragged; }, 400);
  };

  const flushPending = () => {
    boardDrag.active = false;
    if (boardDrag.pending) {
      boardDrag.pending = false;
      if (state.view === "board") renderBoard();
    }
  };

  const onCancel = () => { lifted = false; cleanup(); flushPending(); };

  const onUp = async () => {
    const target = lifted && overCol ? overCol.dataset.status : null;
    lifted = false;
    cleanup();
    if (target && target !== task.status) {
      boardDrag.active = false;
      boardDrag.pending = false;
      try {
        await api(`/tasks/${task.id}`, { method: "PATCH", body: { status: target } });
        renderBoard();
      } catch (err) { toast(err.message, "error"); }
      return;
    }
    flushPending();
  };

  if (touch) liftTimer = setTimeout(lift, 200);
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
  document.addEventListener("touchmove", onTouchMove, { passive: false });
}

async function renderBoard() {
  const seq = ++state.renderSeq;
  const tasks = await api("/tasks");
  if (seq !== state.renderSeq || state.view !== "board") return;
  $("#main").innerHTML = `<div class="view">
    <div class="view-head">
      <div><h2>Tablero</h2><div class="view-sub">Arrastra las tarjetas entre columnas (en el móvil, mantén pulsada la tarjeta); haz clic para editar o asignar</div></div>
      <button class="btn-primary" id="board-new-task">+ Nueva tarea</button>
    </div>
    <div class="board">
      ${["todo", "doing", "done"].map(s => column(s, tasks.filter(t => t.status === s))).join("")}
    </div>
  </div>`;

  $("#board-new-task").onclick = () => taskModal();

  $$(".task-card").forEach(card => {
    const task = tasks.find(t => t.id == card.dataset.id);
    card.onclick = () => { if (!card.dataset.dragged) taskModal(task); };
    card.oncontextmenu = ev => ev.preventDefault(); // menú de long-press en Android
    card.onpointerdown = ev => startCardDrag(ev, card, task);
  });

  function column(status, items) {
    return `
    <div class="col" data-status="${status}">
      <div class="col-head">
        <span class="label">${STATUS_LABEL[status]}</span>
        <span class="count meta">${items.length}</span>
      </div>
      ${items.map(taskCard).join("") || `<div class="empty">Vacío</div>`}
    </div>`;
  }

  function taskCard(t) {
    const late = t.due_date && t.status !== "done" && t.due_date < new Date().toISOString().slice(0, 10);
    return `
    <div class="task-card" data-id="${t.id}">
      <div class="title">${esc(t.title)}</div>
      ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ""}
      <div class="task-foot">
        <span class="badge ${PRIORITY_BADGE[t.priority]}">${PRIORITY_LABEL[t.priority]}</span>
        ${t.links && t.links.length ? `<span class="task-attach" title="${t.links.length} adjunto${t.links.length > 1 ? "s" : ""}">${CLIP_SVG}${t.links.length}</span>` : ""}
        ${t.due_date ? `<span class="due ${late ? "late" : ""}">${late ? "VENCIDA " : ""}${t.due_date}</span>` : ""}
        ${avatarHtml(t.assignee_name)}
      </div>
    </div>`;
  }
}

/* ---------- modal de tarea ---------- */

function taskModal(task = null) {
  const isEdit = !!task;
  $("#modal-root").innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <h3>${isEdit ? "Editar tarea" : "Nueva tarea"}</h3>
      <div class="field"><label class="field-label">Título</label>
        <input id="m-title" class="field-input" value="${esc(task?.title || "")}" placeholder="¿Qué hay que hacer?"></div>
      <div class="field"><label class="field-label">Descripción</label>
        <textarea id="m-desc" class="field-textarea" rows="3">${esc(task?.description || "")}</textarea></div>
      <div class="row2">
        <div class="field"><label class="field-label">Estado</label>
          <select id="m-status" class="field-select">${Object.entries(STATUS_LABEL).map(([v, l]) =>
            `<option value="${v}" ${task?.status === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </div>
        <div class="field"><label class="field-label">Prioridad</label>
          <select id="m-priority" class="field-select">${Object.entries(PRIORITY_LABEL).map(([v, l]) =>
            `<option value="${v}" ${(task?.priority || "medium") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </div>
      </div>
      <div class="row2">
        <div class="field"><label class="field-label">Asignada a</label>
          <select id="m-assignee" class="field-select">
            <option value="">Sin asignar</option>
            ${state.users.map(u => `<option value="${u.id}" ${task?.assignee_id === u.id ? "selected" : ""}>${esc(u.display_name)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label class="field-label">Fecha límite</label>
          <input id="m-due" class="field-input" type="date" value="${task?.due_date || ""}"></div>
      </div>
      ${isEdit ? `
      <div class="field">
        <label class="field-label">Adjuntos — docs de Drive, issues de GitHub, enlaces</label>
        <div id="m-links" class="attach-list"></div>
        <div class="attach-add">
          <input id="m-link-url" class="field-input" placeholder="Pegá un enlace (Drive, GitHub, cualquier URL)">
          <button class="btn-ghost btn-small" id="m-link-add" type="button">Adjuntar</button>
        </div>
        <div id="m-link-preview" class="attach-preview"></div>
      </div>` : `
      <div class="field attach-hint"><span class="meta">Podés adjuntar docs y enlaces una vez creada la tarea.</span></div>`}
      <div class="modal-actions">
        ${isEdit ? `<button class="btn-ghost btn-small btn-danger" id="m-delete">Eliminar</button>` : ""}
        <div class="spacer"></div>
        <button class="btn-ghost" id="m-cancel">Cancelar</button>
        <button class="btn-primary" id="m-save">${isEdit ? "Guardar" : "Crear"}</button>
      </div>
    </div>
  </div>`;

  const close = () => ($("#modal-root").innerHTML = "");
  $("#modal-overlay").onclick = e => { if (e.target.id === "modal-overlay") close(); };
  $("#m-cancel").onclick = close;
  $("#m-title").focus();
  if (isEdit) mountTaskLinks(task);

  $("#m-save").onclick = async () => {
    const body = {
      title: $("#m-title").value,
      description: $("#m-desc").value,
      status: $("#m-status").value,
      priority: $("#m-priority").value,
      assignee_id: $("#m-assignee").value ? +$("#m-assignee").value : null,
      due_date: $("#m-due").value || null,
    };
    try {
      if (isEdit) await api(`/tasks/${task.id}`, { method: "PATCH", body });
      else await api("/tasks", { method: "POST", body });
      close();
      toast(isEdit ? "Tarea guardada" : "Tarea creada", "ok");
      showView(state.view);
    } catch (err) { toast(err.message, "error"); }
  };

  if (isEdit) $("#m-delete").onclick = async () => {
    try {
      await api(`/tasks/${task.id}`, { method: "DELETE" });
      close();
      toast("Tarea eliminada", "ok");
      showView(state.view);
    } catch (err) { toast(err.message, "error"); }
  };
}

/* ---------- adjuntos de una tarea (dentro del modal) ---------- */

// INTEGRATION_META (mapa de iconos/color por proveedor) se define más abajo,
// pero es una const de módulo: ya existe cuando esto corre al abrir el modal.
function attachIcon(provider) {
  const meta = (typeof INTEGRATION_META !== "undefined") && INTEGRATION_META[provider];
  return meta ? { icon: meta.icon, accent: meta.accent } : { icon: LINK_SVG, accent: "--sage" };
}

function linkChip(link) {
  const { icon, accent } = attachIcon(link.provider);
  const previewable = link.provider === "google_drive" && link.drive && link.drive.embeddable;
  return `<div class="attach-chip" data-id="${link.id}">
    <span class="attach-ico" style="color:var(${accent})">${icon}</span>
    <a class="attach-title" href="${esc(link.url)}" target="_blank" rel="noopener" title="${esc(link.title)}\n${esc(link.url)}">${esc(link.title)}</a>
    ${previewable ? `<button class="attach-btn attach-preview-btn" data-embed="${esc(link.drive.embed_url)}" title="Vista previa" type="button">${EYE_SVG}</button>` : ""}
    <button class="attach-btn attach-remove" title="Quitar adjunto" type="button">${X_SVG}</button>
  </div>`;
}

function mountTaskLinks(task) {
  const listEl = $("#m-links");
  const previewEl = $("#m-link-preview");
  const addBtn = $("#m-link-add");
  const input = $("#m-link-url");
  if (!listEl) return;
  let links = Array.isArray(task.links) ? [...task.links] : [];

  function render() {
    listEl.innerHTML = links.length
      ? links.map(linkChip).join("")
      : `<div class="attach-empty meta">Sin adjuntos todavía.</div>`;
    $$(".attach-remove", listEl).forEach(b => b.onclick = async () => {
      const id = b.closest(".attach-chip").dataset.id;
      try {
        await api(`/tasks/${task.id}/links/${id}`, { method: "DELETE" });
        links = links.filter(l => String(l.id) !== id);
        previewEl.innerHTML = ""; previewEl.dataset.open = "";
        render();
      } catch (err) { toast(err.message, "error"); }
    });
    $$(".attach-preview-btn", listEl).forEach(b => b.onclick = () => {
      const id = b.closest(".attach-chip").dataset.id;
      if (previewEl.dataset.open === id) { previewEl.innerHTML = ""; previewEl.dataset.open = ""; return; }
      previewEl.innerHTML = `<iframe class="drive-frame" src="${esc(b.dataset.embed)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`;
      previewEl.dataset.open = id;
    });
  }
  render();

  const doAdd = async () => {
    const url = input.value.trim();
    if (!url) { toast("Pegá un enlace para adjuntar", "error"); return; }
    addBtn.disabled = true;
    try {
      const link = await api(`/tasks/${task.id}/links`, { method: "POST", body: { url } });
      links.push(link);
      input.value = "";
      render();
      toast("Adjuntado", "ok");
    } catch (err) { toast(err.message, "error"); }
    finally { addBtn.disabled = false; }
  };
  addBtn.onclick = doAdd;
  input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } };
}

/* Diálogo de confirmación reutilizable para acciones destructivas. */
function confirmModal({ title, body, confirm = "Confirmar", onConfirm }) {
  $("#modal-root").innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal modal-sm">
      <h3>${esc(title)}</h3>
      <p class="confirm-body">${esc(body)}</p>
      <div class="modal-actions">
        <div class="spacer"></div>
        <button class="btn-ghost" id="c-cancel">Cancelar</button>
        <button class="btn-ghost btn-danger" id="c-ok">${esc(confirm)}</button>
      </div>
    </div>
  </div>`;
  const close = () => ($("#modal-root").innerHTML = "");
  $("#modal-overlay").onclick = e => { if (e.target.id === "modal-overlay") close(); };
  $("#c-cancel").onclick = close;
  $("#c-ok").onclick = async () => { close(); await onConfirm(); };
}

/* ---------- pizarra colaborativa ---------- */

const SVGNS = "http://www.w3.org/2000/svg";

// Herramientas de la pizarra: icono (SVG), etiqueta y atajo de teclado.
const WB_TOOLS = [
  { mode: "move",    label: "Seleccionar", key: "V", icon: '<path d="M5 3l6 15 2-6 6-2L5 3z"/>' },
  { mode: "pen",     label: "Lápiz",       key: "P", icon: '<path d="M15.5 3.5l5 5L8 21H3v-5L15.5 3.5z"/><path d="M13.5 5.5l5 5"/>' },
  { mode: "marker",  label: "Marcador",    key: "M", icon: '<path d="M4 20h5l9-9-5-5-9 9v5z"/><path d="M13 5l5 5"/><line x1="4" y1="20" x2="9" y2="20"/>' },
  { mode: "rect",    label: "Rectángulo",  key: "R", icon: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>' },
  { mode: "ellipse", label: "Elipse",      key: "O", icon: '<circle cx="12" cy="12" r="8"/>' },
  { mode: "line",    label: "Línea",       key: "L", icon: '<line x1="5" y1="19" x2="19" y2="5"/>' },
  { mode: "arrow",   label: "Flecha",      key: "A", icon: '<line x1="5" y1="19" x2="19" y2="5"/><polyline points="10 5 19 5 19 14"/>' },
  { mode: "text",    label: "Texto",       key: "T", icon: '<polyline points="5 7 5 5 19 5 19 7"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="9" y1="19" x2="15" y2="19"/>' },
  { mode: "note",    label: "Nota",        key: "N", icon: '<path d="M5 4h9l5 5v11H5z"/><polyline points="14 4 14 9 19 9"/>' },
  { mode: "image",   label: "Imagen",      key: "I", icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><polyline points="21 15 16 10 5 21"/>' },
  { mode: "erase",   label: "Borrador",    key: "E", icon: '<path d="M7 21l-4.3-4.3a2 2 0 0 1 0-2.8l9.6-9.6a2 2 0 0 1 2.8 0l5.6 5.6a2 2 0 0 1 0 2.8L13 21"/><line x1="22" y1="21" x2="7" y2="21"/><line x1="5" y1="11" x2="14" y2="20"/>' },
];
const WB_SHAPES = new Set(["rect", "ellipse", "line", "arrow"]);
const WB_DRAW = new Set(["pen", "marker", "rect", "ellipse", "line", "arrow"]);
const WB_PEN_SIZES = [2, 4, 7];
const WB_MARKER_SIZES = [12, 20, 30];
const WB_TEXT_SIZES = [16, 22, 32];
const WB_ERASER_R = 16; // radio del borrador en px lógicos
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function svgIcon(paths) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ` +
    `stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

async function renderWhiteboard() {
  const seq = ++state.renderSeq;
  const items = await api("/board");
  if (seq !== state.renderSeq || state.view !== "whiteboard") return;

  $("#main").innerHTML = `
    <div class="wb-screen">
      <div class="wb-wrap" id="wb-wrap">
        <div class="wb-canvas mode-move" id="wb-canvas">
          <svg id="wb-svg" xmlns="${SVGNS}"></svg>
        </div>
      </div>

      <div class="wb-toolbar" id="wb-toolbar" role="toolbar" aria-label="Herramientas de pizarra">
        ${WB_TOOLS.map(t => `
          <button class="wb-tool ${t.mode === "move" ? "active" : ""}" data-mode="${t.mode}"
                  title="${t.label} · ${t.key}" aria-label="${t.label}">${svgIcon(t.icon)}</button>`).join("")}
      </div>

      <div class="wb-options hidden" id="wb-options">
        <div class="wb-colors" id="wb-colors"></div>
        <div class="wb-divider" id="wb-size-div"></div>
        <div class="wb-sizes" id="wb-sizes"></div>
      </div>

      <div class="wb-actions">
        <button class="wb-act" id="wb-undo" title="Deshacer · Ctrl+Z" aria-label="Deshacer">
          ${svgIcon('<polyline points="9 14 4 9 9 4"/><path d="M20 20v-6a5 5 0 0 0-5-5H4"/>')}</button>
        <button class="wb-act wb-act-danger" id="wb-clear" title="Limpiar toda la pizarra" aria-label="Limpiar todo">
          ${svgIcon('<polyline points="3 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>')}</button>
      </div>

      <div class="wb-zoom">
        <button class="wb-zoom-btn" id="wb-zoom-out" title="Alejar" aria-label="Alejar">−</button>
        <button class="wb-zoom-label" id="wb-zoom-label" title="Restablecer zoom (100%)">100%</button>
        <button class="wb-zoom-btn" id="wb-zoom-in" title="Acercar" aria-label="Acercar">+</button>
      </div>

      <div class="wb-cursor hidden" id="wb-cursor"></div>
      <input type="file" id="wb-file" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden">
    </div>`;

  const wb = state.wb = {
    mode: "move",
    drawColor: PEN_COLORS[0],
    noteColor: NOTE_COLORS[0],
    penSize: WB_PEN_SIZES[1],
    markerSize: WB_MARKER_SIZES[1],
    shapeSize: WB_PEN_SIZES[1],
    textSize: WB_TEXT_SIZES[1],
    zoom: 1,
    items: new Map(),
    drawing: null,
    undo: [],
  };
  const canvas = $("#wb-canvas"), svg = $("#wb-svg"), wrap = $("#wb-wrap");

  /* -- coordenadas (compensando el zoom) -- */
  const canvasPoint = e => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / wb.zoom, y: (e.clientY - r.top) / wb.zoom };
  };

  /* -- selección de herramienta y panel contextual -- */
  function setMode(mode) {
    wb.mode = mode;
    canvas.className = `wb-canvas mode-${mode}`;
    $$(".wb-tool").forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on);
    });
    $("#wb-cursor").classList.toggle("hidden", mode !== "erase");
    renderOptions();
    if (mode === "image") $("#wb-file").click();
  }

  function renderOptions() {
    const box = $("#wb-options");
    const showColors = WB_DRAW.has(wb.mode) || wb.mode === "text" || wb.mode === "note";
    box.classList.toggle("hidden", !showColors);
    if (!showColors) return;

    const isNote = wb.mode === "note";
    const colors = isNote ? NOTE_COLORS : PEN_COLORS;
    const current = isNote ? wb.noteColor : wb.drawColor;
    $("#wb-colors").innerHTML = colors.map(c =>
      `<button class="wb-swatch ${c === current ? "active" : ""}" style="--sw:${c}" data-c="${c}" title="${c}"></button>`
    ).join("");
    $$("#wb-colors .wb-swatch").forEach(s => s.onclick = () => {
      if (isNote) wb.noteColor = s.dataset.c; else wb.drawColor = s.dataset.c;
      renderOptions();
    });

    const sizes =
      wb.mode === "pen"      ? { list: WB_PEN_SIZES,    cur: wb.penSize,    set: v => (wb.penSize = v) } :
      wb.mode === "marker"   ? { list: WB_MARKER_SIZES, cur: wb.markerSize, set: v => (wb.markerSize = v) } :
      wb.mode === "text"     ? { list: WB_TEXT_SIZES,   cur: wb.textSize,   set: v => (wb.textSize = v) } :
      WB_SHAPES.has(wb.mode) ? { list: WB_PEN_SIZES,    cur: wb.shapeSize,  set: v => (wb.shapeSize = v) } :
      null;
    $("#wb-size-div").classList.toggle("hidden", !sizes);
    $("#wb-sizes").classList.toggle("hidden", !sizes);
    if (sizes) {
      const max = sizes.list[sizes.list.length - 1];
      const names = ["Fino", "Medio", "Grueso"];
      $("#wb-sizes").innerHTML = sizes.list.map((v, i) => {
        const d = Math.round(7 + (v / max) * 13);
        return `<button class="wb-size ${v === sizes.cur ? "active" : ""}" data-v="${v}" title="${names[i] || v}">` +
          `<span style="width:${d}px;height:${d}px"></span></button>`;
      }).join("");
      $$("#wb-sizes .wb-size").forEach(b => b.onclick = () => { sizes.set(+b.dataset.v); renderOptions(); });
    }
  }

  const strokeWidth = () =>
    wb.mode === "marker" ? wb.markerSize :
    WB_SHAPES.has(wb.mode) ? wb.shapeSize : wb.penSize;
  const markerColor = c => c + "66"; // ~40% de opacidad (hex de 8 dígitos)

  /* -- render de elementos (idempotente: reutiliza el nodo si ya existe) -- */

  function renderItem(item) {
    wb.items.set(item.id, item);
    if (item.kind === "stroke") return renderStroke(item);
    if (item.kind === "shape")  return renderShape(item);
    if (item.kind === "note")   return renderNote(item);
    if (item.kind === "image")  return renderImage(item);
    if (item.kind === "text")   return renderText(item);
  }

  const strokePoints = content => {
    try { return JSON.parse(content || "[]").map(p => p.join(",")).join(" "); }
    catch { return ""; }
  };

  function renderStroke(item) {
    let el = svg.querySelector(`[data-id="${item.id}"]`);
    if (!el || el.tagName.toLowerCase() !== "polyline") {
      if (el) el.remove();
      el = document.createElementNS(SVGNS, "polyline");
      el.dataset.id = item.id;
      svg.appendChild(el);
    }
    el.setAttribute("points", strokePoints(item.content));
    el.style.fill = "none";
    el.style.stroke = item.color || "var(--ink)";
    el.style.strokeWidth = (item.w || 3) + "px";
  }

  function setShapeGeometry(el, t, x1, y1, x2, y2) {
    if (t === "rect") {
      el.setAttribute("x", Math.min(x1, x2));
      el.setAttribute("y", Math.min(y1, y2));
      el.setAttribute("width", Math.abs(x2 - x1));
      el.setAttribute("height", Math.abs(y2 - y1));
      el.setAttribute("rx", 4);
    } else if (t === "ellipse") {
      el.setAttribute("cx", (x1 + x2) / 2);
      el.setAttribute("cy", (y1 + y2) / 2);
      el.setAttribute("rx", Math.abs(x2 - x1) / 2);
      el.setAttribute("ry", Math.abs(y2 - y1) / 2);
    } else {
      el.setAttribute("d", t === "arrow" ? arrowPath(x1, y1, x2, y2) : `M ${x1} ${y1} L ${x2} ${y2}`);
    }
  }

  function arrowPath(x1, y1, x2, y2) {
    const a = Math.atan2(y2 - y1, x2 - x1), h = 14;
    const ax = x2 - h * Math.cos(a - Math.PI / 7), ay = y2 - h * Math.sin(a - Math.PI / 7);
    const bx = x2 - h * Math.cos(a + Math.PI / 7), by = y2 - h * Math.sin(a + Math.PI / 7);
    return `M ${x1} ${y1} L ${x2} ${y2} M ${x2} ${y2} L ${ax} ${ay} M ${x2} ${y2} L ${bx} ${by}`;
  }

  const shapeMeta = content => {
    try { const o = JSON.parse(content); return { t: o.t || "rect", sw: o.sw || 3 }; }
    catch { return { t: "rect", sw: 3 }; }
  };

  function renderShape(item) {
    const meta = shapeMeta(item.content);
    const tag = meta.t === "rect" ? "rect" : meta.t === "ellipse" ? "ellipse" : "path";
    let el = svg.querySelector(`[data-id="${item.id}"]`);
    if (!el || el.tagName.toLowerCase() !== tag) {
      if (el) el.remove();
      el = document.createElementNS(SVGNS, tag);
      el.dataset.id = item.id;
      svg.appendChild(el);
    }
    el.style.fill = "none";
    el.style.stroke = item.color || "var(--ink)";
    el.style.strokeWidth = (meta.sw || 3) + "px";
    setShapeGeometry(el, meta.t, item.x, item.y, item.x + (item.w || 0), item.y + (item.h || 0));
  }

  function renderNote(item) {
    let node = canvas.querySelector(`.wb-note[data-id="${item.id}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = "wb-note";
      node.dataset.id = item.id;
      node.innerHTML = `<div class="wb-note-text"></div><span class="wb-author label"></span>`;
      node.addEventListener("pointerdown", e => itemPointerDown(e, item.id, node));
      node.ondblclick = () => editNote(item.id, node);
      node.addEventListener("pointerup", e => tapToEdit(e, node, () => editNote(item.id, node)));
      canvas.appendChild(node);
    }
    node.style.background = item.color || NOTE_COLORS[0];
    node.style.left = item.x + "px";
    node.style.top = item.y + "px";
    const t = node.querySelector(".wb-note-text");
    if (!t.isContentEditable && t.textContent !== item.content) t.textContent = item.content;
    node.querySelector(".wb-author").textContent = item.author || "";
  }

  function editNote(id, node) {
    if (wb.mode !== "move") return;
    const t = node.querySelector(".wb-note-text");
    t.contentEditable = "plaintext-only";
    t.focus();
    const sel = window.getSelection(); sel.selectAllChildren(t); sel.collapseToEnd();
    t.onblur = async () => {
      t.contentEditable = "false";
      const item = wb.items.get(id); if (!item) return;
      const content = t.textContent;
      if (content !== item.content) {
        try { await api(`/board/${id}`, { method: "PATCH", body: { content } }); }
        catch (err) { toast(err.message, "error"); }
      }
    };
  }

  function renderImage(item) {
    let node = canvas.querySelector(`img.wb-img[data-id="${item.id}"]`);
    if (!node) {
      node = document.createElement("img");
      node.className = "wb-img";
      node.dataset.id = item.id;
      node.draggable = false;
      node.src = (item.content.startsWith("/") ? API_BASE : "") + item.content;
      node.addEventListener("pointerdown", e => itemPointerDown(e, item.id, node));
      canvas.appendChild(node);
    }
    node.style.left = item.x + "px";
    node.style.top = item.y + "px";
    if (item.w) node.style.width = item.w + "px";
  }

  function renderText(item) {
    let node = canvas.querySelector(`.wb-text[data-id="${item.id}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = "wb-text";
      node.dataset.id = item.id;
      node.addEventListener("pointerdown", e => itemPointerDown(e, item.id, node));
      node.ondblclick = () => editText(item.id, node);
      node.addEventListener("pointerup", e => tapToEdit(e, node, () => editText(item.id, node)));
      canvas.appendChild(node);
    }
    node.style.left = item.x + "px";
    node.style.top = item.y + "px";
    node.style.color = item.color || "var(--ink)";
    node.style.fontSize = (item.w || 22) + "px";
    if (!node.isContentEditable && node.textContent !== item.content) node.textContent = item.content;
  }

  function editText(id, node) {
    if (wb.mode !== "move" && wb.mode !== "text") return;
    node.contentEditable = "plaintext-only";
    node.focus();
    const sel = window.getSelection(); sel.selectAllChildren(node); sel.collapseToEnd();
    node.onblur = async () => {
      node.contentEditable = "false";
      const item = wb.items.get(id); if (!item) return;
      const content = node.textContent.trim();
      if (!content) { deleteItem(id); return; }        // texto vacío → se elimina
      if (content !== item.content) {
        try { await api(`/board/${id}`, { method: "PATCH", body: { content } }); }
        catch (err) { toast(err.message, "error"); }
      }
    };
  }

  function removeNode(id) {
    const el = canvas.querySelector(`[data-id="${id}"]`) || svg.querySelector(`[data-id="${id}"]`);
    if (el) el.remove();
  }

  async function deleteItem(id) {
    if (!wb.items.has(id)) return;
    wb.items.delete(id);
    removeNode(id);
    try { await api(`/board/${id}`, { method: "DELETE" }); }
    catch (err) { toast(err.message, "error"); }
  }

  /* -- arrastre de notas / imágenes / texto -- */

  function itemPointerDown(e, id, node) {
    if (wb.mode === "erase") return;               // el borrado lo gestiona el lienzo
    if (wb.mode !== "move") return;
    if (e.target.isContentEditable) return;        // editando texto
    e.preventDefault(); e.stopPropagation();
    node.setPointerCapture?.(e.pointerId);
    const start = canvasPoint(e);
    const origin = { x: parseFloat(node.style.left) || 0, y: parseFloat(node.style.top) || 0 };
    let moved = false;
    const onMove = ev => {
      if (pinch.active) return; // el gesto de dos dedos manda
      const p = canvasPoint(ev);
      if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 3) moved = true;
      node.style.left = Math.max(0, origin.x + p.x - start.x) + "px";
      node.style.top = Math.max(0, origin.y + p.y - start.y) + "px";
    };
    const onUp = async () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      if (!moved) return;
      try {
        await api(`/board/${id}`, {
          method: "PATCH",
          body: { x: parseFloat(node.style.left), y: parseFloat(node.style.top) },
        });
      } catch (err) { toast(err.message, "error"); }
    };
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
  }

  /* Doble-tap táctil para editar notas/textos: el dblclick de los WebView es
     poco confiable con el dedo; con mouse sigue mandando el ondblclick. */
  function tapToEdit(e, node, edit) {
    if (e.pointerType === "mouse" || pinch.active) return;
    const now = Date.now();
    if (now - (node._lastTap || 0) < 350) { node._lastTap = 0; edit(); }
    else node._lastTap = now;
  }

  /* -- crear notas / texto -- */

  async function createNoteAt(p) {
    try {
      const item = await api("/board", {
        method: "POST",
        body: { kind: "note", x: p.x, y: p.y, color: wb.noteColor, content: "" },
      });
      renderItem(item); wb.undo.push(item.id);
      setMode("move");
      const node = canvas.querySelector(`.wb-note[data-id="${item.id}"]`);
      if (node) editNote(item.id, node);
    } catch (err) { toast(err.message, "error"); }
  }

  async function createTextAt(p) {
    try {
      const item = await api("/board", {
        method: "POST",
        body: { kind: "text", x: p.x, y: p.y, w: wb.textSize, color: wb.drawColor, content: "" },
      });
      renderItem(item); wb.undo.push(item.id);
      setMode("move");
      const node = canvas.querySelector(`.wb-text[data-id="${item.id}"]`);
      if (node) editText(item.id, node);
    } catch (err) { toast(err.message, "error"); }
  }

  /* -- dibujo libre (lápiz / marcador) y formas -- */

  function startStroke(e, p) {
    const width = strokeWidth();
    const color = wb.mode === "marker" ? markerColor(wb.drawColor) : wb.drawColor;
    const pl = document.createElementNS(SVGNS, "polyline");
    pl.style.fill = "none";
    pl.style.stroke = color;
    pl.style.strokeWidth = width + "px";
    if (wb.mode === "marker") pl.style.strokeLinecap = "round";
    svg.appendChild(pl);
    wb.drawing = { kind: "stroke", color, width, points: [[Math.round(p.x), Math.round(p.y)]], node: pl };
    canvas.setPointerCapture(e.pointerId);
  }

  function startShape(e, p) {
    const t = wb.mode, sw = wb.shapeSize;
    const tag = t === "rect" ? "rect" : t === "ellipse" ? "ellipse" : "path";
    const el = document.createElementNS(SVGNS, tag);
    el.style.fill = "none";
    el.style.stroke = wb.drawColor;
    el.style.strokeWidth = sw + "px";
    svg.appendChild(el);
    wb.drawing = { kind: "shape", t, sw, color: wb.drawColor, x: p.x, y: p.y, x2: p.x, y2: p.y, node: el };
    canvas.setPointerCapture(e.pointerId);
  }

  async function finishStroke(d) {
    if (d.points.length < 2) { d.node.remove(); return; }
    try {
      const item = await api("/board", {
        method: "POST",
        body: { kind: "stroke", color: d.color, w: d.width, content: JSON.stringify(d.points) },
      });
      d.node.remove();
      renderItem(item); wb.undo.push(item.id);
    } catch (err) { d.node.remove(); toast(err.message, "error"); }
  }

  async function finishShape(d) {
    const w = d.x2 - d.x, h = d.y2 - d.y;
    if (Math.abs(w) < 4 && Math.abs(h) < 4) { d.node.remove(); return; }
    try {
      const item = await api("/board", {
        method: "POST",
        body: { kind: "shape", x: d.x, y: d.y, w, h, color: d.color, content: JSON.stringify({ t: d.t, sw: d.sw }) },
      });
      d.node.remove();
      renderItem(item); wb.undo.push(item.id);
    } catch (err) { d.node.remove(); toast(err.message, "error"); }
  }

  /* -- borrador (arrastrar para borrar; hitbox amplia por muestreo) -- */

  function moveEraserCursor(e) {
    const cur = $("#wb-cursor");
    const box = $(".wb-screen").getBoundingClientRect();
    const d = WB_ERASER_R * 2 * wb.zoom;
    cur.style.width = cur.style.height = d + "px";
    cur.style.left = (e.clientX - box.left) + "px";
    cur.style.top = (e.clientY - box.top) + "px";
  }

  function eraseAt(clientX, clientY, done) {
    const r = WB_ERASER_R * wb.zoom;
    const offs = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r],
      [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]];
    const hit = new Set();
    for (const [dx, dy] of offs) {
      for (const el of document.elementsFromPoint(clientX + dx, clientY + dy)) {
        const owner = el.closest && el.closest("[data-id]");
        if (owner && (canvas.contains(owner) || svg.contains(owner))) {
          const id = +owner.dataset.id;
          if (wb.items.has(id)) hit.add(id);
        }
      }
    }
    for (const id of hit) if (!done.has(id)) { done.add(id); deleteItem(id); }
  }

  function startErasing(e) {
    canvas.setPointerCapture?.(e.pointerId);
    const done = new Set();
    const step = ev => {
      if (pinch.active) return; // el gesto de dos dedos manda
      moveEraserCursor(ev); eraseAt(ev.clientX, ev.clientY, done);
    };
    step(e);
    const onUp = ev => {
      canvas.removeEventListener("pointermove", step);
      canvas.removeEventListener("pointerup", onUp);
      try { canvas.releasePointerCapture(ev.pointerId); } catch {}
    };
    canvas.addEventListener("pointermove", step);
    canvas.addEventListener("pointerup", onUp);
  }

  /* -- desplazamiento del lienzo (herramienta Seleccionar sobre zona vacía) -- */

  function startPan(e) {
    const sx = e.clientX, sy = e.clientY, sl = wrap.scrollLeft, st = wrap.scrollTop;
    canvas.classList.add("panning");
    const onMove = ev => {
      if (pinch.active) return; // el gesto de dos dedos manda
      wrap.scrollLeft = sl - (ev.clientX - sx);
      wrap.scrollTop = st - (ev.clientY - sy);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      canvas.classList.remove("panning");
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /* -- eventos del lienzo -- */

  /* Pellizco con dos dedos: zoom + desplazamiento en un solo gesto. Se apoya
     en touch-action: none (el navegador no scrollea ni zoomea la página).
     El punto lógico bajo el centro de los dedos queda anclado y sigue al
     punto medio: la misma cuenta que setZoom(), con ancla fija por gesto. */
  const pinch = { pts: new Map(), active: false, startDist: 1, startZoom: 1, anchor: null };
  const pinchMid = () => {
    const [a, b] = [...pinch.pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const pinchDist = () => {
    const [a, b] = [...pinch.pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };
  const endPinchPointer = e => {
    if (!pinch.pts.delete(e.pointerId)) return;
    if (pinch.active && pinch.pts.size < 2) {
      pinch.active = false;
      pinch.pts.clear(); // el dedo restante no dibuja hasta un nuevo pointerdown
    }
  };

  canvas.addEventListener("pointerdown", e => {
    if (e.pointerType === "touch") {
      pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.pts.size === 2) {
        // Baja el segundo dedo: se descarta el trazo en curso y empieza el gesto.
        if (wb.drawing) { wb.drawing.node.remove(); wb.drawing = null; }
        pinch.active = true;
        pinch.startDist = pinchDist();
        pinch.startZoom = wb.zoom;
        const m = pinchMid(), r = canvas.getBoundingClientRect();
        pinch.anchor = { x: (m.x - r.left) / wb.zoom, y: (m.y - r.top) / wb.zoom };
        return;
      }
      if (pinch.active) return; // tercer dedo y siguientes: se ignoran
    }
    if (wb.mode === "erase") { startErasing(e); return; }
    if (e.target !== canvas && e.target !== svg) return;   // crear sólo sobre zona vacía
    const p = canvasPoint(e);
    if (wb.mode === "move") return startPan(e);
    if (wb.mode === "note") return createNoteAt(p);
    if (wb.mode === "text") return createTextAt(p);
    if (wb.mode === "pen" || wb.mode === "marker") return startStroke(e, p);
    if (WB_SHAPES.has(wb.mode)) return startShape(e, p);
  });

  canvas.addEventListener("pointermove", e => {
    if (pinch.pts.has(e.pointerId)) {
      pinch.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch.active && pinch.pts.size >= 2) {
        const z = clamp(pinch.startZoom * (pinchDist() / pinch.startDist), 0.25, 3);
        wb.zoom = z;
        canvas.style.transform = `scale(${z})`;
        const m = pinchMid(), wr = wrap.getBoundingClientRect();
        wrap.scrollLeft = pinch.anchor.x * z - (m.x - wr.left);
        wrap.scrollTop = pinch.anchor.y * z - (m.y - wr.top);
        $("#wb-zoom-label").textContent = Math.round(z * 100) + "%";
        return;
      }
    }
    if (pinch.active) return;
    if (wb.mode === "erase") moveEraserCursor(e);
    const d = wb.drawing; if (!d) return;
    const p = canvasPoint(e);
    if (d.kind === "stroke") {
      const last = d.points[d.points.length - 1];
      if (Math.abs(p.x - last[0]) + Math.abs(p.y - last[1]) < 2) return;
      d.points.push([Math.round(p.x), Math.round(p.y)]);
      d.node.setAttribute("points", d.points.map(q => q.join(",")).join(" "));
    } else if (d.kind === "shape") {
      d.x2 = p.x; d.y2 = p.y;
      setShapeGeometry(d.node, d.t, d.x, d.y, d.x2, d.y2);
    }
  });

  canvas.addEventListener("pointerup", e => {
    endPinchPointer(e);
    const d = wb.drawing; if (!d) return;
    wb.drawing = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    if (d.kind === "stroke") finishStroke(d);
    else if (d.kind === "shape") finishShape(d);
  });

  canvas.addEventListener("pointercancel", e => {
    endPinchPointer(e);
    const d = wb.drawing; if (!d) return;
    wb.drawing = null;
    d.node.remove(); // gesto interrumpido por el sistema: se descarta el trazo
  });

  /* -- subida de imágenes -- */

  $("#wb-file").onchange = async e => {
    const file = e.target.files[0];
    e.target.value = "";
    setMode("move");
    if (!file) return;
    try {
      const form = new FormData();
      form.append("image", file, file.name);
      const { url } = await api("/board/image", { method: "POST", body: form });
      const item = await api("/board", {
        method: "POST",
        body: {
          kind: "image", content: url, w: 360,
          x: wrap.scrollLeft / wb.zoom + 80, y: wrap.scrollTop / wb.zoom + 80,
        },
      });
      renderItem(item); wb.undo.push(item.id);
      toast("Imagen añadida", "ok");
    } catch (err) { toast(err.message, "error"); }
  };

  /* -- deshacer y limpiar todo -- */

  async function undoLast() {
    while (wb.undo.length) {
      const id = wb.undo.pop();
      if (wb.items.has(id)) { deleteItem(id); return; }
    }
    toast("Nada que deshacer");
  }

  function clearBoard() {
    wb.items.clear();
    wb.undo.length = 0;
    svg.innerHTML = "";
    $$(".wb-note, .wb-img, .wb-text", canvas).forEach(n => n.remove());
  }

  $("#wb-undo").onclick = undoLast;
  $("#wb-clear").onclick = () => {
    if (!wb.items.size) { toast("La pizarra ya está vacía"); return; }
    confirmModal({
      title: "Limpiar toda la pizarra",
      body: "Se eliminarán todas las notas, dibujos, formas e imágenes para todo el equipo. Esta acción no se puede deshacer.",
      confirm: "Limpiar todo",
      onConfirm: async () => {
        try { await api("/board", { method: "DELETE" }); clearBoard(); toast("Pizarra vaciada", "ok"); }
        catch (err) { toast(err.message, "error"); }
      },
    });
  };

  /* -- zoom -- */

  function setZoom(z, px, py) {
    z = clamp(z, 0.25, 3);
    const rect = canvas.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cx = px ?? (wr.left + wrap.clientWidth / 2);
    const cy = py ?? (wr.top + wrap.clientHeight / 2);
    const lx = (cx - rect.left) / wb.zoom, ly = (cy - rect.top) / wb.zoom;
    wb.zoom = z;
    canvas.style.transform = `scale(${z})`;
    wrap.scrollLeft = lx * z - (cx - wr.left);
    wrap.scrollTop = ly * z - (cy - wr.top);
    $("#wb-zoom-label").textContent = Math.round(z * 100) + "%";
  }
  $("#wb-zoom-in").onclick = () => setZoom(wb.zoom * 1.2);
  $("#wb-zoom-out").onclick = () => setZoom(wb.zoom / 1.2);
  $("#wb-zoom-label").onclick = () => setZoom(1);
  wrap.addEventListener("wheel", e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(wb.zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX, e.clientY);
  }, { passive: false });

  /* -- herramientas + atajos de teclado -- */

  $$(".wb-tool").forEach(b => (b.onclick = () => setMode(b.dataset.mode)));

  if (state.wbKey) document.removeEventListener("keydown", state.wbKey);
  state.wbKey = e => {
    if (state.view !== "whiteboard" || !state.wb) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undoLast(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tool = WB_TOOLS.find(x => x.key.toLowerCase() === e.key.toLowerCase());
    if (tool) { e.preventDefault(); setMode(tool.mode); }
  };
  document.addEventListener("keydown", state.wbKey);

  // Puente para los cambios que llegan por WebSocket de otros usuarios.
  wb.render = renderItem;
  wb.removeItem = id => { wb.items.delete(id); removeNode(id); };
  wb.clearBoard = clearBoard;

  renderOptions();
  items.forEach(renderItem);
}

/* Cambios de otros usuarios llegan por WebSocket y se aplican en sitio,
   sin re-renderizar toda la vista (así no hay parpadeo ni animación). */
function wbApply(data) {
  if (!data || !state.wb) return;
  const wb = state.wb;
  if (data.action === "clear") { wb.clearBoard(); return; }
  if (data.action === "delete") { wb.removeItem(data.id); return; }
  if (data.action === "upsert" && data.item) {
    const el = document.querySelector(`[data-id="${data.item.id}"]`);
    const editing = el && el.contains(document.activeElement) &&
      document.activeElement.isContentEditable;
    if (!editing) wb.render(data.item);
  }
}

/* ---------- transcripciones + API ---------- */

let recorder = null;
let recChunks = [];
let recTimer = null;

async function renderTranscripts() {
  const seq = ++state.renderSeq;
  const [items, tokens] = await Promise.all([api("/transcripts"), api("/tokens")]);
  if (seq !== state.renderSeq || state.view !== "transcripts") return;
  const apiBase = API_BASE || location.origin;

  $("#main").innerHTML = `<div class="view">
    <div class="view-head">
      <div><h2>Transcripciones</h2>
      <div class="view-sub">Graba desde el navegador; el audio se transcribe en vuestro propio servidor</div></div>
    </div>
    <div class="panel-card rec-card">
      <button class="rec-btn" id="rec-btn" title="Grabar">${MIC_SVG}</button>
      <div class="rec-status" id="rec-status">PULSA PARA GRABAR</div>
      <div class="rec-hint">También puedes dictar en cualquier app de tu PC con Lince Dictado (mantén F9).</div>
    </div>
    ${items.map(ts => `
      <div class="panel-card ts-card" data-id="${ts.id}">
        <div class="ts-head">
          ${avatarHtml(ts.author || "?")}
          <span class="who">${esc(ts.author || "Desconocido")}</span>
          <span class="meta">${timeAgo(ts.created_at)}${ts.language ? ` · ${esc(ts.language)}` : ""}${ts.duration ? ` · ${Math.round(ts.duration)}s` : ""}</span>
        </div>
        <div class="ts-text">${esc(ts.text)}</div>
        <div class="ts-actions">
          <button class="btn-ghost btn-small act-copy">Copiar</button>
          <button class="btn-ghost btn-small act-task">Crear tarea</button>
          ${(ts.user_id === state.me.id || state.me.role === "admin") ? `<button class="btn-ghost btn-small btn-danger act-del">Borrar</button>` : ""}
        </div>
      </div>`).join("") || `<div class="empty">Aún no hay transcripciones. ¡Graba la primera!</div>`}

    <div class="panel-card" style="margin-top:24px">
      <h3>Acceso por API — n8n, scripts</h3>
      <p style="font-size:14px;color:var(--sage);margin-bottom:4px">
        Crea un token personal y úsalo desde n8n (nodo HTTP Request) o cualquier
        herramienta para transcribir audio contra este servidor. Solo los miembros
        aprobados del equipo pueden tener tokens.
      </p>
      <div id="token-reveal-slot"></div>
      ${tokens.map(t => `
        <div class="token-row" data-id="${t.id}">
          <span class="grow"><strong>${esc(t.name)}</strong> <span class="meta">${esc(t.prefix)} · ${timeAgo(t.created_at)}</span></span>
          <button class="btn-ghost btn-small btn-danger tk-del">Revocar</button>
        </div>`).join("")}
      <div class="inline-form">
        <input id="tk-name" class="field-input" placeholder="Nombre del token (p. ej. n8n)">
        <button class="btn-primary btn-small" id="tk-create">Crear token</button>
      </div>
      <div class="api-example">POST ${esc(apiBase)}/api/transcribe
Authorization: Bearer lince_************
Content-Type: multipart/form-data   →   campo "audio" = archivo

Respuesta: { "text": "...", "language": "es", "duration": 12.4 }

n8n → HTTP Request: Method POST · Body "Form-Data" · campo binario "audio"
       Header Authorization = "Bearer &lt;tu token&gt;"</div>
    </div>
  </div>`;

  $("#rec-btn").onclick = toggleRecording;

  $$(".ts-card").forEach(card => {
    const id = card.dataset.id;
    const text = $(".ts-text", card).textContent;
    $(".act-copy", card).onclick = async () => {
      await navigator.clipboard.writeText(text);
      toast("Copiado al portapapeles", "ok");
    };
    $(".act-task", card).onclick = async () => {
      try {
        await api(`/transcripts/${id}/to-task`, { method: "POST", body: {} });
        toast("Tarea creada — asígnala desde el tablero", "ok");
      } catch (err) { toast(err.message, "error"); }
    };
    const del = $(".act-del", card);
    if (del) del.onclick = async () => {
      try {
        await api(`/transcripts/${id}`, { method: "DELETE" });
        renderTranscripts();
      } catch (err) { toast(err.message, "error"); }
    };
  });

  $("#tk-create").onclick = async () => {
    try {
      const created = await api("/tokens", {
        method: "POST",
        body: { name: $("#tk-name").value || "token" },
      });
      $("#token-reveal-slot").innerHTML = `
        <div class="token-reveal">
          <span class="label">Token creado — cópialo ahora, no se volverá a mostrar</span>
          <code id="tk-raw">${esc(created.token)}</code>
          <button class="btn-primary btn-small" id="tk-copy">Copiar token</button>
        </div>`;
      $("#tk-copy").onclick = async () => {
        await navigator.clipboard.writeText(created.token);
        toast("Token copiado", "ok");
      };
    } catch (err) { toast(err.message, "error"); }
  };

  $$(".tk-del").forEach(b => b.onclick = async () => {
    try {
      await api(`/tokens/${b.closest(".token-row").dataset.id}`, { method: "DELETE" });
      toast("Token revocado", "ok");
      renderTranscripts();
    } catch (err) { toast(err.message, "error"); }
  });
}

async function toggleRecording() {
  const btn = $("#rec-btn");
  const status = $("#rec-status");

  if (recorder && recorder.state === "recording") {
    recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find(m => MediaRecorder.isTypeSupported(m)) || "";
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    recChunks = [];
    recorder.ondataavailable = e => e.data.size && recChunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recTimer);
      btn.classList.remove("recording");
      status.textContent = "TRANSCRIBIENDO…";
      btn.disabled = true;
      try {
        const ext = (recorder.mimeType || "").includes("mp4") ? "mp4" : "webm";
        const form = new FormData();
        form.append("audio", new Blob(recChunks, { type: recorder.mimeType }), `rec.${ext}`);
        await api("/transcribe", { method: "POST", body: form });
        toast("Transcripción lista", "ok");
        renderTranscripts();
      } catch (err) {
        toast(err.message, "error");
        status.textContent = "PULSA PARA GRABAR";
      } finally {
        btn.disabled = false;
      }
    };
    recorder.start();
    btn.classList.add("recording");
    const t0 = Date.now();
    recTimer = setInterval(() => {
      status.textContent = `GRABANDO ${Math.floor((Date.now() - t0) / 1000)}s — PULSA PARA TERMINAR`;
    }, 250);
    status.textContent = "GRABANDO — PULSA PARA TERMINAR";
  } catch (err) {
    toast(`No se pudo acceder al micrófono: ${err.message}`, "error");
  }
}

/* ---------- metadatos de proveedores (iconos de los adjuntos de tareas) ----------
   La configuración de integraciones vive ahora en Startup OS; Teams solo las
   USA (adjuntos en tareas), así que acá solo queda el mapa de iconos/color. */

const INTEGRATION_META = {
  github: {
    label: "GitHub",
    icon: `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`,
    accent: "--ink",
  },
  google_drive: {
    label: "Google Drive",
    icon: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.71 3.5 1.15 15l3.29 5.5 6.56-11.34zM22.85 15 16.29 3.5H9.71l6.56 11.5zM5.29 21h13.42l3.14-5.5H8.43z"/></svg>`,
    accent: "--chart-done",
  },
  other: {
    label: "Otras herramientas",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
    accent: "--moss",
  },
};
/* ---------- equipo (solo admin) ---------- */

async function renderTeam() {
  const seq = ++state.renderSeq;
  let members;
  try { members = await api("/admin/members"); }
  catch (err) { toast(err.message, "error"); return; }
  if (seq !== state.renderSeq || state.view !== "team") return;

  const pending = members.filter(m => m.status === "pending");
  const active = members.filter(m => m.status === "active");

  $("#main").innerHTML = `<div class="view">
    <div class="view-head">
      <div><h2>Equipo</h2>
      <div class="view-sub">Solo las cuentas que apruebes pueden usar Lince Teams y la API de transcripción</div></div>
    </div>

    ${pending.length ? `
    <div class="panel-card" style="margin-bottom:16px">
      <h3>Solicitudes pendientes <span class="badge badge-rust">${pending.length}</span></h3>
      ${pending.map(m => `
        <div class="token-row" data-id="${m.id}">
          ${avatarHtml(m.display_name)}
          <span class="grow"><strong>${esc(m.display_name)}</strong> <span class="meta">@${esc(m.username)} · ${timeAgo(m.created_at)}</span></span>
          <button class="btn-primary btn-small mb-approve">Aprobar</button>
          <button class="btn-ghost btn-small btn-danger mb-reject">Rechazar</button>
        </div>`).join("")}
    </div>` : ""}

    <div class="panel-card">
      <h3>Miembros</h3>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Alta</th><th>Acciones</th></tr></thead>
          <tbody>
            ${active.map(m => `
            <tr data-id="${m.id}">
              <td>${esc(m.display_name)}${m.id === state.me.id ? ` <span class="meta">(tú)</span>` : ""}</td>
              <td class="meta">@${esc(m.username)}</td>
              <td><span class="badge ${m.role === "admin" ? "badge-rust" : "badge-moss"}">${m.role === "admin" ? "Admin" : "Miembro"}</span></td>
              <td class="meta">${timeAgo(m.created_at)}</td>
              <td>${m.id === state.me.id ? "" : `
                <div class="member-actions">
                  <button class="btn-ghost btn-small mb-role" data-role="${m.role === "admin" ? "member" : "admin"}">
                    ${m.role === "admin" ? "Quitar admin" : "Hacer admin"}</button>
                  <button class="btn-ghost btn-small mb-revoke">Revocar acceso</button>
                  <button class="btn-ghost btn-small btn-danger mb-delete">Eliminar</button>
                </div>`}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;

  const act = async (id, fn) => {
    try { await fn(); renderTeam(); } catch (err) { toast(err.message, "error"); }
  };
  $$(".mb-approve").forEach(b => b.onclick = () => {
    const id = b.closest("[data-id]").dataset.id;
    act(id, () => api(`/admin/members/${id}`, { method: "PATCH", body: { status: "active" } }));
  });
  $$(".mb-reject").forEach(b => b.onclick = () => {
    const id = b.closest("[data-id]").dataset.id;
    act(id, () => api(`/admin/members/${id}`, { method: "DELETE" }));
  });
  $$(".mb-role").forEach(b => b.onclick = () => {
    const id = b.closest("[data-id]").dataset.id;
    act(id, () => api(`/admin/members/${id}`, { method: "PATCH", body: { role: b.dataset.role } }));
  });
  $$(".mb-revoke").forEach(b => b.onclick = () => {
    const id = b.closest("[data-id]").dataset.id;
    act(id, () => api(`/admin/members/${id}`, { method: "PATCH", body: { status: "pending" } }));
  });
  $$(".mb-delete").forEach(b => b.onclick = () => {
    const id = b.closest("[data-id]").dataset.id;
    if (!confirm("¿Eliminar esta cuenta? Sus tareas quedarán sin asignar.")) return;
    act(id, () => api(`/admin/members/${id}`, { method: "DELETE" }));
  });
}

/* ---------- boot ---------- */

$$(".nav-item").forEach(b => (b.onclick = () => showView(b.dataset.view)));
$("#btn-logout").onclick = async () => {
  if (state.supabase) {
    await state.supabase.auth.signOut();
    goToLogin();
    return;
  }
  try { await api("/logout", { method: "POST" }); } catch {}
  logoutLocal();
};

/* El acceso se resuelve según /api/config: modo unificado (JWT de Supabase,
   login compartido con el panel) o standalone (login usuario/contraseña). */
(async () => {
  let cfg = { supabase: false };
  try { cfg = await (await fetch(`${API_BASE}/api/config`)).json(); } catch {}
  state.cfg = cfg;

  if (cfg.supabase && window.supabase && window.supabase.createClient) {
    await bootSupabase(cfg);
    return;
  }

  // Standalone: login propio.
  setupAuth();
  if (state.token) {
    try { await enterApp(); return; } catch { logoutLocal(); }
  }
  $("#auth-screen").classList.remove("hidden");
})();

/* Modo unificado: la sesión se comparte con el panel /admin (mismo origen,
   mismo proyecto de Supabase). Sin sesión, se redirige al login del panel. */
async function bootSupabase(cfg) {
  state.supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  let entering = false;
  const onSession = async (session) => {
    if (!session) { state.me = null; goToLogin(); return; }
    if (state.me || entering) return; // ya dentro (refresh de token): no re-montar
    entering = true;
    try {
      await enterApp();
    } catch (err) {
      // Logueado pero sin acceso a Teams (403), o error transitorio.
      $("#app").classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
      $("#auth-screen").innerHTML =
        `<div class="auth-card card-featured" style="text-align:center">
           <div class="auth-brand">Lince <em>Teams</em></div>
           <p class="auth-notice" style="margin-top:16px">${esc(err.message || "No se pudo cargar tu sesión.")}</p>
           <a class="btn-ghost btn-block" href="${(cfg.loginUrl || "/admin")}" style="margin-top:16px;display:inline-block">Ir al panel</a>
         </div>`;
    } finally {
      entering = false;
    }
  };

  // Reacciona a login/logout/refresh igual que el Startup OS. Se difiere con
  // setTimeout: supabase-js espera el callback antes de resolver getSession().
  state.supabase.auth.onAuthStateChange((_event, session) => {
    if (_event === "TOKEN_REFRESHED" && state.me) return; // ya montado; el token se toma fresco
    setTimeout(() => onSession(session), 0);
  });
}
