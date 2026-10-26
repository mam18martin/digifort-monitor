# Fase 3A: migración inicial de inventario

> Regla vigente: [Description como fuente oficial](description-identity.md). Desde esta corrección, Name es sólo la clave técnica exacta; no hay fallback automático. Las referencias anteriores a Name como fuente son históricas.

**Plan vigente de desbloqueo:** [phase3a-unlock-plan.md](phase3a-unlock-plan.md) incorpora separación de roles, servicio de mantenimiento y direccionamiento condicionado a IPAM. Sustituye el uso del rol privilegiado en las antiguas secciones E/F de preaplicación. Los comandos históricos no autorizan cambios. El CLI ahora exige `MIGRATION_OWNER_ROLE` y rechaza logins elevados.

## Ampliación de Fase 3B, paso 2

Se agrega `002_sync_observations` y un migrador de versiones ordenadas. El alcance,
restricciones y semántica de rollback completo están en [sync-observations.md](sync-observations.md).
Las secciones siguientes describen el artefacto 001 y su evidencia histórica; sus
conteos de una versión/siete tablas no validan por sí solos el paquete ampliado.
Up ahora aplica las pendientes 001/002; down retira ambas en orden inverso, no sólo
la última. Ninguna migración se aplica al arrancar la API. No se aplicó este paquete
a una base persistente ni se levantó ingestión.

## Fase 3B, paso 5

`003_identity_review` añade propuestas, evidencia y auditoría de revisión. El migrador aplica ahora las pendientes de 001/002/003; down retira las tres en orden inverso. 001/002 conservan sus checksums. Ver [identity-review.md](identity-review.md). No se aplicó este paquete a bases persistentes ni se habilitan correcciones de identidad.

## Alcance y estado

Se incorpora `001_inventory` con SQL de subida y reversión, un ejecutor transaccional explícito y pruebas de integridad. No había herramientas de migración ni DDL versionado en el proyecto: la API sólo ejecutaba `SELECT 1` para readiness. Durante la implementación inicial no se inspeccionó ni modificó la base principal. La sección de preaplicación al final registra la inspección READ ONLY posterior; todavía no se aplicó ninguna migración principal.

La migración define siete tablas de negocio: `nodes`, `camera_types`, `digifort_servers`, `cameras`, `camera_bindings`, `camera_inventory_versions` y `camera_current_state`. `schema_migrations` es la tabla técnica del ejecutor. No hay seed municipal: únicamente D/Domo, F/Fija y P/Punto Seguro. No se implementan ingestión, scheduler, consultas a Digifort, rutas Fastify nuevas ni cambios del frontend.

El diseño completo sigue en [database-design.md](database-design.md). Esta fase implementa un subconjunto deliberado; las decisiones conservadoras siguientes prevalecen sobre las propuestas aún no implementadas.

## Integridad implementada

- `cameras.id` es UUID; `camera_number` y `camera_type_code` son texto. `camera_code` es una columna generada por concatenación y tiene UNIQUE global, incluso para cámaras retiradas. Ambos componentes se asignan juntos o permanecen NULL.
- No hay unicidad del número aislado. Los ceros iniciales se conservan como identidad distinta. Se admiten múltiples cámaras provisionales sin código.
- `camera_types` es un catálogo, no un enum cerrado. Una letra mayúscula nueva se agrega mediante alta explícita; las letras desconocidas o deshabilitadas no pueden asignarse a un código aceptado. Deshabilitar un tipo no destruye códigos existentes.
- Una cámara recibe una fila de estado desconocido mediante trigger al insertarse. Active se deriva de `status_active` con alternativa a `inventory_active`, sin convertir FALSE en desconocido. Working permanece separado; ambos admiten NULL. Los timestamps y cobertura deben ser compatibles con los valores observados.
- No se almacenan username, password ni tokens. `digifort_servers` guarda sólo origen HTTP/HTTPS sin userinfo/query/ruta y una referencia opaca opcional al proveedor de secretos. Los servidores se crean deshabilitados por defecto; eso no habilita ninguna tarea.
- Los vínculos unen nombres técnicos exactos por servidor. Los períodos son semiabiertos `[valid_from, valid_to)`, con NULL como final abierto. Se impiden solapamientos por cámara, por servidor/Name y por servidor/ID externo no nulo, incluidos períodos históricos. Los intervalos adyacentes se admiten. Nombre, cámara, servidor y generación de un vínculo existente son inmutables; para cambiar relación se cierra y agrega otro.
- El ID externo es opcional: no se deduce ni se rellena con el código municipal. La generación diferencia reutilizaciones de una clave técnica, sin fusionar UUIDs. Se admite el mismo Name en servidores distintos o con diferencias de mayúsculas.
- Inventario versionado conserva `description_original` y `description_text` como datos distintos: la base no vuelve a interpretar ni recortar Description. Desde 004, el candidato municipal se obtiene exclusivamente de Description, con delimitador opcional y sin fallback desde Name. El futuro escritor debe aplicar redacción de secretos y tratar ambos campos descriptivos independientemente de la identidad; este paso no cambia el SQL.
- Se conservan candidatos inválidos, duplicados o de tipo desconocido sin convertirlos en códigos aceptados. No se exige unicidad ni FK de catálogo a esos candidatos. Los errores del formato municipal de Name no impiden mantener la cámara provisional, su vínculo o sus estados.
- Las versiones no se solapan por cámara y deben estar contenidas en el vínculo de esa cámara; FK compuestas impiden utilizar vínculos ajenos. Nodo, cámara y servidor tienen relaciones explícitas.
- Los metadatos de una versión son inmutables; sólo se permite cerrarla una vez y avanzar su última confirmación sin retroceder ni exceder su período. El estado actual sólo referencia un vínculo abierto propio. No se puede cerrar un vínculo mientras su inventario exceda el cierre o el estado actual lo siga referenciando.
- Secuencia aplicada y época de observación no retroceden. Esto no implementa por sí solo idempotencia o control de un worker: faltan ejecuciones y escritor transaccional.
- No hay FK con borrado en cascada. Se bloquean DELETE de cámaras, vínculos, versiones y estado actual para preservar trazabilidad; los padres referenciados tampoco se pueden eliminar. Se usa retiro/cierre lógico. Un propietario o superusuario todavía puede alterar, truncar o deshabilitar protecciones: el rol futuro de ingestión no debe ser propietario ni tener esos permisos.

Índices: unicidad de códigos y claves de catálogo/configuración; exclusiones GiST temporales; búsqueda de vínculos abiertos por servidor, inventario abierto por nodo, historia por cámara, FKs de vínculo y fecha del último snapshot exitoso. Las restricciones exclusivas también cubren las carreras de inserción en el PostgreSQL nativo.

## Límites conservadores y decisiones pendientes

1. **Corrección/reutilización de códigos:** después de asignar un código no se permite cambiarlo, revocarlo ni borrar la cámara para liberarlo. Una cámara provisional sí puede recibir su primera asignación. Se conserva así la reserva en su propia fila, sin introducir una política municipal de reutilización. `camera_code_registry`, `camera_code_changes` y las aprobaciones siguen fuera de esta fase; se necesita otra migración y operación auditada antes de permitir correcciones. No sortear el bloqueo editando triggers.
2. **Réplicas:** sólo un vínculo temporal por cámara a la vez, incluso en servidores distintos. La continuidad física, los reemplazos y la conservación de un código al reemplazar hardware requieren decisión administrativa; no hay reconciliaciones automáticas por Name, dirección, Description o código.
3. **Historial:** esta fase conserva vínculos e inventario por versiones. No implementa todavía historial de transiciones operativas, salud de servidor, ejecuciones, incidencias, política de retención ni almacenamiento de muestras. No debe habilitarse ingestión antes de completar esa trazabilidad y los permisos necesarios.
4. **Números y tipos:** se acepta una secuencia no vacía de dígitos ASCII sin el límite legado de 2–4; los ceros no se normalizan. El tipo es una letra ASCII mayúscula habilitada. Límite normativo de dígitos, equivalencias y aprobación de tipos nuevos siguen pendientes.
5. **Metadatos y unidades:** no se convierte ciegamente `ConnectionPort`, métricas o coordenadas. Sólo los valores normalizados válidos van a columnas tipadas; escalares seleccionados se preservan en JSONB con claves permitidas. La futura capa de escritura decide el mapeo y redacción: las métricas aún no tienen columnas numéricas con unidades supuestas.
6. **Frescura y disponibilidad:** hay timestamps, presencia y cobertura, pero no un contador de cámaras falsas ante una falla de red. El futuro escritor debe conservar observaciones ante errores de servidor y aplicar las reglas de completitud del diseño. No hay diagnóstico automático de servidor inaccesible en esta migración.

Los campos JSONB de compatibilidad aceptan sólo claves escalares de inventario/grabación conocidas; los metadatos libres siguen necesitando selección y redacción en el futuro escritor. Una restricción SQL no puede reconocer toda credencial oculta en texto permitido. No se habilitó ese escritor ni se guardaron datos reales.

## Ejecutar pruebas sin base externa

Desde `apps/api`:

```bash
npm ci
npm run build
npm test
npm run test:db
```

`test:db` crea PostgreSQL 17 embebido en memoria con PGlite 0.4.6 y `btree_gist`; verifica la versión mayor antes del SQL. No usa PGHOST, DATABASE_URL, el `.env` local ni conexiones TCP. La versión de PGlite se fija para conservar PostgreSQL 17: la rama 0.5 cambió a PostgreSQL 18, según su [changelog oficial](https://github.com/electric-sql/pglite/blob/main/packages/pglite/CHANGELOG.md). La extensión de índices está disponible en [PostgreSQL 17](https://www.postgresql.org/docs/17/btree-gist.html) y [PGlite](https://pglite.dev/extensions/).

Se prueban migración repetida, checksum, rollback, reaplicación con catálogo nuevo, reversión transaccional ante fallo, códigos completos duplicados, número repetido, NULL, ceros iniciales, tipos nuevos/deshabilitados, relaciones inválidas, contención/solapamiento de períodos, claves Name exactas, originales/sufijos y candidatos, ausencia de fusión por metadatos y estados independientes. También se prueba que el CLI rechace destino implícito y rollback no autorizado sin abrir una conexión.

## PostgreSQL 17 nativo aislado

Desde la raíz, en una sesión con acceso al daemon Docker:

```bash
docker compose -f compose.test.yaml config --quiet
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test-api
docker compose -f compose.test.yaml down
```

Esta composición es independiente de `compose.yaml`: nombre de proyecto propio, PostgreSQL 17 en tmpfs, sin puertos publicados, sin volumen de la aplicación y con red interna. Usa autenticación trust sólo dentro del entorno efímero de pruebas, sin credenciales guardadas. Nunca unir esta red a servicios municipales ni usar esa política para la aplicación. El test exige opt-in, nombre fijo `digifort_test_isolated`, base sin tablas públicas y versión mayor 17. Prueba también carreras de códigos y vínculos con dos conexiones: verifica espera real mediante `pg_blocking_pids()`, commit/rollback y serialización de ejecutores. Las pruebas embebidas no sustituyen esa validación de concurrencia.

CI ejecutará esta composición en un job dedicado, además de la compilación y pruebas normales. El servicio de pruebas no usa el Dockerfile de producción y no ejecuta migraciones sobre el servicio `db` principal. No combinar archivos con `-f compose.yaml -f compose.test.yaml`.

## Aplicación futura: revisión obligatoria del destino

No se ejecutó el CLI contra una base externa. La API no llama a migraciones al arrancar. Los scripts disponibles son `npm run migrate:up` y `npm run migrate:down`; la imagen compilada incluye el SQL y puede ejecutar `node dist/database/migrate-cli.js up` de forma explícita.

Antes de utilizarlos, configurar privadamente `MIGRATION_DATABASE_URL` y `MIGRATION_EXPECTED_DATABASE`, y fijar `MIGRATION_OWNER_ROLE` al propietario no login aprobado. No hay fallback a la conexión de la API ni carga de `.env`. El CLI verifica `current_database()` antes de modificar objetos, usa mensajes saneados y requiere `MIGRATION_ALLOW_DOWN=yes` para revertir. No escribir una URL autenticada en documentación, historial de comandos ni logs. El nombre esperado es una barrera contra errores, no un mecanismo de autorización ni una garantía de que un destino sea de pruebas.

Requisitos previos de una aplicación autorizada:

- Revisar esquema existente, backup recuperable y permisos del rol de migración; ensayar restauración/rollback en una copia aislada. Esta entrega no afirma que la base principal esté vacía.
- Aprovisionar `btree_gist` separadamente con un administrador. La migración lo necesita para restricciones temporales y falla atómicamente si no está disponible.
- Confirmar PostgreSQL 17, esquema `public`, nombres de objetos libres, disponibilidad de la extensión y ausencia de conflictos con otro sistema.
- Resolver usuarios no propietarios, saneamiento de metadatos y auditoría antes de exponer operaciones de escritura. No habilitar scheduler ni persistencia automática con esta entrega.

El ejecutor usa una conexión dedicada, transacción, bloqueo asesor, timeouts de bloqueo/sentencia y checksum de SQL up/down. Rechaza historial desconocido o alterado. El SQL down elimina las siete tablas **y todos sus datos**, sin CASCADE, en orden inverso. La tabla técnica queda vacía y la extensión se conserva porque es un requisito compartido, no propiedad de la migración. Dependencias externas nuevas hacen que el rollback falle y se revierta en lugar de destruirlas. Reversibilidad de esquema no significa recuperación de datos: el backup sigue siendo necesario.

## Resultado de validación nativa — 2026-10-23

La validación pendiente quedó completada en PostgreSQL **17.11** nativo (`postgres:17-alpine`) con `btree_gist` **1.7**. El runner nativo reportó **18 pruebas aprobadas, cero fallidas y cero omitidas**, salida 0. Los errores intencionales siguientes son resultados esperados comprobados por las pruebas, no fallos de la suite.

### Aislamiento y protección de la aplicación

- Se utilizó exclusivamente `compose.test.yaml` con `-p digifort-monitor-phase3a-validation`; se comprobó antes que ese proyecto no tuviera contenedores preexistentes.
- Base fija `digifort_test_isolated`, inicialmente sin tablas públicas; PostgreSQL en tmpfs, red interna, sin puertos publicados y sin montajes o volúmenes del proyecto principal. Se comprobó tanto la configuración resuelta como los montajes efectivos.
- Se tomaron y compararon sólo metadatos de los tres contenedores principales: ID, imagen, running, hora de inicio, número de reinicios, montajes y redes. Permanecieron iguales. Se comparó también el conjunto de volúmenes existentes, sin eliminarlos.
- Al finalizar se retiraron únicamente los contenedores y la red del proyecto efímero, mediante su archivo y nombre explícitos, sin `-v` ni prune. La comparación final confirmó los mismos metadatos de los principales y el mismo conjunto de volúmenes existentes.
- El proceso inicial conservaba grupos anteriores y Docker rechazaba el socket. Activar el grupo ya asignado con `sg docker` permitió ejecutar Docker sin sudo. No se cambiaron permisos ni servicios para resolverlo.
- No se inspeccionó el esquema ni se ejecutaron consultas o migraciones sobre la base principal. No se consultaron servidores Digifort.

### Resultados comprobados

| Comprobación nativa | Resultado |
| --- | --- |
| PostgreSQL 17 y extensión requerida | Versión mayor comprobada; `btree_gist` 1.7 instalado sólo en la base efímera |
| Migración sin `btree_gist` | Error esperado `42704`; la transacción no deja tablas ni historial de migración |
| Up repetido | Catálogo correcto y una sola entrada de migración |
| Rollback y reaplicación | Eliminación de objetos propios, conservación de extensión compartida y catálogo limpio al reaplicar |
| Rollback con dependencia externa sintética | Rechazo y reversión de los DROP previos; datos/estado anterior conservados |
| DDL fallido después de crear objetos | Error esperado `42P01`; no quedan tablas, funciones ni entrada de migración parciales |
| Checksum alterado | Ejecución rechazada sin modificar el esquema aplicado |
| Código municipal concurrente, primer escritor confirma | Se observa el bloqueo; exactamente una cámara y rechazo del segundo con `23505` |
| Código municipal concurrente, primer escritor revierte | Se observa el bloqueo; el segundo puede insertar, sin duplicados ni estado inicial huérfano |
| Vínculo temporal concurrente | Se observa espera por transacción y rechazo del solapamiento con `23P01` |
| Exclusiones GiST | Se prueban cámara, servidor/Name, servidor/ID externo e inventario; adyacencia válida y solapamientos rechazados |
| Dos ejecutores de migración | Bloqueo asesor observado; ejecutores serializados, una sola migración aplicada |
| Integridad referencial y temporal | Vínculos ajenos, padres inexistentes, versiones fuera de período, cierres indebidos y borrados referenciados rechazados |
| Identidad y campos | Código completo único, número repetible, NULL provisionales, ceros iniciales y catálogo extensible conservados |
| Estado | Nueve combinaciones Active/Working válidas, procedencia y timestamps coherentes; secuencia/época no retroceden |

También se ejecutó la suite completa local (con pruebas embebidas, conector JSON/XML, CLI y salud Fastify) y las compilaciones de backend y frontend: correctas. La prueba nativa se ejecutó de forma separada con opt-in; en la suite local sin opt-in se omite deliberadamente. Se verificaron ambas configuraciones Compose con `--quiet` y `git diff --check` sin errores. El frontend no se modificó.

La ampliación de pruebas está en `apps/api/tests/database-native.test.ts`; no requirió cambiar el SQL de la migración ni su checksum. Los datos de ensayo son sintéticos y los resultados no incorporan credenciales, direcciones internas o inventarios municipales.

### Preparación para aplicación controlada

La Fase 3A supera ahora las validaciones técnicas nativas y de concurrencia previstas. Está lista para **planificar una aplicación controlada del esquema**, sin habilitar ingestión ni scheduler, siempre que se completen los requisitos del destino: revisión autorizada del esquema existente, backup/restauración ensayados, `btree_gist`, rol/permisos y ventana de cambio. Esta validación aislada no autoriza ni ejecuta la aplicación en la base principal.

Siguen pendientes las operaciones auditadas de corrección/reutilización de códigos, réplicas, historia de transiciones y permisos del futuro escritor descritos antes. Los bloqueos conservadores actuales permiten aplicar este esquema inicial sin decidir esas políticas; no permiten sortearlos con actualizaciones directas. Un rollback real sigue siendo destructivo para los datos de estas tablas y requiere un plan de recuperación.

## Informe de preaplicación — 2026-10-23

**Resultado: BLOQUEADO para ejecutar cambios en la base principal.** La compatibilidad técnica es favorable y las 18 pruebas nativas siguen siendo evidencia válida, pero faltan preparación operativa y autorización. Esta sección incorpora la inspección real de catálogos realizada después de la validación aislada; no implica que se haya aplicado ninguna migración.

### Inspección estrictamente no destructiva

Se consultaron catálogos en una transacción `BEGIN READ ONLY`, con `default_transaction_read_only=on`, `statement_timeout=10s` y `lock_timeout=2s`. Se verificó que la base y el rol configurados por la API coinciden con los inspeccionados en el contenedor PostgreSQL. No se seleccionaron filas de negocio, contraseñas, cadenas de conexión, cuerpos de funciones ni valores de configuración privada para el informe.

| Condición observada | Resultado |
| --- | --- |
| PostgreSQL principal | 17.11 |
| Tablas, particiones, vistas, materializadas, extranjeras y secuencias de usuario | Ninguna |
| Índices y restricciones de usuario | Ninguno |
| Funciones propias y tipos compuestos/enum/dominios de usuario | Ninguno |
| Extensiones instaladas | `plpgsql` 1.0 |
| `btree_gist` | Disponible 1.7, **no instalada** |
| Conflictos de las siete tablas y `public.schema_migrations` | Ninguno; no hay objetos de usuario que colisionen |
| Versiones de migración existentes | No existe `schema_migrations`; ninguna versión registrada |
| Permisos del rol inspeccionado | CONNECT/CREATE en base, USAGE/CREATE en public, USAGE de plpgsql; propietario y superusuario |
| Identidad efectiva de migración | No se proporcionó ni verificó un rol explícito para esta intervención; no atribuirle automáticamente los permisos del rol inspeccionado |
| Riesgo de privilegios | La API utiliza también ese rol privilegiado; decidir el rol de mantenimiento y separar el futuro rol de aplicación |
| Artefactos de migración en la API en ejecución | CLI, ejecutor y ambos SQL ausentes; no intentar ejecutarlos en ese contenedor ni recrearlo para incorporarlos |

La ausencia de tabla de versiones no demuestra ausencia de cualquier intervención histórica; significa que el catálogo actual no contiene esas estructuras ni un historial registrado. Repetir la inspección durante la ventana autorizada: el resultado no protege contra cambios posteriores.

El SQL revisado sigue siendo `001_inventory`, con checksum del ejecutor (up + byte NUL + down):

```text
ccc33e8e1c618656a0e1199ccdbc6c4781073638567d2b152e64ddccd1899a8d
```

Cualquier cambio de esos archivos invalida esta aprobación técnica del artefacto y exige recalcular/revisar el checksum y repetir las pruebas afectadas.

### Persistencia y contenedores

El contenedor de base utiliza **`digifort-monitor_postgres_data`**, driver `local`, montado en `/var/lib/postgresql/data`. Las etiquetas lo asocian al proyecto `digifort-monitor` y al volumen lógico `postgres_data` de `compose.yaml`. Es el volumen existente que debe conservarse.

No se cambió Compose, no se ejecutó up/down del proyecto principal y no se reinició, recreó ni eliminó ninguno de sus tres contenedores. Se compararon ID, imagen, inicio, reinicios y montajes antes/después de las consultas sin diferencias. La aplicación propuesta utiliza un ejecutor efímero independiente: no reemplaza la imagen del API ni el volumen de PostgreSQL.

### Condiciones pendientes y puerta de aprobación

| Pendiente | Criterio de cierre |
| --- | --- |
| Backup recuperable | Archivo custom finalizado, checksum válido, archivo restringido fuera del repositorio y retención/custodia aprobadas |
| Restauración real de ese backup | Restaurar en PostgreSQL 17 aislado y comparar estructura/conteos; registrar salida 0 y evidencia privada. Las pruebas sintéticas no sustituyen este ensayo |
| Artefacto desplegable | Construir imagen de migración separada, comprobar checksum y fijar su image ID; no depende de archivos faltantes en el API actual |
| Rol efectivo y permisos | Identificar y aprobar el rol que usará el ejecutor, verificar sus permisos en READ ONLY; decidir mantenimiento privilegiado o rol dedicado sin cambiar roles todavía |
| Extensión | Autorizar y aprovisionar `btree_gist` en public, luego verificar 1.7. La disponibilidad en disco no equivale a instalación |
| Ventana y autorización | Aprobar destino, volumen, checksum, backup, procedimiento y ausencia de otros escritores/DDL. Autorización explícita antes de CREATE EXTENSION o migrate:up |

No se crearon el backup, la imagen de mantenimiento, roles ni la extensión durante esta preparación. No se efectuó ninguna restauración ni migración principal. Los comandos siguientes son un procedimiento futuro **no ejecutado**; no constituyen autorización implícita para hacerlo.

### A. Sesión y artefactos privados

Ejecutar desde la raíz del proyecto, con Bash, Docker operativo sin sudo y sin `set -x`. En una sesión con grupos antiguos, activar el grupo ya asignado antes de ejecutar los comandos. No publicar salida de `docker inspect` completa, `docker compose config` sin `--quiet`, archivos de entorno ni logs de recuperación.

```bash
set -euo pipefail
umask 077
private_parent=/home/miguel/digifort-private
mkdir -p -m 700 "$private_parent"
test -O "$private_parent"
test "$(stat -c '%a' "$private_parent")" = 700
backup_dir=$(mktemp -d "$private_parent/pre-phase3a.XXXXXXXX")
dump_file="$backup_dir/database.custom"
migration_env_file="$private_parent/migration.env"
main_db_container=digifort-monitor-db-1
restore_container="digifort-phase3a-restore-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM"
expected_checksum=ccc33e8e1c618656a0e1199ccdbc6c4781073638567d2b152e64ddccd1899a8d
snapshot_containers() {
  docker inspect --format '{{.Name}}|{{.Id}}|{{.Image}}|{{.State.Running}}|{{.State.StartedAt}}|{{.RestartCount}}|{{json .Mounts}}' \
    digifort-monitor-api-1 digifort-monitor-db-1 digifort-monitor-web-1
}
snapshot_containers > "$backup_dir/containers-before.txt"
docker volume inspect --format '{{.Name}}|{{.Driver}}|{{json .Labels}}' digifort-monitor_postgres_data \
  > "$backup_dir/volume-before.txt"
printf '%s\n' "$expected_checksum" > "$backup_dir/approved-migration.sha256"
docker inspect --format '{{.Image}}' "$main_db_container" > "$backup_dir/postgres-image-id.txt"
postgres_image_id=$(cat "$backup_dir/postgres-image-id.txt")
test "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$main_db_container")" = digifort-monitor_postgres_data
```

El directorio contiene datos operativos restringidos aunque hoy no haya tablas de negocio. El formato custom **no cifra**; definir cifrado, acceso, retención y copia fuera del host con los responsables. `pg_dump` cubre una base, no roles/passwords globales, configuración del clúster ni el volumen físico. La recuperación de roles/ACL se gestiona por separado sin exportar hashes de contraseñas a Git. Referencias: [pg_dump 17](https://www.postgresql.org/docs/17/app-pgdump.html), [pg_restore 17](https://www.postgresql.org/docs/17/app-pgrestore.html).

### B. Backup consistente en formato custom

Reconfirmar que no habrá DDL ni cargas nuevas durante backup, ensayo y aplicación. La API puede seguir en ejecución; no detener ni reiniciar contenedores. El backup usa los binarios del propio PostgreSQL 17 y conexión local, sin password en argumentos ni TTY.

```bash
docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' "$main_db_container" sh -c \
  'exec pg_dump --format=custom --no-password --lock-wait-timeout=5s --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' \
  > "$dump_file.partial" 2> "$backup_dir/pg_dump.stderr"
test -s "$dump_file.partial"
mv "$dump_file.partial" "$dump_file"
chmod 600 "$dump_file"
sha256sum "$dump_file" > "$dump_file.sha256"
sha256sum --check --status "$dump_file.sha256"
docker exec -i "$main_db_container" pg_restore --list < "$dump_file" \
  > "$backup_dir/archive.toc" 2> "$backup_dir/archive-list.stderr"
```

Con `set -e`, un pg_dump fallido no promueve `.partial` a backup aprobado. Revisar stderr en privado incluso si la salida es 0. `--list` sólo confirma lectura del archivo: **no** prueba su restauración. Un backup previo o uno que no se pudo restaurar no habilita cambios.

### C. Evidencia comparable de estructura y conteos

Guardar este SQL en el directorio privado; sus resultados tampoco se publican. La comparación excluye propietarios/ACL porque el ensayo usa `--no-owner --no-acl`; no acredita recuperación de privilegios. La política de roles se comprueba separadamente.

```bash
cat > "$backup_dir/verify.sql" <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
SELECT jsonb_build_object(
 'relations', (SELECT coalesce(jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind) ORDER BY n.nspname,c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')),
 'columns', (SELECT coalesce(jsonb_agg(jsonb_build_array(table_name,column_name,data_type,is_nullable,column_default,is_generated,generation_expression) ORDER BY table_name,ordinal_position),'[]') FROM information_schema.columns WHERE table_schema='public'),
 'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname),'[]') FROM pg_indexes WHERE schemaname='public'),
 'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname),'[]') FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
 'functions', (SELECT coalesce(jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),md5(pg_get_functiondef(p.oid))) ORDER BY p.proname,p.oid::regprocedure::text),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p')),
 'extensions', (SELECT coalesce(jsonb_agg(jsonb_build_array(extname,extversion) ORDER BY extname),'[]') FROM pg_extension)
);
SELECT format('SELECT %L AS relation, count(*) AS rows FROM %I.%I;', n.nspname||'.'||c.relname,n.nspname,c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relispartition
ORDER BY n.nspname,c.relname
\gexec
COMMIT;
SQL
docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on' "$main_db_container" sh -c \
  'exec psql -X -q -At --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < "$backup_dir/verify.sql" > "$backup_dir/main-before.txt" 2> "$backup_dir/main-before.stderr"
```

Esta comparación es suficiente como control de estructura/conteo del catálogo actualmente vacío, no un checksum de todas las filas futuras. Si aparece un esquema nuevo o datos durante la ventana, bloquear y revisar: ampliar verificaciones por entidad y obtener un backup actualizado. El snapshot de pg_dump y esta consulta son transacciones diferentes; los conteos sólo se comparan con la condición de ausencia de escritores/DDL, no como una garantía universal ante carga concurrente.

### D. Restauración en un contenedor nuevo sin red

No utilizar `test-api`: sus pruebas exigen una base vacía y ejecutan down; no se deben ejecutar sobre la copia restaurada. Este contenedor usa exclusivamente tmpfs, sin puertos, bind mounts, red de la aplicación ni volúmenes persistentes. Usa el image ID del PostgreSQL principal para igualar binarios, sin recrear el principal.

```bash
docker run -d --name "$restore_container" --label org.digifort.purpose=restore-validation \
  --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_DB=digifort_restore_validation -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$postgres_image_id" > "$backup_dir/restore-container-id.txt"
ready=no
for attempt in $(seq 1 30); do
  if docker exec "$restore_container" pg_isready -U postgres -d digifort_restore_validation >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 1
done
test "$ready" = yes
sha256sum --check --status "$dump_file.sha256"
docker exec -i "$restore_container" pg_restore --no-password --exit-on-error --single-transaction \
  --no-owner --no-acl --username=postgres --dbname=digifort_restore_validation \
  < "$dump_file" > "$backup_dir/pg_restore.stdout" 2> "$backup_dir/pg_restore.stderr"
docker exec -i "$restore_container" psql -X -q -At --no-password -v ON_ERROR_STOP=1 \
  -U postgres -d digifort_restore_validation < "$backup_dir/verify.sql" \
  > "$backup_dir/restored.txt" 2> "$backup_dir/restored.stderr"
cmp --silent "$backup_dir/main-before.txt" "$backup_dir/restored.txt"
```

Aprobar sólo con restauración/consulta/comparación en salida 0 y revisión privada de errores/advertencias. No usar `--clean` ni `--create`: el destino se nombra explícitamente y no debe recuperar el nombre original del archivo. No montar el volumen principal ni archivos del backup dentro de otro contenedor; el archivo se transmite por stdin.

El ensayo puede cerrarse tras registrar evidencia. Estos comandos sólo eliminan el contenedor creado, sin `-v` ni prune:

```bash
test "$(docker inspect --format '{{index .Config.Labels "org.digifort.purpose"}}' "$restore_container")" = restore-validation
docker stop "$restore_container" >/dev/null
docker rm "$restore_container" >/dev/null
```

### E. Preparar el ejecutor sin alterar la API principal

Construir y congelar un artefacto aparte, desde la revisión ensayada. **No** ejecutar docker compose up/build/restart sobre el proyecto principal ni copiar archivos al API en ejecución.

```bash
docker build -f apps/api/Dockerfile -t digifort-monitor-migrator:phase3a-review apps/api \
  > "$backup_dir/migrator-build.log" 2>&1
migration_image_id=$(docker image inspect --format '{{.Id}}' digifort-monitor-migrator:phase3a-review)
printf '%s\n' "$migration_image_id" > "$backup_dir/migrator-image-id.txt"
actual_checksum=$(docker run --rm --network none --read-only --entrypoint node "$migration_image_id" \
  --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";console.log(createHash("sha256").update(readFileSync("migrations/001_inventory.up.sql")).update("\0").update(readFileSync("migrations/001_inventory.down.sql")).digest("hex"))')
test "$actual_checksum" = "$expected_checksum"
```

Un administrador debe aprovisionar privadamente `$migration_env_file` con `MIGRATION_DATABASE_URL` y `MIGRATION_EXPECTED_DATABASE` para la base y rol expresamente aprobados, usando el alias `db` en la red `digifort-monitor_internal`. No incorporar `MIGRATION_ALLOW_DOWN`, ni reutilizar ciegamente `.env`, ni imprimir esos valores. Verificar otra vez CONNECT/CREATE, USAGE/CREATE en public, USAGE de plpgsql y propiedad/capacidad de mantenimiento para el rollback. No se ha autorizado crear roles ni cambiar permisos en esta entrega.

```bash
test -f "$migration_env_file"
test -O "$migration_env_file"
test "$(stat -c '%a' "$migration_env_file")" = 600
```

El rol inspeccionado puede técnicamente realizar la operación, pero su uso como administrador de mantenimiento debe aprobarse explícitamente o sustituirse por un rol verificado. No confundir la autorización de mantenimiento con permisos apropiados para ingestión permanente.

### F. Sólo después de autorización explícita: extensión y up

**Primeros comandos que modifican la base principal; NO ejecutados.** La aprobación debe identificar destino, rol, image ID, checksum, backup restaurado y ventana. Volver a comprobar estado de contenedores/volumen y catálogo antes de comenzar. Mantener la misma política de no reinicios.

El aprovisionamiento de extensión utiliza al administrador existente dentro del contenedor, una identidad que también debe quedar aprobada:

```bash
docker exec -i "$main_db_container" sh -c \
  'exec psql -X --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$backup_dir/extension.stdout" 2> "$backup_dir/extension.stderr" <<'SQL'
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE EXTENSION btree_gist WITH SCHEMA public;
COMMIT;
SQL
docker run --rm --network digifort-monitor_internal --read-only --cap-drop ALL \
  --security-opt no-new-privileges --env-file "$migration_env_file" \
  --entrypoint node "$migration_image_id" dist/database/migrate-cli.js up \
  > "$backup_dir/migration-up.log" 2>&1
```

Si al reinspeccionar ya existe la extensión, verificar versión/esquema y detenerse ante cualquier discrepancia; no intentar reemplazarla. La extensión se aprovisiona en una transacción separada: si up falla, puede quedar instalada legítimamente sin tablas nuevas.

Validación posterior, también sin leer datos de negocio:

```bash
docker exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on' "$main_db_container" sh -c \
  'exec psql -X -q -At --no-password -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$backup_dir/post-apply.txt" 2> "$backup_dir/post-apply.stderr" <<'SQL'
BEGIN READ ONLY;
SELECT current_setting('server_version');
SELECT extname,extversion FROM pg_extension ORDER BY extname;
SELECT id,checksum FROM public.schema_migrations ORDER BY id;
SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN
 ('nodes','camera_types','digifort_servers','cameras','camera_bindings','camera_inventory_versions','camera_current_state');
SELECT code,name,enabled FROM public.camera_types ORDER BY code;
SELECT conname,contype FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname;
COMMIT;
SQL
snapshot_containers > "$backup_dir/containers-after.txt"
cmp --silent "$backup_dir/containers-before.txt" "$backup_dir/containers-after.txt"
docker volume inspect --format '{{.Name}}|{{.Driver}}|{{json .Labels}}' digifort-monitor_postgres_data \
  > "$backup_dir/volume-after.txt"
cmp --silent "$backup_dir/volume-before.txt" "$backup_dir/volume-after.txt"
```

Criterio: una versión `001_inventory` con checksum aprobado, siete tablas, tipos D/Domo, F/Fija y P/Punto Seguro, restricciones/índices del artefacto y ninguna carga municipal automática. Contrastar además inventario de columnas, funciones e índices contra la migración ensayada, y volver a verificar IDs/inicios/reinicios/montajes de los tres contenedores. No habilitar scheduler, ingestión o nuevas rutas con esta operación.

### G. Recuperación y condiciones de parada

- **Backup o ensayo fallido:** bloquear; conservar `.partial`/logs en privado para diagnóstico, no aprobar archivo incompleto ni ejecutar DDL.
- **Falla de instalación de extensión:** su transacción se revierte; inspeccionar en READ ONLY y detenerse. No cambiar permisos ni reintentar como otro usuario sin aprobación.
- **Falla de up:** el ejecutor revierte la transacción completa; comprobar catálogo/ledger antes de decidir. No editar checksum ni eliminar `schema_migrations` para sortear errores. La extensión preinstalada puede permanecer.
- **Desconexión con resultado incierto:** no inferir fallo a partir de una salida perdida. Consultar ledger/checksum y objetos; un up ya confirmado es idempotente con el mismo artefacto, pero el reintento requiere verificar destino y condiciones de la autorización.
- **Up confirmado pero validación no conforme:** detener nuevas escrituras y decidir recuperación; no ejecutar down automáticamente. El down elimina tablas/datos y puede fallar si aparecieron dependencias externas.
- **Recuperación de datos:** nunca restaurar encima de la base principal ni sobre su volumen como respuesta automática. Volver a ensayar el archivo en un contenedor aislado y preparar un plan específico de recuperación/reemplazo de destino con nueva autorización; este procedimiento no incluye un comando destructivo sobre producción.

Un down futuro sólo puede considerarse con autorización adicional explícita y evidencia de que se preservaron todas las escrituras posteriores. Para evitar un rollback accidental, `MIGRATION_ALLOW_DOWN` no está en el archivo de up. No queda autorizado por aprobar up ni por preparar este informe. La tabla técnica y la extensión compartida se conservan tras down según el diseño; un rollback de esquema no equivale a restaurar el backup.

**Salida de esta preparación:** BLOQUEADO hasta cerrar la lista de pendientes y recibir autorización. Inspección técnica favorable; ninguna modificación de base, contenedor, volumen, rol o extensión realizada. Ningún backup de producción ni secreto se agregó al repositorio. No se hicieron commits ni pushes.

## 004_description_identity

Nueva fuente Description: funciones de extracción/validación SQL, trigger de candidatos,
índice y procedencia code_source de propuestas. El migrador aplica 001/002/003/004 en
orden; ninguna se ejecuta al arrancar. 001/002/003 conservan sus checksums.
El down directo de 004 rechaza observaciones nuevas que perderían procedencia. El
rollback completo del migrador retira todo el esquema en una transacción: sólo entonces
fija digifort.full_schema_rollback, ya que no conserva tablas parciales mal etiquetadas.
La operación sigue requiriendo autorización explícita del CLI. No se ejecutó en bases
persistentes. Ver [description-identity.md](description-identity.md).
