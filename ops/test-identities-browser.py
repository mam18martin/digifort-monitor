"""Run local demo checks in a separate, temporary Chrome profile on macOS."""
import os
import pathlib
import shutil
import socket
import sys
import subprocess
import tempfile
import time
import urllib.request

chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
node = os.environ.get('NODE_BINARY') or shutil.which('node')
if not node or not pathlib.Path(chrome).is_file():
    raise SystemExit('Se requieren Node.js 22 o posterior y Google Chrome en macOS.')
# Do not attach to, or terminate, a preexisting browser debugging session.
with socket.socket() as probe:
    try:
        probe.bind(('127.0.0.1', 9223))
    except OSError:
        raise SystemExit('El puerto local 9223 está ocupado; no se modifica el proceso existente.')
with tempfile.TemporaryDirectory(prefix='digifort-browser-') as profile:
    with tempfile.TemporaryFile() as log:
        process = subprocess.Popen([
            chrome, '--headless=new', '--remote-debugging-address=127.0.0.1',
            '--remote-debugging-port=9223', '--user-data-dir=' + profile,
            '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            '--disable-component-update', '--disable-sync', '--disable-extensions', 'about:blank',
        ], stdout=log, stderr=log)
        try:
            for _ in range(50):
                try:
                    with urllib.request.urlopen('http://127.0.0.1:9223/json/version', timeout=1):
                        break
                except OSError:
                    if process.poll() is not None:
                        raise SystemExit('Chrome no pudo iniciar.')
                    time.sleep(.2)
            else:
                raise SystemExit('Chrome no respondió a tiempo.')
            suite = 'management-browser.mjs' if sys.argv[1:] == ['--management'] else 'live-browser.mjs' if sys.argv[1:] == ['--live'] else 'inspection-browser.mjs' if sys.argv[1:] == ['--inspection'] else 'identities-browser.mjs'
            script = pathlib.Path(__file__).resolve().parent.parent / 'apps/web/tests' / suite
            raise SystemExit(subprocess.run([node, str(script)]).returncode)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
