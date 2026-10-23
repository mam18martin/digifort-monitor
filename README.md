# Digifort Monitor — Etapa 1

Plataforma municipal de monitoreo de cámaras y mantenimiento de infraestructura. **Este repositorio es un esqueleto inicial, no una versión apta para exposición pública.**

## Requisitos
- Docker Engine + Docker Compose plugin
- Git (y opcionalmente GitHub CLI / Codex)

## Inicio
```bash
cp .env.example .env
# Editar .env y reemplazar la contraseña de ejemplo por una larga y aleatoria
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:8080/api/v1/health
```
Abrir http://localhost:8080. Detener con `docker compose down` (sin `-v`, para conservar datos).

## Servicios
- `web`: React/Vite compilado, servido por Nginx en 127.0.0.1:8080
- `api`: Fastify en la red privada Docker, no expuesta al host
- `db`: PostgreSQL 17, volumen persistente, no expuesto al host

**Nota:** La conexión PostgreSQL está configurada pero aún no hay esquema ni consultas; eso se hará en la siguiente etapa. La PWA, login y HTTPS no están implementados todavía.

## Desarrollo sin Docker
En terminales separadas:
```bash
cd apps/api && npm install && npm run dev
cd apps/web && npm install && npm run dev
```
El frontend Vite redirige `/api` a `localhost:3000`. PostgreSQL requiere Docker o una instancia local.

## GitHub
Crear un repositorio **privado** vacío `digifort-monitor`, luego:
```bash
git init
git add .
git commit -m "chore: bootstrap dockerized monitoring monorepo"
git branch -M main
git remote add origin git@github.com:TU_ORGANIZACION/digifort-monitor.git
git push -u origin main
```
No subir `.env` ni datos municipales. Configurar protección de `main`, revisión por PR y CI obligatoria.

## Próximos hitos
1. Esquema PostgreSQL, migraciones y modelo de nodos/servidores/cámaras.
2. Conector Digifort con XML de prueba anonimizado y correspondencia por ID estable.
3. Sincronización, métricas y trazabilidad de fallas.
4. Login, roles, auditoría, HTTPS y despliegue seguro.
5. Dashboard PWA y órdenes de trabajo de cuadrillas.
