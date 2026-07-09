"""Microphone capture at 16 kHz mono, the sample rate Whisper expects."""

import numpy as np
import sounddevice as sd

SAMPLE_RATE = 16000


class Recorder:
    def __init__(self, device: int | str | None = None):
        self.device = device
        self._frames: list[np.ndarray] = []
        self._stream: sd.InputStream | None = None

    @property
    def recording(self) -> bool:
        return self._stream is not None

    def start(self) -> None:
        if self._stream is not None:
            return
        self._frames = []
        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            device=self.device,
            callback=self._callback,
        )
        self._stream.start()

    def _callback(self, indata, frames, time_info, status) -> None:
        self._frames.append(indata.copy())

    def stop(self) -> np.ndarray:
        """Stop capturing and return the recorded audio as float32 mono."""
        if self._stream is None:
            return np.zeros(0, dtype=np.float32)
        self._stream.stop()
        self._stream.close()
        self._stream = None
        if not self._frames:
            return np.zeros(0, dtype=np.float32)
        audio = np.concatenate(self._frames)[:, 0]
        self._frames = []
        return audio
