import hashlib, os

__version__ = '2.0.1'


def code_stamp():
    """Short hash of the backend code and shared defaults on disk. A running monitor remembers the stamp it started with;
    `status` compares it with the current one to tell that a restart is needed (the frontend is served from disk on every
    request, so only backend changes need a restart)."""
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
    files = sorted(os.path.join(os.path.dirname(__file__), n) for n in os.listdir(os.path.dirname(__file__)) if n.endswith('.py'))
    files.append(os.path.join(root, 'config', 'defaults.json'))
    h = hashlib.sha1()
    for f in files:
        try:
            with open(f, 'rb') as fh:
                h.update(os.path.basename(f).encode() + fh.read())
        except OSError:
            pass
    return h.hexdigest()[:10]
