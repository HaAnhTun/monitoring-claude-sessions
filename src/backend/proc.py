"""Run helper programs without flashing console windows on Windows.

The detached monitor has a hidden console (CREATE_NO_WINDOW). Every child it starts (git, tasklist, docker, powershell,
taskkill) must also be created with CREATE_NO_WINDOW, otherwise Windows opens a visible cmd window for each call."""
import os, subprocess

NO_WINDOW = 0x08000000 if os.name == 'nt' else 0
NEW_GROUP = 0x00000200 if os.name == 'nt' else 0


def run(*args, **kw):
    if os.name == 'nt':
        kw['creationflags'] = kw.get('creationflags', 0) | NO_WINDOW
    return subprocess.run(*args, **kw)
