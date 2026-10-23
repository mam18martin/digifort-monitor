# Plan de desbloqueo de Fase 3A

## Estado y límites

**BLOQUEADO para aplicación principal.** Se prepararon scripts, overlays y un servicio de mantenimiento. No se ejecutaron roles, extensiones, migraciones ni cambios de red sobre el sistema real. No se reiniciaron ni recrearon contenedores, no se cambiaron rutas Ubuntu y no se borraron volúmenes.

Este plan sustituye las propuestas de usar el rol privilegiado del API para migrar y de ejecutar el artefacto con un `docker run` genérico en las secciones E/F de [database-migrations.md](database-migrations.md). Sus controles de backup/recuperación siguen vigentes. La autorización previa de pruebas nativas no autoriza ninguna fase modificadora de este plan.

## 1. Separación de roles preparada

| Identidad propuesta | Facultades | Prohibiciones y activación |
| --- | --- | --- |
| `monitor_owner` | USAGE/CREATE en public; propietario de tablas, funciones y ledger creados por migraciones | NOLOGIN, sin atributos elevados de clúster; no se usa en la API |
| `monitor_migrator` | CONNECT; puede asumir `monitor_owner` mediante SET ROLE; no hereda DDL automáticamente | Sin superusuario, CREATEDB, CREATEROLE, REPLICATION ni BYPASSRLS; inicialmente NOLOGIN |
| `monitor_app` | CONNECT y la consulta actual `SELECT 1` | Ningún privilegio sobre las siete tablas, ledger, secuencias o funciones públicas; no tiene membresía del owner; inicialmente NOLOGIN |
| `monitor_admin` | Identidad NOLOGIN separada para instalar la extensión trusted; permisos CREATE temporales dentro de una transacción | No superusuario; permisos temporales se retiran tras instalar; no es identidad del API ni del migrador |
| Administrador de bootstrap existente | Crea roles, otorga/revoca permisos y asume la identidad administrativa para la preparación | Excepción acotada y autorizada por separado; no se convierte en credencial de mantenimiento normal |

La API sólo ejecuta `SELECT 1`: otorgarle SELECT a tablas de negocio hoy sería innecesario. Cuando existan endpoints/ingestión, otra revisión otorgará acceso por tabla/columna o vistas, con pruebas negativas; no usar `GRANT ALL ON ALL TABLES` ni privilegios futuros generales para la API.

Preparados:

- `ops/sql/roles-bootstrap.sql`: exige confirmación de base por GUC, nombres de roles libres y public sin tablas; crea identidades sin passwords ni login, restringe PUBLIC, configura membresía con INHERIT FALSE/SET TRUE/ADMIN FALSE y default privileges seguros para objetos del owner.
- `ops/sql/install-extension.sql`: exige confirmación de base, extensión todavía ausente y versión trusted 1.7 disponible. El administrador autorizado concede permisos temporales, usa SET ROLE monitor_admin para instalar y retira los permisos antes de COMMIT. No usar superusuario como identidad efectiva de instalación ordinaria.
- El CLI exige `MIGRATION_OWNER_ROLE`, rechaza un session_user con atributos elevados y un owner con login/atributos elevados, y ejecuta SET ROLE con identificador escapado. No modifica membresías ni roles. El helper de migraciones y el SQL de inventario conservan su checksum; el artefacto CLI sí debe reconstruirse y revisarse.

El bootstrap revoca permisos de PUBLIC **en la base dedicada**: requiere confirmar que no afectará aplicaciones/roles ajenos. Si existen los nombres propuestos o aparece un esquema diferente del revisado, abortar; no convertir el script en ALTER ROLE masivo ni ejecutarlo con IF NOT EXISTS para ocultar discrepancias. PostgreSQL 17 soporta [opciones de membresía separadas](https://www.postgresql.org/docs/17/role-membership.html).

Todas las identidades quedan NOLOGIN al crearse. Tras autorización, un administrador debe aprovisionar nuevas credenciales privadamente, por ejemplo con `\password monitor_migrator` y `\password monitor_app` dentro de psql interactivo sin grabación de terminal, y sólo después habilitar LOGIN. No hay credenciales por defecto ni se modifica la contraseña del rol real existente. El owner permanece NOLOGIN y la identidad administrativa puede mantenerse NOLOGIN para operaciones mediante SET ROLE autorizado.

## 2. Configuración inactiva y mantenimiento

`compose.maintenance.yaml` define un proyecto propio y un servicio con perfil `manual`, sin puertos ni montajes de datos, filesystem de sólo lectura y capacidades retiradas. Reutiliza el Dockerfile compilado del backend con `pg`, CLI y SQL incluidos. No ejecuta Fastify ni contiene configuración Digifort. Requiere red externa existente y archivo privado; nunca levanta `db`, `api` o `web` del proyecto principal.

Para construir/validar sin ejecutar el migrador:

```bash
export MIGRATION_ENV_FILE=/home/miguel/digifort-private/migration.env
export MAINTENANCE_NETWORK=digifort-monitor_internal
test -O "$MIGRATION_ENV_FILE"
test "$(stat -c '%a' "$MIGRATION_ENV_FILE")" = 600
docker compose -f compose.maintenance.yaml --profile manual config --quiet
docker compose -f compose.maintenance.yaml --profile manual build migrate
```

El archivo privado contendrá la conexión del **login de migración no privilegiado** y el nombre esperado de la base. El servicio fija `MIGRATION_OWNER_ROLE=monitor_owner` y `MIGRATION_ALLOW_DOWN=no`; no se habilita down por el archivo de up. Congelar el image ID y el checksum según el procedimiento anterior, sin registrar DSN ni variables privadas.

`compose.roles.yaml` es un overlay futuro: sólo cambia PGUSER a la nueva identidad, elimina explícitamente PGPASSWORD con `!reset` y usa PGPASSFILE mediante secret de archivo. No se aplica al Compose actual en esta entrega. Requiere Compose con soporte de reset; la configuración combinada se verificó con la versión local, comprobando en memoria que ya no contiene PGPASSWORD.

Compose local no garantiza uid/gid/mode de secrets de archivo: no se promete que `mode: 0600` arregle los permisos. El operador debe crear fuera de Git el pgpass correcto, con permisos 0600 y propietario legible por UID 1000 del usuario node de la imagen. Escapar `:` y `\` conforme al formato pgpass. No imprimirlo. Si se usa otro UID/user namespace, revisar el mapeo antes del cambio; un archivo ilegible debe bloquear la fase, no justificar permisos 0644.

```bash
export PG_APP_PASSFILE=/home/miguel/digifort-private/app.pgpass
test -O "$PG_APP_PASSFILE"
test "$(stat -c '%a' "$PG_APP_PASSFILE")" = 600
test "$(stat -c '%u' "$PG_APP_PASSFILE")" = 1000
docker compose -f compose.yaml -f compose.roles.yaml config --quiet
```

Cambiar env/secrets de la API exige **recrear la API** en una ventana autorizada futura; un restart no actualiza la configuración. PostgreSQL no necesita reinicio por GRANT/roles. Tras cambiar IP del API, Nginx puede necesitar recarga para resolver otra vez su upstream: no asumir que una IP previa será reutilizada. Nada de esto se ejecutó ahora.

## 3. Redes: observación y propuesta condicional

La lectura de rutas de todas las tablas, interfaces e IPAM Docker confirmó:

- `bridge`/docker0 se solapa con el rango corporativo comunicado por el usuario.
- `digifort-monitor_internal` no se solapa con ese rango concreto. Su nombre no implica aislamiento: actualmente `Internal=false`.
- No había `/etc/docker/daemon.json`. Live restore está deshabilitado; reiniciar Docker puede interrumpir todos los workloads del host, no sólo este proyecto.
- No se publican aquí otras rutas/direcciones descubiertas. La ausencia de una ruta local no demuestra que una subred esté libre en sedes, VPN, nube o redes desconectadas.

Propuesta de **reserva para consultar a IPAM**, no direccionamiento aprobado:

| Uso | Candidato no aplicado | Capacidad |
| --- | --- | --- |
| docker0 | Subred 192.168.240.0/24, bip 192.168.240.1/24 | Bridge predeterminado separado |
| Proyecto | 192.168.241.0/27 | 30 direcciones de host; validar capacidad y gateway |
| Redes nuevas de Docker | Pool 192.168.242.0/23, subdivisiones /27 | 16 subredes; revisar crecimiento de todos los proyectos |

No chocaron con rutas/interfaces/IPAM observados al preparar este plan. **No están certificados libres.** No se asume disponibilidad de 10/8 ni de ningún otro RFC1918. IPAM debe aprobar tres bloques disjuntos considerando inventario corporativo completo, VPN, redes de contenedores de otros hosts, retorno y capacidad; si rechaza estos candidatos, se reemplazan todos los valores de la propuesta.

`ops/network-plan.example.json` contiene estos candidatos con `ipam_approval: null` y el generador lo rechaza sin referencia de aprobación. `ops/prepare_network.py` sólo lee rutas/interfaces/redes y genera archivos privados: valida RFC1918, gateway útil, tamaños, disjunción y superposiciones locales. No escribe en /etc, no llama systemctl ni cambia rutas. Conserva otras claves existentes de daemon.json, que podrían ser privadas, y exige staging fuera del repositorio, propietario del operador y modo 0700; no sobrescribe salidas existentes.

```bash
umask 077
network_stage=$(mktemp -d /home/miguel/digifort-private/network-stage.XXXXXXXX)
# Populate this private file with the ranges and approval supplied by IPAM.
network_plan=/home/miguel/digifort-private/network-approved.json
python3 ops/prepare_network.py --plan "$network_plan" --output-dir "$network_stage"
dockerd --validate --config-file "$network_stage/daemon.json" > "$network_stage/validate.log" 2>&1
systemctl show docker --property=ExecStart > "$network_stage/daemon-command.txt"
```

Validar manualmente flags de systemd frente al JSON: una misma opción en flags y fichero puede impedir el arranque. El generador no certifica esa combinación ni permisos de firewall/retorno. La referencia escrita en JSON es una barrera operativa, no sustituye autorización real. Repetir el análisis local con VPN relevantes conectadas y con datos IPAM; no descartar rutas porque provengan de Docker sin revisar su uso.

Docker distingue `bip` para docker0 y `default-address-pools` para redes **nuevas**. Ninguno cambia automáticamente una bridge de usuario existente. `compose.network-plan.yaml` fija IPAM de la red del proyecto a `MONITOR_SUBNET` aprobado y marca el volumen existente como external por nombre; si falta, Compose debe fallar en vez de crear uno vacío. Referencias: [bridge](https://docs.docker.com/engine/network/drivers/bridge/) y [merge/reset de Compose](https://docs.docker.com/reference/compose-file/merge/).

## 4. Backup y ensayo antes de cambios

Usar A–D de [database-migrations.md](database-migrations.md): custom completo, `.partial` hasta éxito, checksum, lectura del TOC, restauración en contenedor nuevo sin red y comparación privada de estructura/conteos. No se realizó un backup de producción en esta entrega.

Condiciones adicionales:

1. Mantener los binarios PostgreSQL 17 compatibles y fijar el image ID del contenedor de origen. El custom no cifra ni incluye roles/passwords globales; definir custodia/cifrado y recuperación de roles por separado, sin exportar hashes al repositorio.
2. Congelar DDL/escritores para comparar snapshot y conteos entre transacciones. Con datos futuros, conteos iguales no bastan: agregar comprobaciones de claves, muestras deterministas, blobs/secuencias y agregados relevantes. Hoy el catálogo inspeccionado no contiene tablas de negocio; reinspeccionar antes de confiar en ese resultado.
3. El ensayo con `--no-owner --no-acl` acredita recuperación de estructura/datos, no propietarios o ACL. En una segunda fase del ensayo provisionar los roles propuestos, probar owner efectivo y privilegios negativos, y aplicar/retirar el esquema sólo en esa copia. No ejecutar el runner de pruebas que presupone base vacía sobre una copia con datos.
4. Verificar salida 0 y revisar stderr privadamente; ni checksum ni `pg_restore --list` sustituyen restauración. El volumen no se copia como carpeta con PostgreSQL en marcha. No usar `--clean`/`--create` contra producción.
5. Conservar manifiesto privado de contenedores, volúmenes, red, artefactos, backups y configuración original/ausencia de daemon.json. Es la referencia de recuperación, no una lista para publicar en Git.

## 5. Orden de ejecución y autorizaciones

| Etapa | Acciones | Interrupción prevista | Autorización necesaria |
| --- | --- | --- | --- |
| 0 | Revisiones, scripts, sintéticos, construir imagen sin iniciar servicios | Ninguna | Preparación ya solicitada |
| 1 | IPAM, capacidad y OOB, selección de roles/secretos y ventana | Ninguna | Aprobación organizativa; aún sin aplicar |
| 2 | Backup custom y restauración aislada; ensayo del flujo de roles/imagen | Sin parada de la aplicación si no hay escritores/DDL; consumo controlado de recursos | Autorizar generación/custodia de copia real y creación del entorno de ensayo |
| 3 | Bootstrap de roles, credenciales nuevas y extensión | Sin reiniciar contenedores; revisar otros consumidores de PUBLIC | **Autorización explícita de cambios PostgreSQL/roles/secretos**, con scripts y destino |
| 4 | Up mediante mantenimiento no superusuario y verificaciones | Bloqueos DDL acotados; sin recrear servicios | **Autorización explícita de migración** con checksum, image ID y backup restaurado |
| 5 | Cambio de rol de API | Breve indisponibilidad API; posible recarga Nginx | **Autorización explícita de recreación API/recarga web** y reversión de configuración |
| 6 | Cambio de daemon y red de proyecto | Interrupción host-wide potencial; parada/recreación de los tres servicios para cambiar red | **Autorización separada de infraestructura**, IPAM y consola fuera de banda |

El orden recomendado es completar evidencia y roles antes de programar el cambio de red, pero las etapas 5 y 6 pueden combinarse en **una única ventana expresamente aprobada** para evitar dos recreaciones del API. El direccionamiento nuevo no es prerrequisito técnico del DDL, pero su conflicto es un riesgo operativo que debe aceptarse o resolverse antes de uso municipal. No mezclar autorizaciones ni asumir que autorizar DDL permite reiniciar Docker.

### Comandos preparados para etapas 3–4 — NO ejecutados

Sesión Bash sin set -x, logs fuera del repositorio. Ambos scripts exigen que la base confirmada coincida con la actual. Se presupone backup/ensayo aprobados y administrador autenticado ya autorizado:

```bash
{
  printf "SELECT set_config('digifort.expected_database', :'expected_database', false);\n"
  cat ops/sql/roles-bootstrap.sql
} | docker exec -i digifort-monitor-db-1 sh -c \
  'exec psql -X -v ON_ERROR_STOP=1 -v expected_database="$POSTGRES_DB" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$backup_dir/roles-bootstrap.log" 2>&1
{
  printf "SELECT set_config('digifort.expected_database', :'expected_database', false);\n"
  cat ops/sql/install-extension.sql
} | docker exec -i digifort-monitor-db-1 sh -c \
  'exec psql -X -v ON_ERROR_STOP=1 -v expected_database="$POSTGRES_DB" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > "$backup_dir/extension-role.log" 2>&1
```

Ambos archivos requieren inspección y aprobación porque modifican roles/ACL/extensión. No habilitar LOGIN antes de aprovisionar credenciales seguras; mantener al owner y monitor_admin sin login. Confirmar identidad efectiva del migrador después, y preparar el archivo privado del servicio. No registrar variables ni usar el administrador de bootstrap como DSN del migrador.

```bash
docker compose -f compose.maintenance.yaml --profile manual run --rm --no-deps migrate up \
  > "$backup_dir/controlled-up.log" 2>&1
```

Revalidar que los objetos son de monitor_owner, que app sólo hace readiness y que `monitor_app` no posee tablas, funciones ni membresías privilegiadas. No llamar migrate down automáticamente. El servicio bloquea down por defecto; cualquier recuperación destructiva exige otra autorización, backup actualizado y revisión de escrituras posteriores.

### Ventana de red y rol de API — comandos propuestos, NO ejecutados

Estos pasos incumplirían las restricciones de esta entrega si se ejecutaran ahora. Se documentan únicamente para una autorización futura. Requieren IPAM, manifiesto, backups, OOB, archivos privados correctos y ningún contenedor ajeno conectado a la red del proyecto. Hacer inventario de los demás workloads antes de reiniciar el daemon.

```bash
set -euo pipefail
# Approved staging files only; never source arbitrary shell from a plan.
export MONITOR_SUBNET=$(sed -n 's/^MONITOR_SUBNET=//p' "$network_stage/network.env")
test -n "$MONITOR_SUBNET"
docker volume inspect digifort-monitor_postgres_data > "$backup_dir/volume-before-network.json"
docker compose -f compose.yaml -f compose.roles.yaml -f compose.network-plan.yaml config --quiet
# Authorized outage starts here. Do not use -v, down, prune or anonymous volumes.
docker compose -f compose.yaml stop web api db
docker compose -f compose.yaml rm -f web api db
# Abort if other containers are attached; never detach unrelated workloads.
test "$(docker network inspect --format '{{len .Containers}}' digifort-monitor_internal)" = 0
docker network rm digifort-monitor_internal
sudo install -o root -g root -m 600 "$network_stage/daemon.json" /etc/docker/daemon.json
sudo systemctl restart docker
docker compose -f compose.yaml -f compose.roles.yaml -f compose.network-plan.yaml up -d db api web
```

Los comandos no editan rutas con `ip route`, pero Docker crea/retira rutas al modificar bridges: eso también exige aprobación de infraestructura. El daemon y la red pueden afectar el acceso remoto; no ejecutar por una única sesión SSH sin OOB. No escribir una nueva configuración del daemon sin conservar el fichero anterior o constancia de que no existía.

Verificaciones posteriores: running/healthy, volumen con **mismo nombre y contenido**, base/ledger/checksum intactos, readiness por localhost, autenticación como monitor_app, permisos 0600/UID efectivo de pgpass, origen del API sin PGPASSWORD, subred y gateway aprobados, pool correcto y ausencia del solapamiento de docker0. IDs e inicios cambiarán sólo en esta ventana autorizada; comparar con el nuevo manifiesto, no confundirlo con la regla de contenedores intactos de esta entrega. Verificar reachability corporativa hacia un destino de prueba proporcionado por redes, nunca un servidor Digifort, y conservar resultados privados.

Si falla la red: detener el procedimiento, restaurar el daemon original (o retirar únicamente la configuración recién instalada según el manifiesto), y reiniciar Docker sólo dentro de la autorización de recuperación. Reconstituir la red anterior y servicios con el volumen external conservado. No mezclar ranges nuevos/viejos ni improvisar rutas Ubuntu. Si falla el cambio de rol, revertir sólo el overlay/imagen de API según el manifiesto y autorización, sin restaurar datos ni revertir migraciones por ese motivo. Si falla el DDL, aplicar los criterios transaccionales/ledger de la documentación previa antes de cualquier reintento.

## 6. Evidencia de preparación y pendientes

Se construyó la imagen independiente `digifort-monitor-maintenance:phase3a` sin iniciar el servicio ni modificar la imagen de los contenedores en ejecución. Se verificó sintaxis/configuración de overlays con archivos sintéticos, eliminación efectiva de PGPASSWORD y fijación del volumen external. La separación de roles se probó únicamente en PostgreSQL 17 embebido desechable, sin passwords: migración como owner no superusuario, permisos negativos de aplicación y retirada de privilegios temporales de extensión. El plan de red tiene pruebas sintéticas de falta de aprobación, superposiciones, rangos públicos, gateway y rutas amplias 10/8. La versión nativa 18/18 anterior sigue validando el SQL de inventario, no sustituye un ensayo nativo del nuevo flujo completo de roles, secretos y restauración.

Antes de desbloquear: aprobación IPAM, backup restaurado y controles de ACL, ensayo nativo del nuevo rol/imagen, autorización del administrador y del DDL, credenciales nuevas privadas, validación de pgpass/UID, y ventana de red con OOB y plan probado de recuperación. No se certifica ningún CIDR como libre ni se cambia el estado BLOQUEADO por haber preparado scripts.
