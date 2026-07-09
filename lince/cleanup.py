"""Text cleanup: the local stand-in for Wispr Flow's AI formatting layer.
Whisper already produces punctuation and casing; this removes filler words
and applies the user's personal dictionary."""

import re

from .config import Config

_BASE_FILLERS = ["um+", "uh+", "uhm+", "erm+", "ehm+", "hmm+", "mmm+"]


def _filler_regex(cfg: Config) -> re.Pattern:
    extras = [re.escape(f) for f in cfg.extra_fillers]
    pattern = r"(?:^|(?<=[\s,]))(?:" + "|".join(_BASE_FILLERS + extras) + r")[,.]?(?=\s|$)"
    return re.compile(pattern, re.IGNORECASE)


def clean(text: str, cfg: Config) -> str:
    if cfg.remove_fillers:
        text = _filler_regex(cfg).sub("", text)

    for phrase, replacement in cfg.dictionary.items():
        text = re.sub(re.escape(phrase), replacement, text, flags=re.IGNORECASE)

    text = re.sub(r"\s+", " ", text)          # collapse runs of whitespace
    text = re.sub(r"\s+([,.!?;:])", r"\1", text)  # no space before punctuation
    text = re.sub(r"([,.!?])\1+", r"\1", text)    # dedupe punctuation left by fillers
    text = text.strip().lstrip(",.;: ")
    if text:
        text = text[0].upper() + text[1:]
    return text
