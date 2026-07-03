# WhisperFlow

A private, fully local clone of [Wispr Flow](https://wisprflow.ai/): hold a key,
speak, release — and clean text appears at your cursor in whatever app you're
using. Unlike Wispr Flow, **nothing ever leaves your machine**: speech
recognition runs locally with [faster-whisper](https://github.com/SYSTRAN/faster-whisper),
and cleanup is done with local rules. No account, no subscription, no telemetry.

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

## Privacy notes

- Audio is held in RAM only and discarded after transcription.
- The only network access is the one-time model download. To hard-block even
  that after the first run, set the environment variable `HF_HUB_OFFLINE=1`.
