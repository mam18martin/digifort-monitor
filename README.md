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
curl --fail http://127.0.0.1:8080/api/v1/ready
```
Abrir http://localhost:8080. Detener con `docker compose down` (sin `-v`, para conservar datos).

## Servicios
- `web`: React/Vite compilado, servido por Nginx en 127.0.0.1:8080
- `api`: Fastify en la red privada Docker, no expuesta al host
- `db`: PostgreSQL 17, volumen persistente, no expuesto al host

La API usa un pool PostgreSQL y ejecuta `SELECT 1` para comprobar disponibilidad. Todavía no hay esquema ni consultas de negocio. La PWA, login y HTTPS no están implementados todavía.

### Comprobaciones de salud
- `GET /api/v1/health`: devuelve 200 con `status: "ok"` y `service: "digifort-monitor-api"` si la API responde, independientemente de PostgreSQL.
- `GET /api/v1/ready`: ejecuta `SELECT 1`; devuelve 200 con `status: "ok", database: "connected"`, o 503 con `status: "unavailable", database: "unavailable"`. No publica errores ni datos de conexión.
- Compose espera PostgreSQL y luego la disponibilidad de la API antes de iniciar Nginx. El frontend informa conexión con la API mediante `/health`; ese mensaje no confirma disponibilidad de PostgreSQL.
- Los parámetros `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` y `PGPASSWORD` se suministran por separado para admitir contraseñas con caracteres reservados sin construir una URL.

## Desarrollo sin Docker
En terminales separadas:
```bash
cd apps/api && npm ci && npm run dev
cd apps/web && npm ci && npm run dev
```
El frontend Vite redirige `/api` a `localhost:3000`. PostgreSQL requiere Docker o una instancia local.
Para desarrollo local, configurar las variables `PG*` en el entorno del proceso de la API; Node no carga automáticamente el `.env` de Compose.

## Validación técnica
```bash
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
curl --fail http://127.0.0.1:8080/api/v1/health
curl --fail http://127.0.0.1:8080/api/v1/ready
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1"'
```
`/ready` a través del puerto 8080 comprueba Nginx → API → PostgreSQL. Se requiere permiso de acceso al daemon Docker. No usar `docker compose config` sin `--quiet` al compartir resultados, porque puede mostrar credenciales interpoladas.

Para compilar y probar sin Docker, ejecutar `npm ci && npm run build && npm test` en `apps/api` y `npm ci && npm run build` en `apps/web`. Conservar ambos `package-lock.json` para instalaciones reproducibles.

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
