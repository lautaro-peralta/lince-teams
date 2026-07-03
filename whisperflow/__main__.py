"""Entry point: `python -m whisperflow` to run, `--check` for diagnostics."""

import argparse
import sys


def check() -> int:
    """Verify each pipeline stage without needing a hotkey press."""
    import numpy as np

    from . import config as config_mod
    from .cleanup import clean
    from .transcribe import Transcriber

    cfg = config_mod.load()
    ok = True

    print("[1/4] Audio input devices:", flush=True)
    try:
        import sounddevice as sd

        default_in = sd.default.device[0]
        found_input = False
        for i, dev in enumerate(sd.query_devices()):
            if dev["max_input_channels"] > 0:
                found_input = True
                marker = " (default)" if i == default_in else ""
                print(f"      #{i} {dev['name']}{marker}")
        if not found_input:
            print("      [!] No input devices found — plug in a microphone.")
            ok = False
    except Exception as e:
        print(f"      [!] sounddevice failed: {e}")
        ok = False

    print(f"[2/4] Loading model '{cfg.model}' on '{cfg.device}' "
          "(first run downloads it, then it's cached offline)...", flush=True)
    try:
        transcriber = Transcriber(cfg)
        text = transcriber.transcribe(np.zeros(16000, dtype=np.float32))
        print(f"      [+] Model loaded; silence transcribed to: {text!r}")
    except Exception as e:
        print(f"      [!] Model failed: {e}")
        ok = False

    print("[3/4] Cleanup rules...", flush=True)
    sample = clean("um, hello world, uh, this is, hmm, a test", cfg)
    print(f"      [+] {sample!r}")

    print("[4/4] Clipboard...", flush=True)
    try:
        import pyperclip

        old = pyperclip.paste()
        pyperclip.copy("whisperflow-check")
        assert pyperclip.paste() == "whisperflow-check"
        pyperclip.copy(old)
        print("      [+] Clipboard round-trip OK.")
    except Exception as e:
        print(f"      [!] Clipboard failed: {e}")
        ok = False

    print("[+] All checks passed." if ok else "[!] Some checks failed.")
    return 0 if ok else 1


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="whisperflow", description="Private, fully local dictation."
    )
    parser.add_argument(
        "--check", action="store_true",
        help="verify microphone, model, cleanup and clipboard, then exit",
    )
    args = parser.parse_args()

    if args.check:
        sys.exit(check())

    from . import config as config_mod
    from .app import App

    App(config_mod.load()).run()


if __name__ == "__main__":
    main()
