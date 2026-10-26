# Fase 3B, paso 4 — coordinación manual

> Regla vigente: [Description como fuente oficial](description-identity.md). Desde esta corrección, Name es sólo la clave técnica exacta; no hay fallback automático. Las referencias anteriores a Name como fuente son históricas.

Estado: función explícita integrada con el conector JSON y Snapshot Writer. Sin
scheduler, rutas HTTP, CLI de producción, lectura automática de secretos ni llamadas
al arrancar. No modifica 001/002 ni activa sincronización real.

## Entrada y flujo

`src/sync/index.ts` exporta `synchronizeServerManually(db, options)`. Se requiere una
conexión dedicada e inactiva durante toda la llamada: no pasar un pool que distribuya
sentencias, una conexión compartida entre invocaciones o una transacción abierta.
La función no crea conexiones. Ejemplo conceptual, sin datos operativos:

```ts
const result = await synchronizeServerManually(connection, {
  serverId: internalServerUuid,
  requestKey: logicalRequestUuid,
  server: resolvedPrivateConfiguration,
  fetch: approvedTransport,
  // Default: one attempt, 5-second per-request timeout, unknown completeness.
});
```

1. Toma un bloqueo asesor de sesión por requestKey, sin esperar indefinidamente. Una
   solicitud igual en curso devuelve IN_PROGRESS. La conexión debe descartarse si
   falla la liberación del bloqueo. El bloqueo no se comparte entre claves distintas.
2. Reserva ejecución, secuencia y lease mediante `beginServerSync`. Un lease vigente
   de otra ejecución devuelve LEASE_UNAVAILABLE antes de consultar Digifort.
3. Si la ejecución ya es terminal devuelve replay desde PostgreSQL, sin consultas de
   red. Si está running pero perdió lease, secuencia o revisión devuelve STALE_EXECUTION.
4. Después de adquirir una reserva nueva, marca como abandoned las ejecuciones running
   anteriores del mismo servidor. Registra WORKER_ABANDONED. Sólo cierra la ejecución
   global como abandoned cuando todas sus ejecuciones hijas están abandonadas.
5. Comprueba configuración: el `server.id` externo debe coincidir con config_key y el
   origen validado debe coincidir con endpoint_origin. La revisión fijada por la reserva
   sigue siendo verificada al aplicar. Configuración inválida registra fallos tipados
   sin emitir requests. El conector usa el UUID interno como contexto del snapshot;
   config_key y UUID nunca se suponen equivalentes.
6. Ejecuta GetCameras y GetStatus en paralelo mediante
   `DigifortJsonClient.collectEndpoints()`. Cada uno valida su respuesta y conserva
   metadatos de sus propios intentos. No hay transacción PostgreSQL abierta durante HTTP.
7. Normaliza evidencia y entrega los dos resultados finales y todos los intentos al
   escritor. Sólo construye snapshot si ambos endpoints terminan válidamente. Los
   fallos conservan estados anteriores de cámaras; una respuesta válida con estado
   faltante produce cobertura missing y Working desconocido, nunca falso inventado.
8. El escritor aplica atómicamente con fencing y revisión de lease antes del commit.
   Un colector demorado cuya ejecución fue abandonada devuelve STALE_EXECUTION y no
   modifica datos posteriores. El bloqueo asesor se libera en finally.

Se conserva la semántica de una ejecución global manual por servidor. No se añade
coordinación global multiservidor ni una política de recuperación en segundo plano.

## Resultados y cobertura

El resultado manual contiene UUIDs, secuencia, outcome, replayed, conteos de asociación
y una lista de intentos saneados. No contiene tokens de lease, credenciales, Name,
Description, origen, headers ni cuerpos remotos. Cada intento informa:

- endpoint y attemptNo;
- timestamps UTC y duración medida con reloj monotónico durante colección;
- responseReceived y responseValid independientes;
- HTTP status cuando se recibió, outcome y errorCode de catálogo;
- rowCount sólo cuando el parseo fue válido;
- completeness: **unknown** para todas las respuestas válidas del contrato actual.

El resultado no equipara respuesta recibida con respuesta válida, ni validación de
JSON con completitud. Body vacío es inválido; JSON con Cameras=[] es válido pero su
completitud sigue siendo desconocida. El snapshot conserva conteos matched,
missingStatus y orphanStatus. Una discrepancia de asociación no prueba por sí sola
cuál de los endpoints es completo.

HTTP 200 no acredita inventario completo. El coordinador no ofrece un parámetro para
forzar complete. Los errores tienen completeness unknown y no fabrican conteos cero.
El parser extrae candidatos exclusivamente desde Description con delimitador
opcional, sin incluirlo en el código; no existe fallback desde Name. Conserva Name y Description exactos, incluidos espacios y paréntesis.
La asociación sigue siendo Name exacto por servidor, sin asignación de códigos ni
fusiones por código, ubicación o descripción.

En persistencia, Description original se conserva exactamente bajo límites de tamaño
y rechazo de secretos evidentes. La política selectInventoryText puede elegir modelo
y dirección; si suministra description debe ser idéntica al original. Un texto sensible
o una transformación no autorizada aborta atómicamente, sin guardar secretos ni usar
Name como reemplazo. El escritor exige migración 004 antes de aplicar observaciones.

## Reintentos y recuperación

Por defecto hay un intento por endpoint. maxAttempts admite 1–3, retryDelayMs 0–1000.
Sólo se repiten NETWORK_ERROR, TIMEOUT, HTTP 429 y HTTP 5xx. No se repiten 401/403,
JSON inválido ni nombres duplicados. Si GetCameras se recupera, GetStatus exitoso no se
consulta de nuevo. Se conservan todos los intentos, incluso fallidos antes de éxito.
El escritor valida numeración consecutiva, cronología y coincidencia entre último
intento y resultado final antes de persistir nada.

El timeout incluye cuerpo y cabeceras. Un transporte que ignore AbortSignal no evita
que el intento termine por timeout; una respuesta tardía se descarta y cancela sin
reclasificar el intento. La duración en vivo se mide con performance.now().

El lease predeterminado cubre el máximo presupuesto de colección configurado más
10 segundos para persistir, con mínimo 30 segundos. El timeout del coordinador está
limitado a 60 segundos y el lease mantiene el límite de 5 minutos del escritor.
Un lease explícito menor puede vencer: nunca autoriza aplicar datos fuera de plazo.
No se renueva automáticamente.

Un requestKey terminal es inmutable: repetirlo devuelve el mismo resultado. Para una
consulta posterior tras un fallo de endpoint o una reserva vencida usar requestKey
nuevo. Un worker caído deja de bloquear nuevas solicitudes cuando vence su lease;
la siguiente invocación nueva registra abandono. Si una conexión vieja sigue viva y
retiene su bloqueo de sesión, bloquea sólo su requestKey: no el nuevo requestKey del
servidor. Si se pierde la respuesta a COMMIT, reintentar primero la misma clave para
resolver el resultado sin duplicar aplicación.

## Límites de esquema y seguridad

No se cambia `getCameras()`: conserva su contrato previo de snapshot conjunto o error.
Se añade collectEndpoints con transporte y parsers existentes. El observador HTTP
interno recibe sólo status y no expone URL/cabeceras/cuerpo. Los errores de adaptadores
se reducen a códigos de una lista permitida; no se retienen Error.message, stack,
cause ni strings arbitrarios usados como códigos.

002 permite persistir intentos y timestamps, pero no duración monotónica ni un flag
responseReceived. Prohíbe HTTP status en un transport_error. Por ello:

- el informe en vivo distingue timeout antes de cabeceras de timeout de cuerpo y
  conserva el HTTP recibido;
- para el escritor, transport_error omite HTTP status y transporta responseReceived
  como evidencia para la salud del servidor;
- la salud usa respuestas de TODOS los intentos, no sólo de los resultados finales;
- en replay, duración deriva de timestamps (durationSource wall_clock), y una respuesta
  de transporte cuya recepción no puede reconstruirse se informa como null, no false.

Persistir esa evidencia exacta requerirá una migración posterior aprobada. También
permanece la limitación de confirmaciones históricas de cámara descrita en
[snapshot-writer.md](snapshot-writer.md). No se modifica ni se deshabilita ningún trigger.

Este paso no otorga permisos al rol de aplicación ni configura secretos. Activación
real exige rol de ingestión y revisión de seguridad, custodia de configuración,
metadatos permitidos y autorización explícita del entorno/destino. Relojes de Node y
PostgreSQL deben estar sincronizados; evidencia temporal incoherente se rechaza.

## Cómo acreditar completitud posteriormente

Se requiere validación autorizada y de sólo lectura contra Digifort real, fuera de
este paso. Antes de habilitar complete:

1. Verificar documentación/versiones y si existen paginación, totales, truncamiento,
   filtros por permisos o un identificador consistente de snapshot. No asumir campos
   que el contrato actual no contiene.
2. Definir el universo esperado y alcance de permisos por servidor; contrastar con un
   inventario/exportación revisado por el operador. Igualdad de conteos por sí sola no
   acredita cobertura completa.
3. Ensayar cero cámaras legítimo, filtros, páginas omitidas, cambios entre endpoints y
   respuestas grandes. Confirmar qué cámaras incluye GetStatus frente a GetCameras.
4. Incorporar evidencia verificable, con versión de regla y fixtures anonimizadas, y
   distinguir incomplete de unknown. Si la API no ofrece prueba suficiente, mantener
   unknown; no activar inferencias de ausencia.

## Pruebas

Fixtures y transporte inyectado cubren sincronización manual, fallos independientes,
401, timeouts antes/después de cabeceras, vacíos, incompletitud desconocida, duplicados,
reintentos, replay sin red, origen/config_key inválidos, abandono y resultados tardíos.
Las pruebas de carrera de este paso usan un colector pausado y reserva reemplazada en
PGlite; la rama IN_PROGRESS usa un doble de base. No son un nuevo ensayo multiproceso
nativo. Antes de activar la función real debe repetirse esa integración con conexiones
PostgreSQL independientes en un entorno expresamente autorizado.

## Evidencia local — 2026-10-23

La versión final compiló y aprobó **160 pruebas con Node 22.23.4**, cero fallidas y
cero omitidas dentro del conjunto seleccionado. Se excluyó expresamente
`database-native.test.ts`: no hubo PostgreSQL externo ni comandos Docker en este paso.
PostgreSQL 17 embebido/PGlite ejecutó migraciones, escritor, roles sintéticos y
coordinador; el transporte fue simulado. El conjunto incluye 25 pruebas nuevas del
colector/coordinador y una prueba nueva de validación atómica del historial de intentos.

Node 22 ARM64 se ejecutó desde un directorio temporal, sin instalarlo en el sistema
ni reemplazar Node 26. Se verificó el SHA-256 del archivo contra el manifiesto oficial
servido por nodejs.org vía HTTPS. Esa descarga fue el único acceso externo necesario
para la validación; no se usó VPN ni destinos Digifort reales.

No se modificaron contenedores, redes, roles reales ni bases persistentes. Las
migraciones conservan sus hashes conjuntos up/NUL/down:

- 001_inventory: `ccc33e8e1c618656a0e1199ccdbc6c4781073638567d2b152e64ddccd1899a8d`.
- 002_sync_observations: `fa14f373b157f9fcf9ad4d2846fa6990be20d197d0d543100f31503f5567ce05`.

No hubo commits ni pushes. Los ensayos nativos de etapas anteriores son evidencia
histórica; no se presentan como una nueva validación multiproceso del coordinador.
