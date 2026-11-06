#!/usr/bin/env python3
"""Smart Bookmarks: servidor mínimo (solo biblioteca estándar).

Sirve la web de `public/` y una API JSON sobre SQLite:

  GET  /api/health                 -> {"ok": true}                (sin autenticación)
  GET  /api/bookmarks              -> {"spaces": {"personal": [...], "trabajo": [...]}, "settings", "version"}
  GET  /api/bookmarks?since=N      -> {"changed": false, ...} si no hay cambios desde la versión N
  PUT  /api/bookmarks              <- {"spaces", "settings", "version"}  (version = versión de la que partes)
                                   -> 200 {"version": N+1} | 409 {"state": ...} si otro dispositivo guardó antes

Variables de entorno: HOST, PORT, DB_PATH, AUTH_USER, AUTH_PASSWORD.
"""

import base64
import hmac
import json
import os
import re
import signal
import sqlite3
import sys
from contextlib import closing
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5656"))
DB_PATH = Path(os.environ.get("DB_PATH", "data/bookmarks.db"))
PUBLIC_DIR = Path(__file__).resolve().parent / "public"
AUTH_USER = os.environ.get("AUTH_USER", "")
AUTH_PASSWORD = os.environ.get("AUTH_PASSWORD", "")

MAX_BODY = 5 * 1024 * 1024
MAX_ITEMS = 20_000
MAX_DEPTH = 20
MAX_SPACES = 20
DEFAULT_SPACE = "personal"
SPACE_ID = re.compile(r"^[a-z0-9_-]{1,32}$")
ALLOWED_URL_PREFIXES = ("http://", "https://", "file:", "ftp://", "mailto:")
STATIC_FILES = {"/", "/index.html", "/app.js", "/styles.css"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id         TEXT PRIMARY KEY,
    space      TEXT NOT NULL DEFAULT 'personal',
    parent_id  TEXT REFERENCES items(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('link', 'folder')),
    title      TEXT NOT NULL,
    url        TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

UPSERT = """
INSERT INTO items (id, space, parent_id, position, type, title, url) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET
    space      = excluded.space,
    parent_id  = excluded.parent_id,
    position   = excluded.position,
    type       = excluded.type,
    title      = excluded.title,
    url        = excluded.url,
    updated_at = CASE
        WHEN items.space IS NOT excluded.space
          OR items.parent_id IS NOT excluded.parent_id OR items.title IS NOT excluded.title
          OR items.url IS NOT excluded.url OR items.type IS NOT excluded.type
        THEN CURRENT_TIMESTAMP ELSE items.updated_at END
"""


# --------------------------------------------------------------------------- DB

def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)  # transacciones explícitas
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect()) as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        # Migración: bases de datos anteriores a los espacios -> todo pasa a "personal"
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(items)")}
        if "space" not in columns:
            conn.execute("ALTER TABLE items ADD COLUMN space TEXT NOT NULL DEFAULT 'personal'")
            print("Base de datos migrada: los bookmarks existentes están en el espacio 'personal'", flush=True)
        conn.execute("DROP INDEX IF EXISTS items_parent")
        conn.execute("CREATE INDEX IF NOT EXISTS items_tree ON items (space, parent_id, position)")


def get_meta(conn):
    return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM meta")}


def get_version(conn):
    return int(get_meta(conn).get("version", "0"))


def read_state(conn):
    rows = conn.execute(
        "SELECT id, space, parent_id, type, title, url FROM items ORDER BY position"
    ).fetchall()
    nodes = {}
    for r in rows:
        node = {"id": r["id"], "type": r["type"], "title": r["title"]}
        if r["type"] == "link":
            node["url"] = r["url"]
        else:
            node["children"] = []
        nodes[r["id"]] = node

    spaces = {DEFAULT_SPACE: []}
    for r in rows:  # ordenadas por posición: el orden relativo dentro de cada carpeta se mantiene
        parent = nodes.get(r["parent_id"]) if r["parent_id"] else None
        siblings = parent["children"] if parent else spaces.setdefault(r["space"], [])
        siblings.append(nodes[r["id"]])

    meta = get_meta(conn)
    return {
        "spaces": spaces,
        "items": spaces[DEFAULT_SPACE],  # para pestañas abiertas con la versión anterior de la página
        "settings": json.loads(meta.get("settings", "{}")),
        "version": int(meta.get("version", "0")),
    }


def flatten_spaces(spaces):
    if not isinstance(spaces, dict):
        raise ValueError("'spaces' debe ser un objeto")
    if len(spaces) > MAX_SPACES:
        raise ValueError("demasiados espacios")
    rows, seen = [], set()
    for space, items in spaces.items():
        if not isinstance(space, str) or not SPACE_ID.match(space):
            raise ValueError(f"nombre de espacio inválido: {space!r}")
        flatten(items, space, out=rows, seen=seen)
    return rows


def flatten(items, space, parent=None, depth=0, out=None, seen=None):
    """Valida el árbol y lo convierte en filas (padres antes que hijos)."""
    out = [] if out is None else out
    seen = set() if seen is None else seen
    if not isinstance(items, list):
        raise ValueError("cada espacio debe ser una lista de bookmarks")
    if depth > MAX_DEPTH:
        raise ValueError("demasiados niveles de carpetas")
    for position, item in enumerate(items):
        if not isinstance(item, dict):
            raise ValueError("cada elemento debe ser un objeto")
        item_id, kind, title = item.get("id"), item.get("type"), item.get("title")
        if not isinstance(item_id, str) or not 0 < len(item_id) <= 64:
            raise ValueError("id inválido")
        if item_id in seen:
            raise ValueError(f"id duplicado: {item_id}")
        seen.add(item_id)
        if not isinstance(title, str) or len(title) > 500:
            raise ValueError(f"título inválido en {item_id}")
        if kind == "link":
            url = item.get("url")
            if not isinstance(url, str) or len(url) > 4096 or not url.lower().startswith(ALLOWED_URL_PREFIXES):
                raise ValueError(f"url inválida en {item_id}")
            out.append((item_id, space, parent, position, "link", title, url))
        elif kind == "folder":
            out.append((item_id, space, parent, position, "folder", title, None))
            flatten(item.get("children", []), space, item_id, depth + 1, out, seen)
        else:
            raise ValueError(f"tipo inválido en {item_id}")
        if len(out) > MAX_ITEMS:
            raise ValueError("demasiados bookmarks")
    return out


def write_state(conn, payload):
    """Guarda el árbol completo. Devuelve la nueva versión, o None si hay conflicto."""
    if "spaces" not in payload:
        raise ValueError("Esta pestaña tiene una versión antigua de la página: recárgala")
    rows = flatten_spaces(payload["spaces"])
    settings = payload.get("settings", {})
    if not isinstance(settings, dict):
        raise ValueError("'settings' debe ser un objeto")
    settings_json = json.dumps(settings, ensure_ascii=False)
    if len(settings_json) > 10_000:
        raise ValueError("'settings' es demasiado grande")
    base_version = payload.get("version")
    if not isinstance(base_version, int) or isinstance(base_version, bool):
        raise ValueError("'version' debe ser un entero")

    conn.execute("BEGIN IMMEDIATE")
    try:
        current = get_version(conn)
        if base_version != current:
            conn.execute("ROLLBACK")
            return None
        conn.executemany(UPSERT, rows)
        ids = json.dumps([r[0] for r in rows])
        conn.execute("DELETE FROM items WHERE id NOT IN (SELECT value FROM json_each(?))", (ids,))
        new_version = current + 1
        conn.executemany(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [("version", str(new_version)), ("settings", settings_json)],
        )
        conn.execute("COMMIT")
        return new_version
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise


# ------------------------------------------------------------------------- HTTP

class Handler(SimpleHTTPRequestHandler):
    server_version = "SmartBookmarks/1.0"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    # ---- utilidades

    def route(self):
        return urlsplit(self.path).path

    def authorized(self):
        if not AUTH_PASSWORD:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            user, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
        except (ValueError, UnicodeDecodeError):
            return False
        user_ok = hmac.compare_digest(user.encode(), AUTH_USER.encode())
        pass_ok = hmac.compare_digest(password.encode(), AUTH_PASSWORD.encode())
        return user_ok and pass_ok

    def deny(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Bookmarks", charset="UTF-8"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        if not self.route().startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_request(self, code="-", size="-"):
        # no llenar el log con los sondeos periódicos de sincronización
        if self.route() in ("/api/bookmarks", "/api/health") and self.command == "GET" and str(code) == "200":
            return
        super().log_request(code, size)

    # ---- métodos

    def do_GET(self):
        path = self.route()
        if path == "/api/health":
            return self.send_json(200, {"ok": True})
        if not self.authorized():
            return self.deny()
        if path == "/api/bookmarks":
            since = parse_qs(urlsplit(self.path).query).get("since", [None])[0]
            with closing(connect()) as conn:
                if since is not None:
                    version = get_version(conn)
                    if since == str(version):
                        return self.send_json(200, {"changed": False, "version": version})
                return self.send_json(200, read_state(conn))
        if path.startswith("/api/") or path not in STATIC_FILES:
            return self.send_json(404, {"error": "no encontrado"})
        return super().do_GET()

    def do_HEAD(self):
        if not self.authorized():
            return self.deny()
        if self.route() not in STATIC_FILES:
            return self.send_json(404, {"error": "no encontrado"})
        return super().do_HEAD()

    def do_PUT(self):
        if not self.authorized():
            return self.deny()
        if self.route() != "/api/bookmarks":
            return self.send_json(404, {"error": "no encontrado"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            return self.send_json(400, {"error": "cuerpo vacío"})
        if length > MAX_BODY:
            return self.send_json(413, {"error": "demasiado grande"})
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            return self.send_json(400, {"error": "JSON inválido"})
        if not isinstance(payload, dict):
            return self.send_json(400, {"error": "se esperaba un objeto"})

        try:
            with closing(connect()) as conn:
                version = write_state(conn, payload)
                if version is None:
                    return self.send_json(409, {"error": "conflicto", "state": read_state(conn)})
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})
        return self.send_json(200, {"version": version})


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True

    def stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)  # `docker stop` envía SIGTERM
    auth = "con usuario y contraseña" if AUTH_PASSWORD else "sin autenticación"
    print(f"Smart Bookmarks en http://{HOST}:{PORT} ({auth}) · base de datos: {DB_PATH}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("Servidor detenido", flush=True)


if __name__ == "__main__":
    sys.exit(main())
