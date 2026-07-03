/* WhisperFlow Teams — single-page client. Vanilla JS, no build step. */

"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const STATUS_LABEL = { todo: "Por hacer", doing: "En curso", done: "Hecho" };
const PRIORITY_LABEL = { low: "BAJA", medium: "MEDIA", high: "ALTA" };
// Backend en otro origen (Vercel + Render): se define en config.js
const API_BASE = (window.WF_API_BASE || "").replace(/\/$/, "");
const MIC_SVG = `<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`;

const state = {
  token: localStorage.getItem("wf_token"),
  me: null,
  users: [],
  view: "dashboard",
  ws: null,
  renderSeq: 0, // guards against a stale async render overwriting a newer view
};

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
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(ts)) return new Date(ts);
  return new Date(ts.replace(" ", "T") + "Z");
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
  if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(`${API_BASE}/api${path}`, { ...options, headers });
  if (res.status === 401 && path !== "/login") {
    logoutLocal();
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
    $("#field-display").classList.toggle("hidden", mode === "login");
    $("#auth-submit").textContent = mode === "login" ? "Entrar" : "Crear cuenta";
    $("#auth-error").textContent = "";
  };
  $("#tab-login").onclick = () => setMode("login");
  $("#tab-register").onclick = () => setMode("register");

  $("#auth-form").onsubmit = async e => {
    e.preventDefault();
    $("#auth-error").textContent = "";
    try {
      const body = {
        username: $("#in-username").value,
        password: $("#in-password").value,
        display_name: $("#in-display").value || undefined,
      };
      const data = await api(`/${authMode}`, { method: "POST", body });
      state.token = data.token;
      localStorage.setItem("wf_token", data.token);
      await enterApp();
    } catch (err) {
      $("#auth-error").textContent = err.message;
    }
  };
}

function logoutLocal() {
  state.token = null;
  state.me = null;
  localStorage.removeItem("wf_token");
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
  connectWs();
  showView(state.view);
}

function showView(view) {
  state.view = view;
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  ({ dashboard: renderDashboard, board: renderBoard, transcripts: renderTranscripts })[view]();
}

function connectWs() {
  const base = API_BASE || location.origin;
  const ws = new WebSocket(base.replace(/^http/, "ws") + `/ws?token=${state.token}`);
  state.ws = ws;
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== "changed") return;
    if (msg.by !== state.me.display_name) toast(`Actualizado por ${msg.by}`);
    if (msg.scope === "users") api("/users").then(u => (state.users = u));
    if (msg.scope === "tasks" && (state.view === "board" || state.view === "dashboard")) showView(state.view);
    if (msg.scope === "transcripts" && state.view === "transcripts") showView(state.view);
  };
  ws.onclose = () => setTimeout(() => state.token && connectWs(), 3000);
  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    else clearInterval(ping);
  }, 25000);
}

/* ---------- dashboard ---------- */

async function renderDashboard() {
  const seq = ++state.renderSeq;
  const d = await api("/dashboard");
  if (seq !== state.renderSeq) return;
  const total = d.counts.todo + d.counts.doing + d.counts.done;
  const today = new Date().toLocaleDateString("es", { weekday: "long", day: "numeric", month: "long" });
  const maxLoad = Math.max(1, ...d.per_user.map(u => u.open));

  $("#main").innerHTML = `
    <div class="view-head">
      <div>
        <h2>Hola, ${esc(state.me.display_name)}.</h2>
        <div class="view-sub">${esc(today)} — ${total} tareas en total</div>
      </div>
      <button class="btn btn-primary" id="dash-new-task">+ Nueva tarea</button>
    </div>
    <div class="stat-grid">
      ${stat(d.counts.todo, "POR HACER")}
      ${stat(d.counts.doing, "EN CURSO")}
      ${stat(d.counts.done, "HECHAS")}
      ${stat(d.transcripts, "TRANSCRIPCIONES")}
    </div>
    <div class="dash-cols">
      <div>
        <div class="card">
          <h3>Mis tareas pendientes</h3>
          ${d.mine.length ? d.mine.map(miniTask).join("") : `<div class="empty">Nada pendiente.</div>`}
        </div>
      </div>
      <div>
        <div class="card">
          <h3>Carga del equipo</h3>
          ${d.per_user.length ? d.per_user.map(u => `
            <div class="load-row">
              <span class="name">${esc(u.name)}</span>
              <div class="track"><div class="fill" style="width:${(u.open / maxLoad) * 100}%"></div></div>
              <span class="n">${u.open}</span>
            </div>`).join("") : `<div class="empty">Sin miembros aún.</div>`}
        </div>
        <div class="card">
          <h3>Actividad reciente</h3>
          ${d.activity.length ? d.activity.map(a => `
            <div class="feed-item"><span>${esc(a.text)}</span><span class="when">${timeAgo(a.created_at)}</span></div>
          `).join("") : `<div class="empty">Todavía no hay actividad.</div>`}
        </div>
      </div>
    </div>`;

  $("#dash-new-task").onclick = () => taskModal();
  $$(".mini-task[data-id]").forEach(el =>
    el.onclick = async () => taskModal(await api(`/tasks`).then(ts => ts.find(t => t.id == el.dataset.id))));

  function stat(num, label) {
    return `<div class="stat"><div class="lbl">${esc(label)}</div><div class="num">${num}</div></div>`;
  }
  function miniTask(t) {
    const due = t.due_date ? ` · vence ${t.due_date}` : "";
    return `<div class="mini-task" data-id="${t.id}" style="cursor:pointer">
      <span class="pill ${t.priority}">${PRIORITY_LABEL[t.priority]}</span>
      <span class="t">${esc(t.title)}</span>
      <span class="d">${STATUS_LABEL[t.status]}${esc(due)}</span>
    </div>`;
  }
}

/* ---------- board ---------- */

async function renderBoard() {
  const seq = ++state.renderSeq;
  const tasks = await api("/tasks");
  if (seq !== state.renderSeq) return;
  $("#main").innerHTML = `
    <div class="view-head">
      <div><h2>Tablero</h2><div class="view-sub">Arrastra las tarjetas entre columnas</div></div>
      <button class="btn btn-primary" id="board-new-task">+ Nueva tarea</button>
    </div>
    <div class="board">
      ${["todo", "doing", "done"].map(s => column(s, tasks.filter(t => t.status === s))).join("")}
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
        ${STATUS_LABEL[status].toUpperCase()} <span class="count">${items.length}</span>
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
        <span class="pill ${t.priority}">${PRIORITY_LABEL[t.priority]}</span>
        ${t.due_date ? `<span class="due ${late ? "late" : ""}">${late ? "VENCIDA " : ""}${t.due_date}</span>` : ""}
        ${avatarHtml(t.assignee_name)}
      </div>
    </div>`;
  }
}

/* ---------- task modal ---------- */

function taskModal(task = null) {
  const isEdit = !!task;
  $("#modal-root").innerHTML = `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <h3>${isEdit ? "Editar tarea" : "Nueva tarea"}</h3>
      <div class="field"><label>Título</label><input id="m-title" value="${esc(task?.title || "")}" placeholder="¿Qué hay que hacer?"></div>
      <div class="field"><label>Descripción</label><textarea id="m-desc" rows="3">${esc(task?.description || "")}</textarea></div>
      <div class="row2">
        <div class="field"><label>Estado</label>
          <select id="m-status">${Object.entries(STATUS_LABEL).map(([v, l]) =>
            `<option value="${v}" ${task?.status === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </div>
        <div class="field"><label>Prioridad</label>
          <select id="m-priority">${Object.entries(PRIORITY_LABEL).map(([v, l]) =>
            `<option value="${v}" ${(task?.priority || "medium") === v ? "selected" : ""}>${l}</option>`).join("")}</select>
        </div>
      </div>
      <div class="row2">
        <div class="field"><label>Asignada a</label>
          <select id="m-assignee">
            <option value="">Sin asignar</option>
            ${state.users.map(u => `<option value="${u.id}" ${task?.assignee_id === u.id ? "selected" : ""}>${esc(u.display_name)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Fecha límite</label><input id="m-due" type="date" value="${task?.due_date || ""}"></div>
      </div>
      <div class="modal-actions">
        ${isEdit ? `<button class="btn btn-danger" id="m-delete">Eliminar</button>` : ""}
        <div class="spacer"></div>
        <button class="btn" id="m-cancel">Cancelar</button>
        <button class="btn btn-primary" id="m-save">${isEdit ? "Guardar" : "Crear"}</button>
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

/* ---------- transcripts ---------- */

let recorder = null;
let recChunks = [];
let recTimer = null;

async function renderTranscripts() {
  const seq = ++state.renderSeq;
  const items = await api("/transcripts");
  if (seq !== state.renderSeq) return;
  $("#main").innerHTML = `
    <div class="view-head">
      <div><h2>Transcripciones</h2>
      <div class="view-sub">Graba desde el navegador; el audio se transcribe en vuestro propio servidor.</div></div>
    </div>
    <div class="rec-card">
      <button class="rec-btn" id="rec-btn" title="Grabar">${MIC_SVG}</button>
      <div class="rec-status" id="rec-status">PULSA PARA GRABAR</div>
      <div class="rec-hint">También puedes dictar en cualquier app de tu PC con la app de escritorio (mantén F9).</div>
    </div>
    ${items.map(ts => `
      <div class="card ts-card" data-id="${ts.id}">
        <div class="ts-head">
          ${avatarHtml(ts.author || "?")}
          <span class="who">${esc(ts.author || "Desconocido")}</span>
          <span class="meta">${timeAgo(ts.created_at)}${ts.language ? ` · ${esc(ts.language)}` : ""}${ts.duration ? ` · ${Math.round(ts.duration)}s` : ""}</span>
        </div>
        <div class="ts-text">${esc(ts.text)}</div>
        <div class="ts-actions">
          <button class="btn btn-small act-copy">Copiar</button>
          <button class="btn btn-small act-task">Crear tarea</button>
          ${ts.user_id === state.me.id ? `<button class="btn btn-small btn-danger act-del">Borrar</button>` : ""}
        </div>
      </div>`).join("") || `<div class="empty">Aún no hay transcripciones. ¡Graba la primera!</div>`}
  `;

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
        toast("Tarea creada desde la transcripción", "ok");
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

/* ---------- boot ---------- */

setupAuth();
$$(".nav-item").forEach(b => (b.onclick = () => showView(b.dataset.view)));
$("#btn-logout").onclick = async () => {
  try { await api("/logout", { method: "POST" }); } catch {}
  logoutLocal();
};

(async () => {
  if (state.token) {
    try { await enterApp(); return; } catch { logoutLocal(); }
  }
  $("#auth-screen").classList.remove("hidden");
})();
