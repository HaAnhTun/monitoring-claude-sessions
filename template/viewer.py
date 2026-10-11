#!/usr/bin/env python
"""Entry point of the Claude Code session monitor (read-only, loopback only). Logic lives in ../src/backend.

New style:   python viewer.py <discover|init-task|inspect|configure|decide|audit|check|start|serve|verify|status|stop|doctor> [--task SLUG] [--repo .]
Legacy style (still supported):
             python viewer.py --config FILE            serve in the foreground
             python viewer.py --config FILE --check | --stop
             python viewer.py --discover [--repo PATH]
Docs: ../docs/ (architecture.md, configuration.md, api.md, troubleshooting.md) and ../SKILL.md.
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))

from backend.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
