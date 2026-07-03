"""Local speech-to-text via faster-whisper (CTranslate2). The model is
downloaded from Hugging Face on first use and cached; after that everything
runs offline."""

import numpy as np
from faster_whisper import WhisperModel

from .config import Config


class Transcriber:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.model = WhisperModel(
            cfg.model, device=cfg.device, compute_type=cfg.compute_type
        )

    def warm_up(self) -> None:
        """Run a throwaway transcription so the first real one isn't slow."""
        silence = np.zeros(16000, dtype=np.float32)  # 1 second
        segments, _ = self.model.transcribe(silence)
        list(segments)  # segments are lazy; consume to actually run the model

    def transcribe(self, audio: np.ndarray) -> str:
        segments, _info = self.model.transcribe(
            audio,
            language=self.cfg.language,
            beam_size=self.cfg.beam_size,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()
