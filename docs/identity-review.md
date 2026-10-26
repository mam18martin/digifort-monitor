# Fase 3B, paso 5 — propuestas y revisión de identidad

> Regla vigente: [Description como fuente oficial](description-identity.md). Desde esta corrección, Name es sólo la clave técnica exacta; no hay fallback automático. Las referencias anteriores a Name como fuente son históricas.

Estado: detección, registro y revisión conservadora implementados. Sin aplicación de
identidad, fusiones, traslado de historial, scheduler ni consultas remotas. Este paso
no modifica 001_inventory ni 002_sync_observations.

## Alcance y decisiones conservadoras

La documentación general proponía correcciones y aprobaciones, pero todavía no están
definidos el operador autorizado, la reserva histórica de códigos, la política de
reemplazo físico ni la evidencia suficiente para continuidad entre UUIDs. Por tanto:

- se detectan automáticamente candidatos duplicados y discrepancias entre Description y
  código confirmado;
- comparar dos vínculos para proponer un posible renombrado o reemplazo exige una
  hipótesis explícita de un operador, sin afirmar continuidad física;
- se permiten notas y rechazo de propuestas, con auditoría y revisión optimista;
- approve, resolve, merge y apply quedan bloqueados con POLICY_REQUIRED, también sin
  una ruta SQL normal que permita esos estados;
- ninguna revisión cambia cameras.identity_review, códigos, UUIDs, vínculos ni eventos.

Los estados de propuesta son pending, approved, rejected y resolved (pendiente,
aprobado, rechazado y resuelto). Sólo pending y rejected son alcanzables en esta
entrega; approved/resolved están reservados para una política y operación posteriores.
Rechazar significa descartar la hipótesis de ese expediente, no corregir datos ni
silenciar automáticamente nuevos diagnósticos del conector.

## Migración 003_identity_review

| Tabla | Contenido y protecciones |
| --- | --- |
| identity_proposals | Tipo, entidades/vínculos/versiones, primera ejecución, códigos observados/confirmados, origen, operador de alta, fecha, estado y revisión |
| identity_proposal_evidence | Evidencia por propuesta/ejecución, versiones de inventario e incidencia saneada de sync_issues |
| identity_review_events | Decisiones inmutables: operador UUID, fecha PostgreSQL, motivo de catálogo, acción, revisión esperada/resultante y requestKey idempotente |

Los índices cubren cola por estado/fecha, cámara, contraparte, ejecución y auditoría.
El índice parcial hash por Name exacto admite búsquedas de igualdad sin imponer un
límite de longitud nuevo al contrato de Name. Todas las FK usan RESTRICT; no hay
CASCADE ni eliminación de historia por una decisión.

Las propuestas se insertan pending, revision=1. Su evidencia de origen debe pertenecer
a una ejecución aplicada y a la cámara/vínculo observado. Los códigos se verifican
contra Description original de la versión description-v1 mediante el helper SQL de
004. Cada propuesta tiene code_source; las anteriores conservan Name y no se reetiquetan.
Name exacto sigue en su vínculo como clave técnica, sin duplicarse en diagnósticos.

La evidencia posterior debe corresponder a una observación aplicada de la cámara y
al servidor de su ejecución. Su incidencia usa IDENTITY_CONFLICT y referencias, sin
mensajes remotos, URLs, credenciales, coordenadas ni Description. La contraparte puede
ser histórica: ello sólo acredita la observación anterior, no que esté ausente hoy.
Un propietario de código sin vínculo/inventario abierto también puede ser contraparte
por UUID/código confirmado, incluso retirado: no se libera su reserva.

## Detección y registro

El escritor llama al detector después de persistir TODO el inventario/estado y antes
de COMMIT. El detector comparte esa transacción. Un fallo de propuestas/evidencia
revierte también la aplicación completa del snapshot. No se ejecuta en fallos de
endpoint, ni al arrancar.

Para cada cámara observada:

1. Recalcula el candidato desde Description original de versiones description-v1,
   sin usar Name ni candidatos legados como fallback.
2. Si existe código confirmado distinto (incluido Description inválido), registra una
   discrepancia. No sobrescribe el confirmado.
3. Busca otras cámaras cuyo código confirmado o Description válida representen el candidato;
   registra un duplicado dirigido desde la cámara observada hacia la contraparte.
4. Mantiene UUIDs separados, aunque el código candidato coincida. No usa similitud de
   descripción, direcciones, proximidad ni desapariciones para fusionar o relacionar.

El bloqueo asesor transaccional de detección serializa el cierre de detecciones entre
servidores. El último detector puede ver candidatos del anterior al confirmar. No
bloquea filas de contrapartes en sentido inverso al orden servidor/control del escritor.
Su costo y alcance global requieren dimensionamiento antes de producción.

La clave de deduplicación es SHA-256 de fuente Description, tipo, UUIDs/vínculos y códigos capturados; no
incluye datos descriptivos ni la ejecución. Repetir el mismo hecho conserva propuesta
original y agrega como máximo una evidencia por ejecución. Cambiar sólo el texto descriptivo sin cambiar el candidato
no abre otra propuesta; un cambio de código candidato sí puede abrirla. Cambiar hechos de identidad puede crear otra propuesta.
Cada cámara/contraparte tiene su expediente dirigido: A→B y B→A no se fusionan como
expediente global. La agrupación de conflictos multinodo queda pendiente.

Una propuesta rechazada no se reabre por una nueva observación idéntica. La nueva
evidencia se conserva en el expediente, sin cambiar decisión ni revisión. Un rescan
explícito sólo acepta la última secuencia aplicada del servidor; no atribuye versiones
actuales a ejecuciones históricas que ya no las observaron.

## Servicios explícitos

`src/identity/index.ts` exporta:

- detectIdentityProposals(db, serverRunId): reescaneo de la última ejecución aplicada;
- registerIdentityHypothesis(db, {kind, serverRunId, bindingId, relatedBindingId,
  operatorId}): registra possible_rename o possible_replacement;
- readIdentityProposal(db, proposalId): lectura consistente de campos permitidos,
  evidencia y auditoría; informa applicationBlocked=true;
- reviewIdentityProposal(db, {proposalId, requestKey, expectedRevision, operatorId,
  action, reasonCode}): nota o rechazo;
- applyIdentityProposal(...): bloqueo explícito sin lectura ni escritura de identidad.

Cada servicio público requiere conexión dedicada e inactiva. register exige que el
vínculo sujeto haya sido observado en la ejecución aplicada actual; la contraparte
puede ser su última versión histórica. possible_rename exige Name distintos y
possible_replacement códigos sintácticos distintos. Esos controles no demuestran que
sea la misma cámara o ubicación: sólo validan que la hipótesis tenga referencias
coherentes. No se generan esas relaciones automáticamente cuando cambia Name, porque
el escritor crea otro UUID y el contrato no proporciona continuidad física verificada.

Un nuevo registro idéntico devuelve el expediente existente, sin sustituir al operador
que lo creó. Otro operador puede dejar una nota auditada con su propia identidad.
Los motivos disponibles son evidence_reviewed, insufficient_evidence,
incorrect_hypothesis, duplicate_observation y requires_policy. No se admite motivo
libre ni texto potencialmente secreto.

## Revisión, concurrencia y auditoría

Cada decisión incluye expectedRevision como cadena bigint. El trigger bloquea la
propuesta y compara la revisión antes de incrementarla y permitir pending→pending
(nota) o pending→rejected. Dos decisiones basadas en la misma revisión no pueden
confirmarse ambas. No se permite editar directamente estado/revisión, actualizar
una decisión ni eliminar propuestas/evidencias/auditoría por operaciones DML normales.
Un fallo de inserción de auditoría revierte también el cambio de revisión/estado.

requestKey está protegido por bloqueo asesor transaccional: el mismo comando repetido
produce el mismo recibo sin otra decisión. Reutilizar la clave con otro actor, motivo,
acción o propuesta devuelve IDEMPOTENCY_CONFLICT. Un replay devuelve la revisión de
su decisión original, no pretende ser la revisión actual del expediente.

El UUID de operador es una referencia opaca suministrada por un contexto autenticado
confiable. Esta función NO autentica ni autoriza un operador: no existe todavía el
modelo de usuarios/roles de revisión. No exponerla como endpoint que confíe en un UUID
enviado por el usuario. No se otorgan permisos a monitor_app ni se crean roles reales.
Owner/superusuario pueden alterar triggers/objetos: las protecciones no sustituyen la
separación de privilegios ni la futura autenticación.

La concurrencia optimista actual protege decisiones del expediente. Como NO se permite
aprobación ni aplicación, no hay aprobaciones incompatibles que puedan alterar cámaras.
Una implementación futura deberá comprobar revisiones de todas las entidades y
reservas involucradas, no sólo reutilizar la revisión de esta propuesta.

## Migraciones y pruebas

El migrador empaqueta ahora 001/002/003. Conserva checksums por archivo up/down,
validación del prefijo de ledger, bloqueo asesor y transacción de lote. Down conserva
su semántica de retirar TODAS las versiones aplicadas: 003→002→001. Es destructivo,
no una recuperación de datos ni un comando para deshacer una decisión de revisión.
No aplica migraciones al arrancar ni a la base principal.

Las pruebas cubren duplicados, discrepancia confirmada, Name cambiado y posible
reemplazo sin unión de UUIDs, auditoría, rechazo de acciones bloqueadas, idempotencia,
revisión obsoleta, rollback de decisión y rollback completo del snapshot cuando falla
la evidencia. La actualización 002→003 preserva datos/ledger anterior y verifica fallo
atómico, checksum, reversión y reaplicación. PostgreSQL nativo prueba dos conexiones
esperando por la propuesta y por el requestKey, con un único ganador/evento de auditoría.

## Decisiones de negocio pendientes

1. Quién puede proponer, rechazar, aprobar y aplicar; si se exige segunda aprobación.
2. Qué prueba acredita renombrado/continuidad física o reemplazo, y qué representa el
   activo monitoreado. Un reemplazo físico puede recibir código nuevo.
3. Política de asignación inicial, corrección, revocación y reserva/reutilización de
   códigos; 001 continúa bloqueando cambios de códigos ya asignados.
4. Qué significa resolver sin aplicar y cuándo reabrir o agrupar expedientes.
5. Revisión por entidad, permisos mínimos de consulta/escritura, UI autenticada,
   retención y revisión de seguridad antes de activar datos reales.

Ninguna de estas decisiones se presume por disponer de tablas o por registrar una nota.

## Evidencia local — 2026-10-23

La versión final compiló y aprobó **220/220 pruebas con Node 22.23.4 y PostgreSQL
17.11 ARM64**, sin fallos ni omisiones. Incluye las 11 pruebas de revisión, las dos
carreras nativas y las suites anteriores del conector, escritor, coordinación,
migraciones y roles sintéticos. La suite local sin PostgreSQL externo también pasó
con 171 pruebas en Node 22 y PostgreSQL 17 embebido.

En las carreras nativas se verificó espera real mediante pg_blocking_pids(): dos
revisiones incompatibles basadas en la misma versión dejan un ganador; dos comandos
idénticos simultáneos producen un único evento de auditoría y replay del segundo.

Docker Desktop usó proyecto exclusivo, PostgreSQL en tmpfs, network none y ejecutor
compartiendo sólo su espacio de red para loopback. Sin puertos, volúmenes persistentes
ni redes nuevas. Se retiraron contenedores e imagen exclusivos. En el ensayo final,
la comparación completa de recursos preexistentes fue idéntica antes/después.

Un ensayo anterior con pruebas aprobadas detectó cambios de ID/fecha de bridge y
aparición de metadata Status en redes. Los contenedores y volumen preexistentes no
cambiaron, y no se ejecutaron comandos modificadores de redes. La causa no se
determinó; la comparación final idéntica no elimina esa observación previa.

No hubo consultas a Digifort, VPN, aplicación sobre bases persistentes, cambios de
roles reales, commits ni pushes. 001 y 002 mantienen los hashes conjuntos anteriores.
003 tiene checksum up/NUL/down:
`a5d44133044e060c78e5d3ac8fa62c6f2713bbd244f6b36fe910d666aaa252cb`.

## Consulta web de solo lectura

La pantalla Identidades expone propuestas, evidencia y auditoría sin operaciones de
revisión o aplicación. También proyecta cámaras sin código confirmado desde el
inventario actual. Ver [identity-web-review.md](identity-web-review.md) para API,
semántica de los filtros, escenarios y pruebas. No requiere otra migración.
