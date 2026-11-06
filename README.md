# Smart Bookmarks

Página de bookmarks en cuadrícula, con carpetas y arrastrar y soltar. Tus bookmarks se sincronizan entre todos tus dispositivos a través de un servidor pequeño con SQLite.

- **Servidor:** `server.py`. Usa solo la biblioteca estándar de Python, sin dependencias. Ocupa unos 20 MB de RAM.
- **Web:** `public/` (HTML, CSS y JS, sin compilar nada).
- **Base de datos:** `/data/bookmarks.db`, dentro del volumen de Docker `bookmarks-data`.

## Arrancar en el minipc

```bash
cp .env.example .env      # opcional: puerto, zona horaria, contraseña
docker compose up -d --build
```

Después abre `http://IP-DEL-MINIPC:8080` en cualquier dispositivo de tu red.

| Acción | Comando |
| --- | --- |
| Ver logs | `docker compose logs -f` |
| Parar | `docker compose down` (los datos se conservan) |
| Actualizar tras cambiar el código | `docker compose up -d --build` |
| Copia de la base de datos | `docker compose cp bookmarks:/data/bookmarks.db ./bookmarks-backup.db` |

También puedes usar **Exportar / Importar** en la propia web para hacer copias en `.json`.

> ⚠️ `docker compose down -v` borra el volumen, y con él **todos los bookmarks**.

## Contraseña

Si en `.env` le das valor a `AUTH_PASSWORD` (y a `AUTH_USER`), el navegador pedirá usuario y contraseña. Dentro de casa no hace falta. Si lo vas a abrir desde fuera de tu red, actívala, y mejor aún si lo pones detrás de HTTPS (Tailscale, Caddy, Cloudflare Tunnel…).

## Cómo funciona la sincronización

- Cada navegador guarda una copia local, así la página carga al instante y sigue funcionando sin conexión.
- Cada cambio se sube al servidor en menos de un segundo.
- Cada 20 segundos, y al volver a la pestaña, la página comprueba si otro dispositivo ha hecho cambios.
- Si dos dispositivos guardan a la vez, gana el primero. El otro carga esa versión y avisa de que su último cambio no se aplicó.
- La primera vez que se abre con el servidor vacío, se suben los bookmarks que tuviera ese navegador.

## Desarrollo sin Docker

```bash
python3 server.py         # http://localhost:8080, base de datos en ./data/bookmarks.db
```
