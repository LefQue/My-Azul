#!/usr/bin/env python3
"""
Sert les fichiers du projet Azul (comme `python3 -m http.server`) ET reçoit directement les données
d'entraînement envoyées par index-scan-train.html, sans passer par un téléchargement/AirDrop manuel.

Usage:
  python3 serve_and_collect.py [port]   # défaut : 8765

Le téléphone (même Wi-Fi) ouvre http://<ip-du-mac>:<port>/version_ia/index-scan-train.html,
et le bouton "Envoyer au Mac" poste directement le JSON ici, écrit dans
version_ia/ml/training-data/training-data-<timestamp>.json
"""
import http.server
import json
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # .../Azul_compte_point
TRAINING_DATA_DIR = Path(__file__).resolve().parent / "training-data"
TRAINING_DATA_DIR.mkdir(exist_ok=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PROJECT_ROOT), **kwargs)

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_POST(self):
        if self.path != "/upload-training-data":
            self.send_response(404)
            self._send_cors_headers()
            self.end_headers()
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            examples = json.loads(body)
            if not isinstance(examples, list):
                raise ValueError("payload attendu: liste de {label, dataUrl}")

            filename = f"training-data-{int(time.time()*1000)}.json"
            out_path = TRAINING_DATA_DIR / filename
            out_path.write_bytes(body)

            print(f"[serve_and_collect] {len(examples)} exemples reçus -> {out_path}")

            self.send_response(200)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True, "count": len(examples), "file": filename}).encode())
        except Exception as e:
            print(f"[serve_and_collect] erreur upload: {e}")
            self.send_response(400)
            self._send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": str(e)}).encode())

    def log_message(self, fmt, *args):
        # réduit le bruit des GET habituels, garde les messages explicites ci-dessus pour les uploads
        if "/upload-training-data" not in (self.path or ""):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Sert {PROJECT_ROOT} sur le port {port}")
    print(f"Données d'entraînement écrites dans {TRAINING_DATA_DIR}")
    print(f"Depuis ton téléphone : http://<ip-de-ce-mac>:{port}/version_ia/index-scan-train.html")
    server.serve_forever()


if __name__ == "__main__":
    main()
