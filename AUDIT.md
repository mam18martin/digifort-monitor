# Primera auditoría técnica — 23 de octubre de 2026

## Alcance y estructura

Se leyeron `AGENTS.md` y `README.md` antes de revisar el proyecto. El repositorio contiene dos aplicaciones independientes: `apps/api` (Node.js 22, Fastify, TypeScript y pg) y `apps/web` (React 19, Vite y TypeScript), con Dockerfiles multietapa, Nginx, PostgreSQL 17 en Compose y CI para compilación y pruebas. No hay esquema de datos, migraciones ni integración Digifort en esta etapa.

Compose publica únicamente Nginx en `127.0.0.1:8080`. API y PostgreSQL no tienen puertos publicados. La red llamada `internal` es una red bridge de Compose; su nombre no equivale a `internal: true` ni bloquea conexiones salientes. PostgreSQL tiene volumen persistente y comprobación de salud. El backend se ejecuta como usuario `node`. No se habilitó exposición pública.

## Hallazgos y correcciones

1. **La API no se conectaba a PostgreSQL.** La dependencia `pg` y `DATABASE_URL` no se utilizaban. Se añadió un pool con límites de conexión y consulta, cierre al terminar el proceso y `GET /api/v1/ready`, que ejecuta `SELECT 1`. El healthcheck de Compose usa ahora ese endpoint. `/health` sigue comprobando sólo la API.
2. **La URL de conexión concatenaba credenciales sin codificación.** Se reemplazó por variables estándar `PG*`, evitando problemas con caracteres reservados. No se modificó ningún archivo de secretos.
3. **Instalaciones no reproducibles.** Se incorporaron lockfiles por aplicación y se cambió Docker y CI a `npm ci`.
4. **Exclusiones Docker fuera del contexto.** El `.dockerignore` raíz no se aplica a `build: ./apps/api` ni a `build: ./apps/web`. Se añadieron exclusiones en ambos contextos para dependencias locales, compilaciones, archivos de entorno y registros. Se excluyeron los metadatos incrementales de TypeScript de Git.
5. **Documentación incompleta de conectividad.** README documenta las variables de desarrollo, los endpoints y los comandos para validar la cadena completa sin mostrar credenciales.

## Pruebas realizadas

| Comprobación | Resultado |
| --- | --- |
| `docker compose config --quiet`, antes y después | Correcto |
| `npm install --ignore-scripts`, ambas aplicaciones | Correcto; generó lockfiles; npm informó 0 vulnerabilidades en ese momento |
| `npm run build`, API | Correcto con Node.js 22.22.1 |
| `npm test`, API | Correcto: casos de salud, disponibilidad, fallo de base sin filtrar errores y ausencia de verificador |
| `npm run build`, frontend | Correcto: TypeScript y compilación Vite de React |
| HTTP local con configuración real de proxy Vite y API compilada | HTML 200 y `/api/v1/health` 200 |
| Fallo real de conexión a un puerto local cerrado, mediante el proxy | `/api/v1/ready` 503 con respuesta genérica |
| `git diff --check` | Correcto |
| `docker compose up -d --build --wait` | Bloqueado por permisos del socket Docker, también al solicitar ejecución fuera del sandbox |
| Intento con `sudo -n docker compose up -d --build --wait` | Bloqueado: requiere autenticación interactiva |

La prueba HTTP abrió servidores temporales sólo en localhost y los cerró al terminar. Vite emitió un mensaje de escaneo de dependencias cancelado al cerrar inmediatamente el servidor de prueba; las aserciones HTTP finalizaron correctamente y la compilación independiente del frontend también pasó. No se realizó una prueba visual en navegador.

## Validación pendiente

No se pudo construir ninguna imagen ni iniciar contenedores desde esta sesión. Por lo tanto, las versiones y la configuración de PostgreSQL, Nginx y las imágenes Node se revisaron estáticamente, pero no se verificaron en ejecución. Tampoco se comprobó una conexión exitosa a PostgreSQL real ni la persistencia del volumen. El caso exitoso de disponibilidad se probó con un verificador inyectado; no sustituye la prueba de integración.

En una sesión con acceso al daemon, ejecutar la sección «Validación técnica» del README. El resultado esperado de `/ready` a través de `127.0.0.1:8080` es HTTP 200 y `database: "connected"`; la consulta directa debe devolver 1. Conservar el volumen existente: no usar `down -v`.

No se evaluaron vulnerabilidades de las imágenes, autenticación, autorización ni HTTPS. El esqueleto sigue sin ser apto para exposición pública. No se implementó Digifort, no se leyeron ni modificaron archivos de secretos y no se ejecutaron commits ni pushes.

## Archivos modificados o incorporados

- `compose.yaml`
- `apps/api/Dockerfile`, `apps/web/Dockerfile`
- `apps/api/.dockerignore`, `apps/web/.dockerignore`
- `apps/api/package-lock.json`, `apps/web/package-lock.json`
- `apps/api/src/app.ts`, `apps/api/src/server.ts`
- `apps/api/tests/health.test.ts`
- `.github/workflows/ci.yml`, `.gitignore`
- `README.md`, `AUDIT.md`
