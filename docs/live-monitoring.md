# Monitoreo real en memoria

Entrada operativa: **http://127.0.0.1:8084/#/dashboard**.
La navegación contiene únicamente Dashboard, Cámaras y Servidor. No carga la demo,
fixtures, PostgreSQL ni coordinador/escritor persistentes. La inspección visual anterior
sigue disponible por su URL independiente; no es una fuente de estados para el dashboard.

## Uso

- **Actualizar** consulta manualmente una vez GetCameras y una vez GetStatus al único
  servidor autorizado, en paralelo, sin reintentos ni sincronización automática.
- Dashboard y listado usan datos reales temporales. El candidato municipal procede
  sólo de Description; Name exacto identifica la observación técnica por servidor.
- Active y Working proceden sólo de GetStatus; Active de GetCameras se muestra aparte
  como referencia en el detalle y nunca sustituye un Active desconocido de GetStatus.
- Una cámara sólo se clasifica caída con observaciones válidas y recientes, presencia
  en la última respuesta de inventario, estado coincidente por Name y Active=true,
  Working=false. Se mantienen operativa, caída, inactiva y desconocida por separado.
- Si falla cualquiera de los endpoints, las cámaras quedan con estado actual desconocido;
  se conservan los valores observados y su fecha. HTTP 401/403 no equivale a servidor
  sin respuesta. La salud del servidor y la de las cámaras son dimensiones separadas.
- La vigencia es 180 segundos, recalculada localmente cada segundo en la vista; después
  los estados pasan a desconocidos. El reloj local no realiza solicitudes a Digifort.
- Los registros ausentes no se interpretan como eliminados. Si falta estado, se marca
  cobertura missing y no se inventan valores false. Los huérfanos de GetStatus no crean
  cámaras sin inventario válido.
- La primera lectura no agrega historial previo ni transiciones ficticias. Sólo cambios
  posteriores observados de Active/Working crean eventos, con un máximo de 50 por cámara.
  Variaciones de FPS, fallos y lecturas idénticas no agregan transiciones.
- Todo queda en memoria hasta 30 minutos desde el último inventario válido o hasta el
  cierre del proceso. Al vencer se liberan cámaras/historial. Los UUID son identificadores
  temporales de sesión, sin relación ni modificaciones a UUID persistidos existentes.
- Búsqueda, filtros, navegación y detalles no consultan Digifort. No hay scheduler.

## Inicio en el Mac con VPN

La etapa actual se ejecuta directamente en macOS para usar la VPN existente, sin
modificar Docker ni sus redes. Docker Compose se conserva para el despliegue local
existente; no se reconvirtió ni se inició ese despliegue en esta etapa temporal.
No hay dependencias de PostgreSQL en el nuevo entrypoint.

```bash
npm --prefix apps/api run build
npm --prefix apps/web run build
DIGIFORT_LIVE_CONFIG="$PWD/.env.live.json" npm --prefix apps/api run live
```

El archivo local ignorado debe ser del usuario actual, permisos 0600 y contener un
array JSON de exactamente un servidor: id, baseUrl (origen y puerto), username, password.
No incluir valores reales en documentación ni comandos compartidos. Alternativamente,
`node apps/api/dist/live/server.js --stdin-config` recibe ese JSON por stdin hasta EOF,
con eco de terminal oculto. Los scripts start/dev de la API apuntan a este entrypoint real. La instancia actual usó stdin: no se guardaron credenciales.
LIVE_PORT permite elegir otro puerto; el servidor siempre escucha en 127.0.0.1.
Cerrar el proceso con Ctrl+C libera los datos temporales. Reiniciar no consulta el
servidor automáticamente: abrir la interfaz y pulsar Actualizar.

## API y privacidad

- GET `/api/v1/live`: devuelve sólo el estado en RAM; nunca consulta la red remota.
- POST `/api/v1/live/refresh`: requiere Host/Origin local exacto y cabecera
  X-Digifort-Live=manual. No admite URL, destino ni credenciales del navegador.
- Peticiones concurrentes reciben 409 sin iniciar otra colección. Timeout por endpoint
  5 segundos, máximo 1 MiB por cuerpo, GET fijo, sin redirects ni reintentos.
- Sólo Fastify tiene credenciales. No se exponen origen remoto, parámetros autenticados,
  Memo, grupos ni respuestas completas al navegador. La vista selecciona Name,
  Description, modelo, candidatos, flags y procedencia temporal.
- Logs de peticiones deshabilitados, errores saneados y respuestas Cache-Control no-store.
  No se usan archivos de respuesta, almacenamiento de navegador ni base de datos.
- `/api/v1/ready` indica storage=memory en este entrypoint. Los endpoints PostgreSQL/demo
  no se registran. Se conservan los originales, sin asignar códigos confirmados ni fusionar.

## Retiro de la demo del flujo operativo

Los recursos y datos preexistentes no se eliminaron ni modificaron. La fixture de 48
cámaras se trasladó a `apps/api/tests/fixtures/demo.ts`, consumida sólo por pruebas.
La interfaz anterior se conserva en `apps/web/tests/fixtures/legacy-monitor.tsx` para
regresión; el bundle operativo no la importa. El seed-cli está retirado y ops/demo.sh
rechaza start/reset. Los archivos Compose históricos y recursos existentes se conservan;
no se ejecutó stop, down, eliminación de volúmenes ni cambios de redes.

## Pruebas

210 pruebas API aprobadas con Node 22.23.4. Ocho nuevas verifican ausencia de llamadas
al iniciar/leer, exactamente una por endpoint al actualizar, fallos independientes,
NULL y falta de cobertura, ausencia de borrados inferidos, separación de Active de
inventario, vencimiento, retención, UUID de sesión estable, historial sólo de cambios
reales, origen/CSRF, rechazo de destinos arbitrarios y concurrencia. Las pruebas que
usan PostgreSQL son sintéticas/PGlite; los datos reales no se escribieron en ninguna base.
Compilaciones API/web aprobadas.

Chrome real a 1512 y 390 px: dashboard, listado, búsqueda/filtros, detalle sin historia
inventada, servidor, navegación de tres accesos y ausencia de desbordamiento/errores.
Una acción de actualización: GET GetCameras HTTP 200 (118) y GET GetStatus HTTP 200 (118).
En esa lectura inicial: 111 operativas, 7 caídas, 0 inactivas, 0 desconocidas. Son conteos
observados con fecha, no una afirmación de vigencia permanente; usar Actualizar al vencer.
No se guardaron capturas con información real ni respuestas completas.

```bash
cd apps/api
node --import tsx --test tests/live.test.ts
cd ../..
LIVE_URL=http://127.0.0.1:8084 LIVE_NO_QUERY=1 npm --prefix apps/web run test:browser
```

Sin LIVE_NO_QUERY, el recorrido pulsa Actualizar una vez sólo si aún no hubo consultas;
requiere autorización para el servidor configurado. NODE_BINARY permite seleccionar
Node 22 para Chrome. El ensayo siempre usa una sesión Chrome temporal separada.
