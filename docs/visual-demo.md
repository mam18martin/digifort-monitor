# Primera versión visual — demostración local

> Documento histórico: la demo fue retirada del flujo operativo. No ejecutar start/reset.
> Los fixtures sólo se usan en pruebas y no se borraron recursos existentes.
> Entrada vigente: [monitoreo real en memoria](live-monitoring.md).

La aplicación incorpora la consulta de identidades 3B.5 en modo solo lectura. Las
correcciones de identidad permanecen bloqueadas. Esta versión prioriza probar el sistema
en el navegador. React/Vite consulta Fastify y éste lee PostgreSQL 17 real. No hay datos
hardcodeados en las pantallas ni sustitución por mocks cuando falla la API.

## Iniciar en macOS Apple Silicon

Requisitos: Docker Desktop abierto y funcionando, Docker Compose y este repositorio.
No hace falta instalar Node, PostgreSQL ni configurar credenciales de la oficina.
Desde Terminal:

```bash
cd /Users/miguelmartin/digifort-monitor
bash ops/demo.sh start
```

Cuando aparezca «Demostración lista», abrir:

**http://127.0.0.1:8081**

No usar `docker compose up` sin el archivo de demostración: es la infraestructura
principal. El helper usa exclusivamente compose.demo.yaml, proyecto explícito
`digifort-monitor-demo`, contexto local desktop-linux y `--env-file /dev/null`.
No carga el .env principal ni se conecta por SSH/VPN. La primera construcción requiere
internet para descargar imágenes/dependencias públicas; la demo no consulta Digifort.

Si 8081 ya está ocupado por otra aplicación, elegir otro puerto:

```bash
DEMO_PORT=8082 bash ops/demo.sh start
```

Abrir entonces http://127.0.0.1:8082. El servicio web siempre publica en 127.0.0.1,
nunca en todas las interfaces. No modificar redes, daemon, rutas ni puertos de otros
proyectos para iniciar esta demo.

## Recorrido sugerido

1. **Dashboard:** 48 cámaras. Al crear la muestra hay 24 operativas, 3 caídas, 3
   inactivas, 18 desconocidas y 2 servidores con problemas. Las métricas enlazan a
   los filtros. Las 3 inactivas se contabilizan aparte para no mezclarlas con caídas.
2. **Cámaras:** buscar `1390D`, filtrar por servidor o estado, cambiar de página y abrir
   el detalle desde el código o la flecha. Buscar `DEMO-PROVISIONAL`: hay tres cámaras
   con código confirmado NULL; no se inventa uno para mostrarlas.
3. **Detalle:** identidad, Name original (con delimitador cuando corresponde),
   Description independiente, flags nullable, origen, última observación e historial
   de transiciones. El historial muestra valores observados, no pretende funcionamiento
   continuo ni recalifica datos históricos como si fueran actuales.
4. **Servidores:** Nodo Este tiene error de autenticación y sí respondió; Nodo Sur está
   sin respuesta. Sus cámaras conservan los valores anteriores, pero su condición
   actual es desconocida, no caída.
5. Reducir el navegador al ancho de un teléfono: la navegación pasa a la parte inferior,
   tarjetas y detalle se apilan y la tabla conserva desplazamiento horizontal propio.

Nombres de nodos, lugares y cámaras son ficticios. Los códigos confirmados son
asignaciones iniciales de fixtures sintéticas; no provienen de una observación remota
ni modifican cámaras reales. No hay video en vivo ni credenciales de producción.

## Vigencia y renovación de la muestra

La vigencia del MVP es **180 segundos**. Una cámara sólo se presenta como caída si:

- Active es verdadero y Working falso, ambos con timestamps recientes y no futuros;
- hay inventario presente y cobertura de estado coincidente;
- la última consulta del servidor es válida, reciente y sin fallos pendientes.

Una observación vencida o un servidor con problemas produce estado desconocido.
Active/Working muestran el último valor registrado por separado, sin convertirlo
en una observación nueva. Los timestamps de intento no renuevan los de observación.
Las cámaras inactivas requieren Active falso observado válidamente.

La interfaz relee la API cada 30 segundos y tiene «Actualizar vista». Son sólo lecturas;
no hay scheduler de sincronización ni nuevas observaciones generadas automáticamente.
Por eso, unos minutos después de iniciar, los datos sintéticos pasan a desconocidos.
No es una caída masiva ni un error de la demo. Para volver al escenario inicial:

```bash
bash ops/demo.sh reset
```

Este comando recrea **sólo** el proyecto de demostración y genera la misma muestra con
nuevas fechas relativas. Pierde únicamente sus datos sintéticos temporales, sin tocar
bases ni volúmenes existentes. No ejecuta down -v ni prune. Si se eligió otro puerto,
conservar DEMO_PORT en esos comandos.

Estado y cierre:

```bash
bash ops/demo.sh status
bash ops/demo.sh stop
```

Stop retira sólo contenedores y redes de esta demo. PostgreSQL usa tmpfs, por lo que
los datos no se conservan al retirar o detener la base. Start después de stop vuelve
a generar el escenario; no es un mecanismo de backup.

## Aislamiento y permisos

- compose.yaml permanece intacto. No se combina con compose.demo.yaml.
- PostgreSQL: base fija digifort_demo_isolated, tmpfs, sin volumen ni puerto publicado.
- demo-seed: entrada explícita que exige nombre de base, PGHOST demo-db, rol demo_owner
  y MONITOR_DEMO=yes. Rechaza catálogos/datos existentes sin el marcador y conteos de
  esta muestra. Las migraciones se aplican sólo a esa base desechable.
- api: rol demo_reader sin DML/DDL sobre el inventario, más transacciones read-only.
- Base, semilla y API sólo están en la red interna exclusiva de demostración.
- web tiene además su red frontal exclusiva para publicar el puerto en loopback.
  Docker Desktop no publicó el puerto cuando web sólo tenía la red interna.
- La API de lectura no se habilita en el servidor normal: exige banderas explícitas
  de demo y PGHOST/base/usuario de este entorno. No se aprovisiona el rol de aplicación
  de Ubuntu ni se cambian credenciales, permisos o redes existentes.

PostgreSQL usa trust exclusivamente dentro de la red interna temporal, sin contraseñas
por defecto reutilizables. Los roles demo_owner/demo_reader sólo existen en ese clúster
sintético. No trasladar esta configuración a una base municipal ni publicar la app:
faltan autenticación, autorización, HTTPS y revisión de seguridad.

El catálogo carga las migraciones existentes, incluida 003 por dependencia de la versión
actual del migrador, pero no crea revisiones ni continúa su implementación. 001/002 no
se modifican. La semilla escribe fixtures explícitas; no activa el conector ni el
coordinador. Todas las lecturas visuales provienen de las tablas existentes.

## API de lectura

| Ruta GET | Resultado |
| --- | --- |
| /api/v1/monitor/overview | Conteos consistentes de clasificación, servidores y hora de evaluación |
| /api/v1/monitor/cameras | Listado paginado; q, server, status, page, pageSize |
| /api/v1/monitor/cameras/:id | Detalle y hasta 100 transiciones históricas |
| /api/v1/monitor/servers | Transporte, consulta, antigüedad y últimos intentos/éxitos |

Los filtros usan parámetros SQL, con búsqueda literal (no comodines introducidos por
el usuario), límites y validación. Las respuestas llevan no-store. No se devuelven
orígenes de servidores, referencias de credenciales ni errores internos de PostgreSQL.
Un fallo de base produce 503 saneado; la interfaz informa el error sin datos inventados.
La API sigue conservando /health y /ready. El rol lector permite SELECT sólo sobre
las tablas necesarias y no tiene permisos de escritura al inventario.

## Verificación realizada

- 178 pruebas de API, migraciones y módulos existentes aprobadas con Node 22.23.4 y
  PostgreSQL 17 embebido, incluidas siete pruebas nuevas del MVP.
- Backend y frontend compilados; bash -n y git diff --check satisfactorios.
- Demo levantada con PostgreSQL **17.11 nativo** y rol demo_reader. Se comprobó
  transaction_read_only=on y ausencia de INSERT/UPDATE/DELETE/CREATE.
- Recorrido automatizado de Chrome: dashboard y cinco KPI, búsqueda 1390D, detalle
  con historial, cuatro servidores, distinción de autenticación/transporte, cámaras
  provisionales y viewport móvil de 390 px sin desbordamiento horizontal de página.
  Sin excepciones JavaScript en ese recorrido.
- Puertos efectivos: sólo 127.0.0.1:8081 para web. Base/API no publicadas; PostgreSQL
  montado en tmpfs. No se crearon volúmenes persistentes.
- Comparación de metadatos antes/después: seis contenedores, cuatro redes y un volumen
  preexistentes sin diferencias. Sólo se crearon los recursos del proyecto demo.
- 001/002 y compose.yaml permanecen intactos; no hubo commits ni pushes.

La demo quedó iniciada para recorrerla. Los datos envejecen normalmente: para renovar
la muestra usar reset, sin modificar la política de frescura ni inventar observaciones.

## Revisión de identidades

La navegación incluye **Identidades**, filtros por tipo/servidor/estado y evidencia con
enlaces al detalle de cámara. Consultar [identity-web-review.md](identity-web-review.md)
para los nueve casos sintéticos, contratos GET, pruebas y limitaciones. No modifica
identidades ni ofrece acciones de revisión. Los fixtures nuevos requieren una demo
vacía; no se actualizan datos de una demo anterior al consultar la pantalla.

## Inspección real independiente

La navegación incorpora **Inspección Digifort**, sin mezclar la lectura con las
48 cámaras de esta demo. Se sirve desde un proceso local separado y sin PostgreSQL:
**http://127.0.0.1:8083/#/inspection** en la validación actual. Consultar
[digifort-inspection.md](digifort-inspection.md) para arranque, memoria temporal,
credenciales privadas y la acción manual que consulta sólo GetCameras. El proceso
Compose de demostración no recibe credenciales ni datos reales.
