# Fase 3B, paso 3 — escritor transaccional

> Regla vigente: [Description como fuente oficial](description-identity.md). Desde esta corrección, Name es sólo la clave técnica exacta; no hay fallback automático. Las referencias anteriores a Name como fuente son históricas.

Estado: módulo explícito, sin llamadas de red, scheduler, rutas HTTP ni activación al
arrancar. Usa 001/002/003 intactas y requiere 004_description_identity. Description es la única fuente de candidatos
municipales; el delimitador opcional no pertenece al código. Nunca asigna códigos,
modifica UUIDs ni fusiona identidades.

El [paso 4](manual-synchronization.md) incorpora un colector y coordinador explícitos. El escritor admite ahora historial opcional de intentos (`attempts`) y evidencia opcional de respuesta recibida, sin modificar migraciones.

El [paso 5](identity-review.md) integra detección y evidencia de propuestas en la transacción del escritor; requiere 003/004, sin modificar 001/002/003 ni habilitar correcciones.

## Contrato de uso

`src/sync/index.ts` exporta `beginServerSync`, `writeServerSnapshot` y sus tipos.
Cada llamada recibe una conexión dedicada e inactiva compatible con
`MigrationConnection` (por ejemplo un cliente pg reservado del pool). No pasar un
pool que distribuya sentencias entre conexiones, una conexión compartida o una
transacción ya abierta. El módulo no abre conexiones ni resuelve credenciales.

1. `beginServerSync(db, { serverId, requestKey, leaseMs? })` exige servidor habilitado,
   no retirado, y requestKey UUID estable por ejecución lógica. Devuelve runId,
   serverRunId, secuencia y token. Lease predeterminado 30 segundos, máximo 5 minutos.
2. El colector externo consulta ambos endpoints fuera de la transacción del escritor.
   Debe registrar tiempos de recepción UTC y resultado tipado de cada endpoint.
3. `writeServerSnapshot(db, execution, observation, options?)` consume exactamente
   GetCameras y GetStatus. Si ambos tienen éxito exige snapshot normalizado y conteos
   coherentes. Si alguno falla no aplica ninguna cámara, aunque se aporte snapshot.
4. Un resultado terminal del mismo identificador se devuelve como replay sin evaluar
   ni aplicar un nuevo payload. Para una consulta posterior, incluida recuperación
   después de un fallo de endpoint, usar otro requestKey. Una reserva fallida no
   deja una ejecución parcial. Un error de aplicación conserva la reserva previa
   como running y permite reintentar mientras el lease siga vigente.

El conector actual sólo ofrece cámaras asociadas y conteos matched/missing/orphan.
No ofrece tiempos/HTTP por endpoint ni prueba de completitud. No fabricar esos datos
para conectar el escritor. El adaptador de colección sigue pendiente; el contrato
actual del conector y del parser no se modifica. Completeness debe ser explícita:
complete, incomplete o unknown. HTTP 200 y lista vacía no certifican completitud.

Este paso crea una ejecución global manual por servidor. No implementa un coordinador
que comparta una ejecución global entre varios servidores ni agregue sus resultados.

## Algoritmo y bloqueo

La reserva usa bloqueo asesor por requestKey y bloquea la fila del servidor antes
que su control. Incrementa secuencia y toma token mediante UPDATE condicional sobre
lease libre/vencido; inserta ejecución global y de servidor en la misma transacción.
La revisión de configuración queda fijada. Una reserva repetida devuelve la misma
identidad, sin renovar/revivir un lease vencido ni apropiarse de otro trabajador.

El escritor bloquea servidor, control y ejecución en ese orden. Rechaza token,
secuencia o revisión antiguos, servidor deshabilitado/retirado y lease vencido.
Esta ordenación evita que la actualización de salud y una reserva concurrente
bloqueen entidades padre/control en sentidos opuestos.

Valida tiempos y conteos, registra ambos intentos y prepara cámaras/vínculos por
Name exacto. Para Name nuevo crea UUID provisional con código NULL y vínculo propio;
no reutiliza cámaras por código, IP, Description o ubicación. Un vínculo retirado
no se reactiva implícitamente. Una reutilización de Name tras cierre explícito toma
la siguiente generación. Name distinto o código nuevo no cierra el vínculo anterior.
Un cambio físico con el mismo Name no es detectable sin evidencia administrativa.

Busca códigos confirmados y candidatos vigentes de otras cámaras para registrar
conflictos, pero nunca asigna ni corrige un código. Conserva códigos aceptados aunque
Name sea incompatible. Catálogo de tipos consultado en la base; valid es un candidato,
no una aprobación. Conflictos detectados sólo por consultas no constituyen una reserva
global: candidatos simultáneos en servidores diferentes pueden requerir un ciclo
posterior para detectar el conflicto. Esto no habilita asignaciones ni fusiones.

Antes de escribir inventario/historial, avanza aplicada y finaliza la ejecución dentro
de la transacción: los triggers de procedencia exigen ejecución ya aplicada. Nada se
hace visible parcialmente. Compara la proyección de inventario permitida, cierra/abre
versión sólo si cambió y avanza confirmación si es idéntica. Un cambio relevante con
fecha igual/anterior al inicio de la versión se rechaza en vez de crear período vacío.

Actualiza Active por sus fuentes, Working y grabación con NULL real. Compara valores
semánticos, vínculo y cobertura; crea evento sólo por cambio, primera observación o
reanudación. FPS y demás métricas numéricas van al estado actual, no a la clave de
transición. No presupone unidades nuevas. La vuelta después de fallo o hueco de
observación inicia época nueva, aunque los flags coincidan.

Actualiza salud independientemente: 401/403 implica respuesta, timeout genérico no
prueba unreachable, y fallo parcial queda partial. Un resultado invalid_response
acredita una respuesta recibida aunque el colector no conserve HTTP status. Las
fechas de respuesta sólo avanzan con evidencia de respuesta. Fallos de endpoint
conservan todas las filas de cámaras, sus timestamps y eventos.

Antes de COMMIT comprueba de nuevo el lease con reloj de PostgreSQL y lo libera.
Si venció durante la escritura revierte todo. Mientras dura la transacción el bloqueo
impide que otro trabajador aplique datos; después sólo un token vigente puede hacerlo.
Un error SQL revierte snapshots, diagnósticos y finalización de ese intento. Sale como
SnapshotWriterError sin causa/SQL/payload; no se escribe un PERSISTENCE_FAILED en una
segunda transacción automáticamente. La reserva permite retry; recuperación de runs
abandonados requiere otro paso explícito, no un scheduler oculto.

## Datos descriptivos y seguridad

La proyección conserva Description exacta como fuente oficial; omite Memo, modelo,
dirección, perfiles y grupos por defecto. selectInventoryText puede seleccionar modelo
y dirección; description, si se especifica, debe coincidir exactamente con la original.
Hay límite de tamaño y rechazo de URLs/autenticación obvias. Un Description sensible
aborta la transacción con error saneado, sin texto privado en diagnósticos. No se
almacenan DTOs completos ni respuestas remotas. Name exacto sigue en su vínculo.

La versión nueva es description-v1. Un cambio desde una versión name-v1 crea una nueva
versión de inventario mediante una observación nueva; no reescribe el inventario previo,
UUID ni código confirmado. Requiere migración 004. No utiliza Name como fallback.

## Limitaciones del esquema conservado

El trigger de 002 que protege camera_state_changes compara to_jsonb(NEW) antes de que
PostgreSQL recalcule columnas generadas. Actualizar sólo last_confirmed_at puede ser
rechazado cuando Active es conocido. No se altera ni se deshabilita el trigger:
**el escritor no actualiza confirmaciones de eventos de cámara**. Las confirmaciones
posteriores están en camera_current_state (timestamps y secuencia), unible a la
correspondiente ejecución por servidor/secuencia. El evento conserva la ejecución
de su transición inicial. Corregir el trigger requiere una migración posterior aprobada.

Inventario conserva la ejecución que creó la versión; observaciones idénticas no
reescriben esa referencia. Las ejecuciones e intentos conservan las consultas posteriores.
Las omisiones, incluso en inventarios declarados completos, no marcan ausencia, retiro,
fallo ni eliminan cámaras. La política de ausencias, retención, permisos del worker,
reconciliación, clasificación completa de red y colección real quedan pendientes.
No se habilitan privilegios ni se usa el rol de aplicación para esta implementación.

## Validación

La suite compartida ejecuta snapshots iniciales/repetidos, cambios Active/Working,
NULL, fallback, FPS sin transición, versionado, nuevos nombres sin código, duplicados,
conservación de códigos confirmados, reemplazos sin fusión, incompletitud, omisiones,
fallos HTTP/transporte/parseo/configuración, rollback inyectado, tiempos/ejecuciones
atrasados y vencimiento antes/durante la transacción. PostgreSQL nativo verifica espera
real entre dos trabajadores al reservar y al aplicar la misma ejecución, con replay
del segundo sin duplicar cámaras ni eventos. Todas las fixtures son sintéticas.

## Resultado local — 2026-10-23

La versión final compiló y aprobó **180/180 pruebas**, sin fallos ni omisiones, bajo
Node 22.23.4 y PostgreSQL 17.11 ARM64. Incluye la suite completa de API, parser,
PGlite/roles, migraciones, escritor y concurrencia nativa. La suite embebida también
pasó bajo Node 26 durante desarrollo. No hay llamadas a Digifort real ni uso de VPN.

Se verificó desktop-linux con socket Unix local. PostgreSQL temporal en tmpfs,
network none, ejecutor compartiendo sólo ese espacio de red y SQL de pruebas montado
para lectura. Sin puertos, volúmenes persistentes ni redes nuevas. Se retiraron los
contenedores y la imagen exclusivos. En el ensayo final, los metadatos registrados
de los contenedores, redes y volúmenes preexistentes fueron idénticos antes/después.

Un ensayo anterior, también con las pruebas aprobadas, detectó cambios de ID/fecha de
bridge y aparición de metadata Status en la inspección de redes; no hubo comandos
modificadores de redes y su causa no se determinó. La verificación final idéntica no
borra esa observación. Ninguna operación intentó restaurar ni alterar recursos ajenos.

001 conserva checksum `ccc33e8e1c618656a0e1199ccdbc6c4781073638567d2b152e64ddccd1899a8d`;
002 conserva checksum `fa14f373b157f9fcf9ad4d2846fa6990be20d197d0d543100f31503f5567ce05`.
No se editaron las migraciones en este paso. No hubo commits ni pushes.

Si se pierde la respuesta a COMMIT, el error saneado no acredita que el servidor haya
revertido: reintentar con la misma ejecución permite resolver el resultado consultando
su estado terminal sin reaplicar datos. No crear otra identidad de ejecución como
respuesta automática a una confirmación incierta.
