/* Configuración del frontend.
 *
 * Si el backend (FastAPI) vive en otra URL — por ejemplo cuando el frontend
 * se sirve desde Vercel y la API desde Render — pon aquí la URL base:
 *
 *   window.LINCE_API_BASE = "https://lince-teams.onrender.com";
 *
 * Vacío = mismo origen (el propio servidor FastAPI sirve esta página).
 *
 * Modo unificado tras el reverse-proxy de Lince Automate (Teams servido en
 * /teams del mismo dominio que el panel): usá el prefijo de ruta, así el
 * frontend llama a /teams/api/... y /teams/ws.
 *
 *   window.LINCE_API_BASE = "/teams";
 */
window.LINCE_API_BASE = "/teams";
