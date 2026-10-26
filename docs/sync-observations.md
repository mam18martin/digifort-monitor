# Fase 3B, paso 2 — seguimiento e historial

> Regla vigente: [Description como fuente oficial](description-identity.md). Desde esta corrección, Name es sólo la clave técnica exacta; no hay fallback automático. Las referencias anteriores a Name como fuente son históricas.

Estado: estructuras y pruebas sintéticas implementadas. Sin escritor de snapshots,
scheduler, consultas reales ni aplicación a bases persistentes. El contrato de
`municipalIdentity` del paso 1 permanece intacto: fuente exclusiva Description, delimitador
terminal obligatorio, código completo sin `)`, ceros preservados y candidatos
separados de asignaciones aprobadas. Name sólo es la clave técnica y no aporta un fallback.

El escritor explícito implementado posteriormente, sus pruebas y las limitaciones del trigger de confirmación están en [snapshot-writer.md](snapshot-writer.md).

## Migraciones y compatibilidad

`001_inventory` conserva ambos archivos y el checksum
`ccc33e8e1c618656a0e1199ccdbc6c4781073638567d2b152e64ddccd1899a8d`.
`002_sync_observations` agrega ocho tablas, funciones de integridad y referencias
opcionales en tablas existentes, sin cambiar códigos, vínculos ni datos municipales.
No hay seeds de infraestructura, roles nuevos ni permisos de aplicación nuevos.

El migrador conserva conexión dedicada, bloqueo asesor, timeouts y transacción.
Ahora valida que el ledger sea un prefijo completo y ordenado de la lista empaquetada,
con checksum por par up/down. Up aplica todas las pendientes en una transacción;
una base con 001 puede actualizarse sin reaplicarla. Un fallo de 002 conserva 001
previamente confirmada y revierte todo el DDL y ledger de la actualización.

**Down conserva la semántica anterior de vaciar el esquema versionado:** revierte
TODAS las versiones aplicadas, ahora 002 y después 001, en una sola transacción.
No significa «revertir sólo la última». Es destructivo y sigue exigiendo autorización
explícita y `MIGRATION_ALLOW_DOWN=yes` en el CLI. Sin CASCADE; dependencias externas
bloquean y revierten la operación. Ledger vacío y extensión compartida se conservan.
El argumento programático `through` limita el conjunto empaquetado para pruebas de
actualización desde 001; no es un comando CLI de rollback parcial.

## Tablas y relaciones

| Tabla | Función y restricciones principales |
| --- | --- |
| `sync_runs` | Ejecución global con `request_key` UUID único para idempotencia, origen controlado, resultado y fechas finitas coherentes |
| `server_sync_control` | Una fila por servidor; secuencias emitida/aplicada monótonas, aplicada <= emitida; token UUID y vencimiento juntos; no permite DELETE para resetear secuencias |
| `sync_server_runs` | FK a ejecución y servidor; únicos por ejecución/servidor y servidor/secuencia; revisión, token, fechas, resultado, conteos y completitud; aplicación sólo en success/partial |
| `sync_endpoint_attempts` | GetCameras/GetStatus, intento único, fechas, HTTP, resultado, error de catálogo, bytes, filas y completitud; sin contenido remoto |
| `sync_issues` | Código, etapa, severidad y reintentabilidad; FK opcionales a cámara/vínculo e intento de la misma ejecución; sin mensajes libres ni objetos JSON |
| `camera_state_changes` | Cámara, vínculo, servidor y ejecución aplicada; secuencia única por cámara, época y fechas; Active/Working independientes y nullable; Active derivado por fuente; cobertura, grabación y motivo |
| `server_health_changes` | Historial ordenado por servidor con ejecución, transporte y resultado de consulta separados; un error de autenticación exige transporte responding |
| `server_current_health` | Puntero compuesto a evento propio y secuencia; fechas de intentos/respuesta/éxito y contador de fallos; evita duplicar flags que contradigan el historial |

`camera_current_state.last_state_change_id` referencia un evento de la misma cámara.
`camera_inventory_versions.source_server_run_id` referencia una ejecución aplicada
del servidor de su vínculo. Ambas referencias son opcionales para admitir filas
anteriores y altas provisionales. No se crea un historial ficticio al migrar.

Índices cubren ejecuciones por fecha, ejecuciones por servidor, incidencias por
cámara/ejecución, historia de cámara/servidor, vínculos y procedencia de inventario.
Todas las FK usan RESTRICT: no hay borrados en cascada ni purga automática.

## Orden, leases e integridad

El futuro escritor deberá adquirir el lease con un UPDATE condicional que bloquee
la fila y sólo tome un lease libre/vencido, incrementando `issued_sequence` y
asignando un token nuevo. No basta un SELECT seguido de UPDATE incondicional.
La adquisición concurrente con dos conexiones se prueba en PostgreSQL nativo.

Una ejecución nueva exige token, secuencia emitida y revisión actuales, y lease
vigente. Para finalizar una aplicación, la misma transacción debe verificar el lease,
avanzar `applied_sequence` y finalizar la ejecución; el trigger comprueba coincidencia
y bloquea el control del servidor. La fila terminal queda inmutable. El trigger no
implementa planificación, renovación, recuperación de leases ni el escritor.
Las finalizaciones fallidas/abandonadas no necesitan un lease todavía vigente.

Las observaciones de cámara requieren ejecución terminada y aplicada, vínculo del
mismo servidor/cámara y tiempo observado dentro de ejecución y vínculo. La salud
puede referenciar una ejecución fallida, sin modificar flags de cámaras. Los eventos
bloquean su entidad padre para ordenar inserciones concurrentes, rechazan retrocesos
de secuencia, tiempo y época, incluida la secuencia de ejecución de origen para
un mismo servidor; hay un evento por entidad/ejecución como máximo.

El contenido semántico del historial es inmutable. Sólo la confirmación del último
evento puede avanzar. Intentos e incidencias son inmutables; los conteos de incidencias
se fijan al insertarlas. La deduplicación semántica y el avance coordinado de estado
actual/historial quedan para el escritor: la base no genera transiciones automáticamente.
El puntero de estado actual asegura pertenencia, pero no sustituye esa transacción.

Los conteos de asociación deben cuadrar: matched + missing = inventario y matched +
orphan = estados. Success exige aplicación, inventario completo y ausencia de
huecos/huérfanos; snapshots con completitud desconocida podrán aplicarse como partial.
Los intentos exitosos exigen HTTP 2xx, sin error y con cantidad de filas conocida.
Los fallidos no fabrican filas cero ni completitud completa. No se deriva completitud
a partir de HTTP 200 o de una lista vacía. La consistencia de resultados entre ambos
endpoints y el resultado global debe resolverla el futuro escritor en su transacción.

## Seguridad y reconciliación futura

Diagnósticos sólo admiten códigos de catálogo y campos tipados. No admiten Name,
Description, credenciales, URLs, stacks ni respuestas completas. Los nombres técnicos
permanecen en los vínculos existentes. Las referencias de incidencia preparan una
futura revisión de identidad sin implementar asignaciones, correcciones, fusiones ni
reutilización de códigos. Un reemplazo físico puede recibir un código nuevo.

No se añaden permisos de worker: aplicación continúa sin DDL ni acceso a negocio.
Owner/superusuario pueden alterar objetos o truncar: las protecciones no sustituyen
la separación de roles. El rol de ingestión futuro no debe ser propietario.

## Pruebas y pendientes

La suite compartida PGlite/PostgreSQL 17 comprueba actualización 001→002, preservación
de datos/checksum, fallo atómico de 002, idempotencia, alteración del ledger, rollback,
reaplicación, leases vencidos/tokens/revisiones, cobertura, diagnósticos, nueve pares
Active/Working, procedencia y separación de salud. La suite nativa añade concurrencia
real de leases, ejecutores, códigos y exclusiones temporales. No se ejecuta contra
el servicio db principal. Las pruebas nativas siguen requiriendo opt-in y base vacía
`digifort_test_isolated`.

Pendientes: escritor transaccional e idempotencia semántica, verificación de completitud,
permisos de ingestión, políticas de reconciliación, retención/purga y agregación global.
No se implementa `sync_policies` ni retención activa: frecuencia/frescura y límites se
aprobarán antes del scheduler. No se implementan tablas de correcciones municipales.
Cualquier aplicación real sigue bloqueada por backup restaurado, roles, destino,
artefacto revisado y autorización operativa independiente.

## Evidencia local — 2026-10-23

En Docker Desktop local ARM64 se ejecutó `npm run build` y la suite completa bajo
Node 22.23.4, con PostgreSQL 17.11 nativo y PGlite 17: **140 pruebas aprobadas,
cero fallidas y cero omitidas**. El bloque nativo contiene 24 subpruebas más su
prueba contenedora. Se comprobó espera real entre conexiones para adquisición de
lease y conservación del token ganador. También se ejecutó previamente la suite
embebida bajo Node 26 durante el desarrollo.

Se utilizó un proyecto Compose temporal con PostgreSQL en tmpfs y network none;
el ejecutor compartió su espacio de red para acceder por loopback. Sin puertos,
volúmenes persistentes ni redes nuevas. SQL de roles montado sólo para lectura en
el ejecutor; las pruebas de roles de la suite completa usan PGlite en memoria.
No se ejecutaron consultas sobre contenedores de base preexistentes.

Se retiraron contenedores e imagen exclusivos del ensayo. Los metadatos registrados
de los seis contenedores preexistentes y el volumen permanecieron iguales. Sin
embargo, la comparación completa de redes no fue idéntica: bridge cambió de ID y
fecha de creación, y apareció información Status en la inspección de las redes.
La configuración previa de redes se mantuvo, sin comandos de creación/modificación
ni eliminación de redes en el ensayo. La causa de esos cambios no se determinó;
no se certifica inmutabilidad completa del entorno Docker a partir de este ensayo.
No se ejecutaron operaciones para restaurar o modificar recursos ajenos.

Tras añadir la comprobación explícita de secuencia de ejecución de origen, se repitió
la suite completa: **140/140**, compilación exitosa y salida 0. En este ensayo final
la comparación completa de contenedores, redes y volúmenes preexistentes fue idéntica,
y se retiraron los recursos temporales. Esto acredita esa ventana final; no elimina
la variación de metadatos de redes registrada durante el ensayo anterior ni determina
su causa.
