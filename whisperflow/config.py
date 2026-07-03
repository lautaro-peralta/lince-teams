"""Configuration: loads config.json from the project root, creating it with
defaults on first run so users have a file to edit."""

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"


@dataclass
class Config:
    # Hold this key to record, release to transcribe. Single key only.
    hotkey: str = "f9"
    # Press once to start recording, again to stop. May be a combo.
    toggle_hotkey: str = "f10"

    # faster-whisper model: tiny, base, small, medium, large-v3, large-v3-turbo,
    # distil-large-v3, or an English-only variant like small.en
    model: str = "small"
    # None = auto-detect per utterance; or fix it, e.g. "es" or "en"
    language: str | None = None
    device: str = "auto"          # auto / cpu / cuda
    compute_type: str = "auto"    # auto picks the fastest supported
    beam_size: int = 1            # 1 = fastest; 5 = slightly more accurate

    # "paste" (clipboard + Ctrl+V, fast and unicode-safe) or "type" (simulated keystrokes)
    injection: str = "paste"
    restore_clipboard: bool = True
    append_space: bool = True

    beep: bool = True
    min_recording_seconds: float = 0.3

    remove_fillers: bool = True
    extra_fillers: list[str] = field(default_factory=list)
    # Phrase replacements applied after transcription, case-insensitive keys.
    # Example: {"cloud code": "Claude Code"}
    dictionary: dict[str, str] = field(default_factory=dict)


def load() -> Config:
    if CONFIG_PATH.exists():
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        known = {f for f in Config.__dataclass_fields__}
        return Config(**{k: v for k, v in data.items() if k in known})
    cfg = Config()
    save(cfg)
    return cfg


def save(cfg: Config) -> None:
    CONFIG_PATH.write_text(
        json.dumps(asdict(cfg), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
