# WhisperFlow

A private, self-hosted alternative to [Wispr Flow](https://wisprflow.ai/) with
two components sharing the same local speech-to-text engine
([faster-whisper](https://github.com/SYSTRAN/faster-whisper)):

1. **Desktop dictation** — hold a key, speak, release, and clean text appears
   at your cursor in whatever app you're using. 100% on-device.
2. **WhisperFlow Teams** (`server/`) — a self-hosted web workspace for your
   team: interactive dashboard, kanban board with drag & drop, and shared
   voice transcriptions recorded from the browser and transcribed **on your
   own server**. Real-time sync over WebSocket so several teammates can work
   at once. No account, no subscription, no telemetry.

## How it mirrors Wispr Flow's architecture

| Wispr Flow stage            | This app                                       |
| --------------------------- | ---------------------------------------------- |
| Global push-to-talk hotkey  | `keyboard` hook (hold **F9**, or **F10** toggle) |
| Mic capture                 | `sounddevice`, 16 kHz mono                     |
| Cloud ASR (requires internet) | **Local** Whisper model via faster-whisper   |
| AI formatting / fillers / dictionary | Local regex cleanup + personal dictionary |
| Text injection at cursor    | Clipboard paste (Ctrl+V) or simulated typing   |

## Setup

```
install.bat
run.bat --check   # optional: verifies mic, model, clipboard
run.bat
```

The first run downloads the Whisper model from Hugging Face (~460 MB for
`small`) and caches it locally — that is the only time the app touches the
network. Your audio and text never do.

## Usage

- **Hold F9**, speak, release. Text is typed into the focused app.
- **F10** toggles hands-free recording on/off (for longer dictation).
- Keep the console window running (minimized is fine). Ctrl+C quits.

## Configuration (`config.json`, created on first run)

| Key | Default | Notes |
| --- | --- | --- |
| `hotkey` | `f9` | Push-to-talk key (single key). |
| `toggle_hotkey` | `f10` | Start/stop toggle; combos allowed (`ctrl+alt+d`). |
| `model` | `small` | `tiny`/`base` = faster, `medium`/`large-v3-turbo` = more accurate. English-only variants (`small.en`) are faster for English. |
| `language` | `null` | Auto-detect. Set `"es"` or `"en"` to lock it (faster, more accurate). |
| `device` | `auto` | Uses NVIDIA GPU if available, else CPU. |
| `beam_size` | `1` | Raise to 5 for a bit more accuracy at the cost of speed. |
| `injection` | `paste` | `type` avoids touching the clipboard but is slower. |
| `restore_clipboard` | `true` | Restores previous clipboard text after pasting. Non-text clipboard content (e.g. images) can't be restored. |
| `remove_fillers` | `true` | Strips um/uh/hmm etc. |
| `extra_fillers` | `[]` | Add your own, e.g. `["este", "o sea"]`. |
| `dictionary` | `{}` | Phrase fixes, e.g. `{"cloud code": "Claude Code"}`. |

## Model guide

| Model | Download | CPU speed | Quality |
| --- | --- | --- | --- |
| `tiny` | 75 MB | instant | rough |
| `base` | 145 MB | very fast | okay |
| `small` (default) | 460 MB | fast | good |
| `medium` | 1.5 GB | slow on CPU | very good |
| `large-v3-turbo` | 1.6 GB | usable on CPU, great on GPU | best |

## WhisperFlow Teams (web workspace)

```
install.bat          # same venv covers desktop + server
run_server.bat       # serves http://localhost:8000
```

Open http://localhost:8000, create an account, and you get:

- **Panel** — task stats, team workload, your pending tasks, live activity feed.
- **Tablero** — kanban board (Por hacer / En curso / Hecho) with drag & drop,
  priorities, assignees, and due dates.
- **Transcripciones** — record from the browser mic; audio is transcribed by
  the same local Whisper model on the server, shared with the team, and can be
  turned into a task with one click.

Everything updates in real time for all connected users via WebSocket.
Data lives in `data/whisperflow.db` (SQLite) — back up that one file.

### Using it with your team

- **Same office/LAN:** run `run_server.bat` and teammates open
  `http://<your-ip>:8000` (allow port 8000 in Windows Firewall).
  For remote teammates without a server, [Tailscale](https://tailscale.com/)
  gives everyone secure access to that same URL.
- **On a server (Docker):**

  ```
  docker compose up -d --build
  ```

  Works on any VPS or on platforms like Fly.io/Railway/Render (Dockerfile
  included). Give the container ~2 GB RAM for the `small` model. Put a reverse
  proxy with HTTPS in front (Caddy/Traefik) if it's exposed to the internet —
  the browser only allows microphone access on `localhost` or HTTPS.
- **Cloud (Supabase + Render + Vercel):** step-by-step guide in
  [DEPLOY.md](DEPLOY.md). Set `DATABASE_URL` and the backend switches from
  SQLite to Postgres automatically; `WF_CORS_ORIGINS` and
  `server/static/config.js` wire a separately-hosted frontend to the API.

## Privacy notes

- Audio is held in RAM only and discarded after transcription; in Teams the
  audio is processed on your server and only the text is stored.
- The only network access is the one-time model download. To hard-block even
  that after the first run, set the environment variable `HF_HUB_OFFLINE=1`.
