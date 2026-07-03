"""Insert text at the cursor of whatever window has focus.

"paste" puts the text on the clipboard and sends Ctrl+V — fast and safe for
any unicode. "type" simulates keystrokes, which leaves the clipboard alone
but is slower and can drop characters in some apps.
"""

import time

import keyboard
import pyperclip

from .config import Config


def inject(text: str, cfg: Config) -> None:
    if cfg.append_space:
        text = text + " "

    if cfg.injection == "type":
        keyboard.write(text, delay=0.002)
        return

    old = None
    if cfg.restore_clipboard:
        try:
            old = pyperclip.paste()
        except Exception:
            old = None
    pyperclip.copy(text)
    time.sleep(0.05)  # let the clipboard settle before pasting
    keyboard.send("ctrl+v")
    if cfg.restore_clipboard and old is not None:
        # apps read the clipboard asynchronously; restoring too soon breaks the paste
        time.sleep(0.3)
        pyperclip.copy(old)
