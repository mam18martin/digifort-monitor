# Inspección visual de GetCameras

> Regla vigente: [Description como fuente oficial](description-identity.md). Desde esta corrección, Name es sólo la clave técnica exacta; no hay fallback automático. Las referencias anteriores a Name como fuente son históricas.

Vista `#/inspection`, independiente del inventario sintético y sin PostgreSQL.
Los candidatos del parser nunca asignan códigos ni modifican identidades confirmadas.
No cambia el parser municipal ni las migraciones.

## Abrir la instancia local actual

**http://127.0.0.1:8083/#/inspection**

La lectura autorizada quedó cargada únicamente en RAM: 118 cámaras, 22 códigos
válidos, 96 inválidos, 0 ausentes y 0 de tipo desconocido. Una sola consulta GET
remota durante la validación. No se consultó GetStatus.

- La tabla conserva Name y Description originales completos, incluidos espacios,
  saltos y ceros iniciales; React los muestra como texto, nunca como HTML.
- Muestra código candidato, número, letra/tipo, resultado y motivo de no reconocimiento.
- Buscar por Name, filtrar resultado y ordenar Name/código/número/tipo/resultado son
  operaciones sobre la lectura en memoria del navegador: no consultan Digifort.
- Elegir **Todas** para ver las 118 filas. En móvil la tabla se desplaza horizontalmente
  dentro de su contenedor; no se recortan Name ni Description.
- **Consultar GetCameras** hace una nueva lectura manual, exactamente una petición GET
  al único servidor configurado. No pulsarlo si se quiere conservar la lectura actual.
- Abrir, recargar, navegar y el refresco visual general no generan consultas remotas.
- Los datos vencen a los 30 minutos, tanto en Fastify como en la vista. Al detener
  Fastify se pierde la lectura. No hay localStorage, sessionStorage, IndexedDB,
  exportación, respuesta remota en archivos ni logs de peticiones en este servidor.
- La instancia de inspección no publica los endpoints PostgreSQL de la demo. La demo
  anterior permanece separada; sus cámaras no se agregan a esta tabla ni viceversa.

## Arranque reproducible en macOS

Es una herramienta local ejecutada en el Mac con VPN, independiente de los contenedores.
Docker Compose sigue siendo la entrada de despliegue de la demo; esta herramienta no
inicia ni modifica Docker, rutas o bases. Requiere Node.js 22 o posterior y dependencias
ya instaladas. Construir primero:

```bash
npm --prefix apps/api run build
npm --prefix apps/web run build
```

Configurar un archivo JSON **local ignorado por Git**, por ejemplo
`.env.inspection.json`, con permisos 0600, propietario actual y exactamente un servidor.
Esquema ilustrativo (reemplazar localmente; no publicar valores reales):

```json
[{"id":"selected-server","baseUrl":"https://server.invalid:9443","username":"<local>","password":"<local>"}]
```

Cargarlo sin poner la contraseña en argumentos de comandos:

```bash
DIGIFORT_INSPECTION_CONFIG="$PWD/.env.inspection.json" npm --prefix apps/api run inspection
```

Alternativa para custodia sin archivo: `node apps/api/dist/inspection/server.js
--stdin-config` acepta el mismo JSON por stdin, una vez, hasta EOF. En terminal debe
ocultarse el eco antes de ingresar secretos. La instancia actual utilizó esta variante;
no se creó un archivo de credenciales. No escribir secretos en scripts ni historial.
El puerto predeterminado es 8083; `INSPECTION_PORT` permite seleccionar otro puerto
libre. Siempre se vincula exclusivamente a 127.0.0.1. La navegación cruza entre la demo
local 8082 y la inspección 8083; si se usan otros puertos, configurar
VITE_DEMO_ORIGIN y VITE_INSPECTION_ORIGIN al compilar la web (sólo orígenes locales,
sin secretos). No hay consulta automática al
iniciar. Cerrar el proceso con Ctrl+C elimina la lectura de RAM.

## API local y límites

- `GET /api/v1/inspection`: servidor lógico y lectura en RAM, o snapshot null. Nunca
  contacta Digifort. No revela origen remoto, usuario ni contraseña.
- `POST /api/v1/inspection/query`: cuerpo exclusivo `{"serverId":"selected"}`, cabecera
  `X-Digifort-Inspection: manual`. Sólo admite origen/Host local exacto. No permite al
  navegador suministrar URL, ruta, puerto ni credenciales.
- Fastify usa requestText existente con GET fijo `/Interface/Cameras/GetCameras`,
  `ResponseFormat=JSON`, autenticación del conector exclusivamente en el servidor,
  timeout 5 segundos y límite de cuerpo 1 MiB. Sin reintentos ni redirecciones.
- Una consulta concurrente recibe 409 y no inicia otra petición. La pantalla desactiva
  el botón mientras espera. Un fallo conserva la lectura anterior y su fecha original;
  no presenta ese contenido como recién observado.
- Respuestas no-store, no-referrer; registros de Fastify deshabilitados en este proceso.
  Sólo se conservan Name, Description y proyección del parser, no las respuestas
  completas, direcciones de cámaras, memo ni otros campos remotos.
- Los errores públicos son códigos saneados; jamás incluyen excepciones de transporte,
  URLs autenticadas, cabeceras o cuerpos remotos. Se mantiene la validación TLS.
- La completitud permanece unknown: ni HTTP 200 ni 118 filas acreditan cobertura total.

Los motivos son explicaciones del resultado del parser existente, no nuevas reglas.
No se interpreta Description como fuente de código ni se cambia el catálogo D/F/P.

## Validación

193 pruebas aprobadas con Node 22.23.4, incluidas seis pruebas nuevas de inspección:
GET local sin conexión remota, una petición por acción, texto original, origen/Host,
rechazo de parámetros extra y otro servidor, concurrencia, vencimiento, fallos
saneados sin reintentos, JSON inválido y respuesta demasiado grande. Las demás pruebas
que requieren almacenamiento usan exclusivamente PGlite temporal, nunca datos reales.
Compilaciones API/web aprobadas; migraciones 001/002/003 conservan sus checksums.

```bash
cd apps/api
node --import tsx --test tests/inspection.test.ts
```

Recorrido Chrome real: escritorio 1512 px y móvil 390 px, texto comparado contra la
lectura en RAM, búsqueda, filtros, orden descendente, 118 filas y desplazamiento propio,
sin errores de React ni desbordamiento horizontal de página. No toma capturas de datos
reales ni imprime sus nombres.

```bash
DEMO_URL=http://127.0.0.1:8083 npm --prefix apps/web run test:inspection
```

**Esta prueba pulsa Consultar GetCameras una vez si no existe lectura en RAM.** Ejecutar
sólo con autorización para ese servidor. Si ya está cargada, reutiliza la lectura y
no vuelve a consultar. Requiere Google Chrome en macOS; NODE_BINARY permite elegir Node.

## Archivos

- `apps/api/src/inspection/service.ts`, `routes.ts`, `server.ts`: servicio en RAM,
  contratos locales y entrada independiente sin base de datos.
- `apps/api/src/app.ts`, `apps/api/package.json`: registro opcional y comando inspection.
- `apps/api/tests/inspection.test.ts`: pruebas sintéticas de API y transporte.
- `apps/web/src/Inspection.tsx`, `main.tsx`, `style.css`, `vite-env.d.ts`: tabla, filtros, navegación,
  mensajes diferenciados de datos reales y responsive.
- `apps/web/package.json`, `apps/web/tests/inspection-browser.mjs`,
  `apps/web/tests/identities-browser.mjs`, `ops/test-identities-browser.py`: recorrido
  nuevo y adaptación de la navegación de cinco accesos.
- `docs/digifort-inspection.md`, `docs/visual-demo.md`: operación y validación.

## Comparación exploratoria Name / Description

La tabla agrega candidatos y resultados independientes para ambos campos, indicador
**≠ Códigos diferentes**, resaltado de fila, motivos independientes y filtros por
resultado Description y comparación. Se conservan Name y Description completos.
Actualizar la pantalla con Cmd+R carga el nuevo diseño y lee sólo la memoria local;
no genera GetCameras. Si venció la lectura, el botón manual permite renovarla.

La comparación se calcula exclusivamente en el navegador sobre el snapshot ya cargado,
sin agregar endpoints, reiniciar Fastify ni extender la fecha de vencimiento. El helper
`apps/web/src/inspection-comparison.ts` reutiliza la función pura de reconocimiento
existente y descarta sus metadatos de fuente al explorar Description. No modifica
el parser, el DTO oficial de Name, la fuente de identidad, códigos, UUIDs o PostgreSQL.
No se utiliza el extractor legado de Description ni se buscan códigos dentro de texto.

El resumen cuenta **Válido** como reconocido. Los candidatos de tipo desconocido se
comparan, pero no cuentan como códigos reconocidos. La comparación es literal:
`025D` y `25D` son diferentes; no se quitan ceros ni se normalizan identidades.
Filtros: candidatos iguales, códigos diferentes (ambos no nulos y distintos), sólo
Name, sólo Description y sin candidatos. Tener candidato sólo en un campo no se
presenta como si existieran dos códigos distintos.

Resultados sobre los mismos 118 registros en memoria, sin nuevas consultas:

| Comparación | Cantidad |
|---|---:|
| Reconocidos desde Name | 22 |
| Reconocidos desde Description (exploratorio) | 118 |
| Candidatos iguales en ambos campos | 22 |
| Ambos candidatos presentes y diferentes | 0 |
| Candidato sólo en Description | 96 |

Estos conteos no autorizan cambiar la fuente de identidad. No se guardaron los
registros reales ni capturas. Validación con Node 22: cuatro pruebas nuevas del
helper, compilación web y Chrome a 1512/390 px, incluyendo filtros de comparación,
resultado Description, búsqueda, ordenamiento y texto original, **cero POST de consulta**.
Los archivos de esta ampliación son Inspection.tsx, inspection-comparison.ts,
style.css, package.json, inspection-comparison.test.ts, inspection-browser.mjs y este documento.

```bash
npm --prefix apps/web run test:comparison
DEMO_URL=http://127.0.0.1:8083 INSPECTION_NO_QUERY=1 npm --prefix apps/web run test:inspection
```

INSPECTION_NO_QUERY=1 impide que la prueba pulse Consultar si la memoria está vacía;
en ese caso comprueba la opción de renovación manual y termina sin contactar Digifort.

## Fuente oficial actualizada

Description es ahora la fuente oficial; Name se mantiene para comparación diagnóstica
y vínculo técnico. La pantalla conserva ambos candidatos, originales, filtros y
contadores. Esta actualización no consulta Digifort ni renueva la lectura en memoria.
Los resultados anteriores siguen siendo evidencia histórica válida (22 Name / 118
Description), no una autorización de asignación o fusión automática. Ver
[description-identity.md](description-identity.md). Si venció la lectura, renovarla
manualmente con el botón; no hay consultas automáticas.
