"""Orchestrator: hotkeys -> record -> transcribe -> clean -> inject.

Recording is controlled from keyboard-hook callbacks; transcription and
injection run on a single worker thread so the hotkey stays responsive and
utterances are injected in order.
"""

import queue
import sys
import threading
import time

import keyboard
import numpy as np

from . import __version__
from .audio import SAMPLE_RATE, Recorder
from .cleanup import clean
from .config import CONFIG_PATH, Config
from .inject import inject
from .transcribe import Transcriber

try:
    import winsound
except ImportError:  # non-Windows
    winsound = None


def _log(msg: str) -> None:
    print(msg, flush=True)


class App:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.recorder = Recorder()
        self.transcriber: Transcriber | None = None
        self.jobs: queue.Queue[np.ndarray] = queue.Queue()
        self._lock = threading.Lock()

    # -- feedback ----------------------------------------------------------

    def _beep(self, freq: int) -> None:
        if self.cfg.beep and winsound is not None:
            threading.Thread(
                target=winsound.Beep, args=(freq, 70), daemon=True
            ).start()

    # -- recording control (called from keyboard hook threads) --------------

    def _start_recording(self) -> None:
        with self._lock:
            if self.recorder.recording:
                return
            try:
                self.recorder.start()
            except Exception as e:
                _log(f"[!] Could not open microphone: {e}")
                return
        self._beep(880)
        _log("[*] Recording... (release to transcribe)")

    def _stop_recording(self) -> None:
        with self._lock:
            if not self.recorder.recording:
                return
            audio = self.recorder.stop()
        self._beep(440)
        seconds = len(audio) / SAMPLE_RATE
        if seconds < self.cfg.min_recording_seconds:
            _log(f"[-] Too short ({seconds:.2f}s), ignored.")
            return
        _log(f"[*] Transcribing {seconds:.1f}s of audio...")
        self.jobs.put(audio)

    def _toggle(self) -> None:
        if self.recorder.recording:
            self._stop_recording()
        else:
            self._start_recording()

    # -- worker --------------------------------------------------------------

    def _worker(self) -> None:
        while True:
            audio = self.jobs.get()
            try:
                t0 = time.perf_counter()
                text = self.transcriber.transcribe(audio)
                text = clean(text, self.cfg)
                elapsed = time.perf_counter() - t0
                if not text:
                    _log(f"[-] Nothing recognized ({elapsed:.1f}s).")
                    continue
                inject(text, self.cfg)
                _log(f"[+] {text}  ({elapsed:.1f}s)")
            except Exception as e:
                _log(f"[!] Error: {e}")
            finally:
                self.jobs.task_done()

    # -- lifecycle ------------------------------------------------------------

    def run(self) -> None:
        _log(f"WhisperFlow v{__version__} — private, local dictation")
        _log(f"    config: {CONFIG_PATH}")
        _log(f"[*] Loading model '{self.cfg.model}' ({self.cfg.device})...")
        self.transcriber = Transcriber(self.cfg)
        self.transcriber.warm_up()
        _log("[+] Model ready.")

        threading.Thread(target=self._worker, daemon=True).start()

        keyboard.on_press_key(
            self.cfg.hotkey, lambda _: self._start_recording(), suppress=True
        )
        keyboard.on_release_key(
            self.cfg.hotkey, lambda _: self._stop_recording(), suppress=True
        )
        keyboard.add_hotkey(self.cfg.toggle_hotkey, self._toggle, suppress=True)

        _log(f"[+] Hold [{self.cfg.hotkey}] to dictate, or press "
             f"[{self.cfg.toggle_hotkey}] to toggle. Ctrl+C here to quit.")
        try:
            keyboard.wait()
        except KeyboardInterrupt:
            _log("\n[+] Bye.")
            sys.exit(0)
