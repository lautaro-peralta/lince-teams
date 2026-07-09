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
  connectWs();
  showView(state.view);
}

const VIEWS = {
  dashboard: renderDashboard,
  board: renderBoard,
  whiteboard: renderWhiteboard,
  transcripts: renderTranscripts,
  team: renderTeam,
};

function showView(view) {
  if (view === "team" && (state.me.role !== "admin" || state.supabase)) view = "dashboard";
  if (state.view === "whiteboard" && view !== "whiteboard") state.wb = null;
  state.view = view;
  $$(".nav-item").forEach(b => {
    b.classList.toggle("active", b.dataset.view === view);
    b.setAttribute("aria-selected", b.dataset.view === view);
  });
  VIEWS[view]();
}

async function connectWs() {
  const base = API_BASE || location.origin;
  const tok = await currentToken();
  if (!tok) return;
  const ws = new WebSocket(base.replace(/^http/, "ws") + `/ws?token=${tok}`);
  state.ws = ws;
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
    if (msg.scope === "tasks" && (state.view === "board" || state.view === "dashboard")) showView(state.view);
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

async function renderBoard() {
  const seq = ++state.renderSeq;
  const tasks = await api("/tasks");
  if (seq !== state.renderSeq || state.view !== "board") return;
  $("#main").innerHTML = `<div class="view">
    <div class="view-head">
      <div><h2>Tablero</h2><div class="view-sub">Arrastra las tarjetas entre columnas; haz clic para editar o asignar</div></div>
      <button class="btn-primary" id="board-new-task">+ Nueva tarea</button>
    </div>
    <div class="board">
      ${["todo", "doing", "done"].map(s => column(s, tasks.filter(t => t.status === s))).join("")}
    </div>
  </div>`;

  $("#board-new-task").onclick = () => taskModal();

  $$(".task-card").forEach(card => {
    card.onclick = () => taskModal(tasks.find(t => t.id == card.dataset.id));
    card.ondragstart = e => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    };
    card.ondragend = () => card.classList.remove("dragging");
  });

  $$(".col").forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add("drag-over"); };
    col.ondragleave = () => col.classList.remove("drag-over");
    col.ondrop = async e => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      const task = tasks.find(t => t.id == id);
      if (!task || task.status === col.dataset.status) return;
      try {
        await api(`/tasks/${id}`, { method: "PATCH", body: { status: col.dataset.status } });
        renderBoard();
      } catch (err) { toast(err.message, "error"); }
    };
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
    <div class="task-card" draggable="true" data-id="${t.id}">
      <div class="title">${esc(t.title)}</div>
      ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ""}
      <div class="task-foot">
        <span class="badge ${PRIORITY_BADGE[t.priority]}">${PRIORITY_LABEL[t.priority]}</span>
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

/* ---------- pizarra colaborativa ---------- */

async function renderWhiteboard() {
  const seq = ++state.renderSeq;
  const items = await api("/board");
  if (seq !== state.renderSeq || state.view !== "whiteboard") return;

  $("#main").innerHTML = `<div class="view">
    <div class="view-head">
      <div><h2>Pizarra</h2>
      <div class="view-sub">Notas, dibujos e imágenes compartidos — todos ven los cambios al instante</div></div>
    </div>
    <div class="panel-card wb-toolbar">
      <button class="wb-tool active" data-mode="move">Mover</button>
      <button class="wb-tool" data-mode="note">Nota</button>
      <button class="wb-tool" data-mode="draw">Dibujar</button>
      <button class="wb-tool" data-mode="image">Imagen</button>
      <button class="wb-tool" data-mode="erase">Borrar</button>
      <span class="wb-sep"></span>
      <span id="wb-swatches"></span>
      <span class="wb-hint meta" id="wb-hint">Haz clic en una herramienta</span>
      <input type="file" id="wb-file" accept="image/png,image/jpeg,image/gif,image/webp" class="hidden">
    </div>
    <div class="wb-wrap" id="wb-wrap">
      <div class="wb-canvas mode-move" id="wb-canvas">
        <svg id="wb-svg" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </div>
  </div>`;

  state.wb = {
    mode: "move",
    noteColor: NOTE_COLORS[0],
    penColor: PEN_COLORS[0],
    items: new Map(),
    drawing: null,
  };
  const wb = state.wb;
  const canvas = $("#wb-canvas");
  const svg = $("#wb-svg");

  const HINTS = {
    move: "Arrastra notas e imágenes; doble clic en una nota para editarla",
    note: "Haz clic donde quieras crear la nota",
    draw: "Dibuja manteniendo pulsado el ratón",
    image: "Elige una imagen para subirla a la pizarra",
    erase: "Haz clic sobre un elemento para borrarlo",
  };

  function setMode(mode) {
    wb.mode = mode;
    canvas.className = `wb-canvas mode-${mode}`;
    $$(".wb-tool").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    $("#wb-hint").textContent = HINTS[mode];
    renderSwatches();
    if (mode === "image") $("#wb-file").click();
  }

  function renderSwatches() {
    const list = wb.mode === "draw" ? PEN_COLORS : NOTE_COLORS;
    const current = wb.mode === "draw" ? wb.penColor : wb.noteColor;
    $("#wb-swatches").innerHTML = list.map(c =>
      `<button class="wb-swatch ${c === current ? "active" : ""}" style="background:${c}" data-c="${c}" title="${c}"></button>`
    ).join("");
    $$(".wb-swatch").forEach(s => s.onclick = () => {
      if (wb.mode === "draw") wb.penColor = s.dataset.c;
      else wb.noteColor = s.dataset.c;
      renderSwatches();
    });
  }

  $$(".wb-tool").forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
  renderSwatches();
  $("#wb-hint").textContent = HINTS.move;

  const canvasPoint = e => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /* -- render de elementos -- */

  function renderItem(item) {
    wb.items.set(item.id, item);
    removeNode(item.id);
    if (item.kind === "stroke") {
      const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pl.setAttribute("points", JSON.parse(item.content || "[]").map(p => p.join(",")).join(" "));
      pl.setAttribute("style", `stroke:${item.color || "var(--ink)"}`);
      pl.dataset.id = item.id;
      pl.addEventListener("pointerdown", e => {
        if (wb.mode === "erase") { e.stopPropagation(); deleteItem(item.id); }
      });
      svg.appendChild(pl);
      return;
    }
    let node;
    if (item.kind === "note") {
      node = document.createElement("div");
      node.className = "wb-note";
      node.style.background = item.color || NOTE_COLORS[0];
      node.innerHTML = `<div class="wb-note-text"></div><span class="wb-author label"></span>`;
      $(".wb-note-text", node).textContent = item.content;
      $(".wb-author", node).textContent = item.author || "";
      node.ondblclick = () => {
        if (wb.mode !== "move") return;
        const t = $(".wb-note-text", node);
        t.contentEditable = "plaintext-only";
        t.focus();
        t.onblur = async () => {
          t.contentEditable = "false";
          const content = t.textContent;
          if (content !== item.content) {
            try { await api(`/board/${item.id}`, { method: "PATCH", body: { content } }); }
            catch (err) { toast(err.message, "error"); }
          }
        };
      };
    } else if (item.kind === "image") {
      node = document.createElement("img");
      node.className = "wb-img";
      node.src = (item.content.startsWith("/") ? API_BASE : "") + item.content;
      node.draggable = false;
      if (item.w) node.style.width = item.w + "px";
    } else return;

    node.style.left = item.x + "px";
    node.style.top = item.y + "px";
    node.dataset.id = item.id;
    node.addEventListener("pointerdown", e => itemPointerDown(e, item.id, node));
    canvas.appendChild(node);
  }

  function removeNode(id) {
    const old = canvas.querySelector(`[data-id="${id}"]`) || svg.querySelector(`[data-id="${id}"]`);
    if (old) old.remove();
  }

  async function deleteItem(id) {
    try { await api(`/board/${id}`, { method: "DELETE" }); }
    catch (err) { toast(err.message, "error"); }
  }

  /* -- arrastre de notas/imágenes -- */

  function itemPointerDown(e, id, node) {
    if (wb.mode === "erase") { e.stopPropagation(); deleteItem(id); return; }
    if (wb.mode !== "move") return;
    if (e.target.isContentEditable) return; // editando texto
    e.preventDefault(); e.stopPropagation();
    const start = canvasPoint(e);
    const origin = { x: parseFloat(node.style.left), y: parseFloat(node.style.top) };
    let moved = false;
    const onMove = ev => {
      const p = canvasPoint(ev);
      const nx = Math.max(0, origin.x + p.x - start.x);
      const ny = Math.max(0, origin.y + p.y - start.y);
      if (Math.abs(p.x - start.x) + Math.abs(p.y - start.y) > 3) moved = true;
      node.style.left = nx + "px";
      node.style.top = ny + "px";
    };
    const onUp = async () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (!moved) return;
      try {
        await api(`/board/${id}`, {
          method: "PATCH",
          body: { x: parseFloat(node.style.left), y: parseFloat(node.style.top) },
        });
      } catch (err) { toast(err.message, "error"); }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  /* -- interacción con el lienzo -- */

  canvas.addEventListener("pointerdown", async e => {
    if (e.target !== canvas && e.target !== svg) return;
    const p = canvasPoint(e);

    if (wb.mode === "note") {
      try {
        const item = await api("/board", {
          method: "POST",
          body: { kind: "note", x: p.x, y: p.y, color: wb.noteColor, content: "" },
        });
        renderItem(item);
        setMode("move");
        const node = canvas.querySelector(`[data-id="${item.id}"]`);
        if (node) node.dispatchEvent(new Event("dblclick"));
      } catch (err) { toast(err.message, "error"); }
      return;
    }

    if (wb.mode === "draw") {
      const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pl.setAttribute("style", `stroke:${wb.penColor}`);
      svg.appendChild(pl);
      wb.drawing = { points: [[Math.round(p.x), Math.round(p.y)]], node: pl };
      canvas.setPointerCapture(e.pointerId);
    }
  });

  canvas.addEventListener("pointermove", e => {
    if (!wb.drawing) return;
    const p = canvasPoint(e);
    const pts = wb.drawing.points;
    const last = pts[pts.length - 1];
    if (Math.abs(p.x - last[0]) + Math.abs(p.y - last[1]) < 3) return;
    pts.push([Math.round(p.x), Math.round(p.y)]);
    wb.drawing.node.setAttribute("points", pts.map(q => q.join(",")).join(" "));
  });

  canvas.addEventListener("pointerup", async () => {
    if (!wb.drawing) return;
    const { points, node } = wb.drawing;
    wb.drawing = null;
    if (points.length < 2) { node.remove(); return; }
    try {
      const item = await api("/board", {
        method: "POST",
        body: { kind: "stroke", color: wb.penColor, content: JSON.stringify(points) },
      });
      node.remove();
      renderItem(item);
    } catch (err) { node.remove(); toast(err.message, "error"); }
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
      const wrap = $("#wb-wrap");
      const item = await api("/board", {
        method: "POST",
        body: {
          kind: "image", content: url, w: 360,
          x: wrap.scrollLeft + 80, y: wrap.scrollTop + 80,
        },
      });
      renderItem(item);
      toast("Imagen añadida", "ok");
    } catch (err) { toast(err.message, "error"); }
  };

  items.forEach(renderItem);
}

/* Cambios de otros usuarios llegan por WebSocket y se aplican en sitio. */
function wbApply(data) {
  if (!data || !state.wb) return;
  const canvas = $("#wb-canvas"), svg = $("#wb-svg");
  if (!canvas) return;
  if (data.action === "delete") {
    state.wb.items.delete(data.id);
    const n = canvas.querySelector(`[data-id="${data.id}"]`) || svg.querySelector(`[data-id="${data.id}"]`);
    if (n) n.remove();
    return;
  }
  if (data.action === "upsert" && data.item) {
    // Evita pisar la nota mientras la estoy editando yo.
    const editing = document.activeElement?.isContentEditable &&
      document.activeElement.closest(`[data-id="${data.item.id}"]`);
    if (!editing) renderWhiteboardItem(data.item);
  }
}

// Puente: renderItem vive dentro de renderWhiteboard; lo reexponemos re-renderizando
// solo ese elemento con un mini-render equivalente.
function renderWhiteboardItem(item) {
  // Re-render the single item by delegating to the mounted view's logic:
  // simplest reliable route is a custom event the view listens to… but to keep
  // the code flat we re-run the same DOM logic here.
  const canvas = $("#wb-canvas"), svg = $("#wb-svg");
  if (!canvas || !state.wb) return;
  state.wb.items.set(item.id, item);
  const old = canvas.querySelector(`[data-id="${item.id}"]`) || svg.querySelector(`[data-id="${item.id}"]`);
  if (item.kind === "stroke") {
    if (old) { old.setAttribute("points", JSON.parse(item.content || "[]").map(p => p.join(",")).join(" ")); return; }
    // nuevo trazo de otro usuario: redibuja la vista completa de la pizarra
    showView("whiteboard");
    return;
  }
  if (!old) { showView("whiteboard"); return; }
  old.style.left = item.x + "px";
  old.style.top = item.y + "px";
  if (item.kind === "note") {
    const t = old.querySelector(".wb-note-text");
    if (t && t.textContent !== item.content) t.textContent = item.content;
    old.style.background = item.color || "";
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
