FROM python:3.13-alpine

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    DB_PATH=/data/bookmarks.db

WORKDIR /app

# Usuario sin privilegios; /data es donde vive la base de datos SQLite
RUN adduser -D -H -u 1000 app && mkdir /data && chown app:app /data

COPY server.py ./
COPY public ./public

USER app
EXPOSE 8080
VOLUME ["/data"]

CMD ["python", "server.py"]
