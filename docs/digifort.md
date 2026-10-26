# Conector Digifort — Etapa 2

> Regla vigente: [Description como fuente oficial](description-identity.md). Desde esta corrección, Name es sólo la clave técnica exacta; no hay fallback automático. Las referencias anteriores a Name como fuente son históricas.

## Estado y referencia funcional

El módulo `apps/api/src/digifort` contiene un cliente JSON basado en la API anterior indicada por el usuario, analizada en modo de sólo lectura (`index.js` y `package.json`). No se ejecutaron los originales, no se copiaron al repositorio y no se consultaron servidores. Los tests utilizan exclusivamente datos sintéticos y transporte inyectado.

La referencia utiliza Express, Axios y dotenv; también contiene JWT y middleware de seguridad propios de aquella aplicación. El nuevo backend conserva TypeScript, Fastify y `fetch` nativo de Node.js 22. No se trasladaron dependencias de Express, rutas públicas, credenciales predeterminadas ni inventarios municipales.

La lectura del código confirma el contrato que esa API consume: dos endpoints JSON y asociación por `Name`. La compatibilidad se prueba contra ese comportamiento con fixtures sintéticas; aún no se validó una respuesta directa anonimizada de la instalación. El análisis PHP anterior permanece como documento histórico en [digifort-legacy-analysis.md](digifort-legacy-analysis.md); la referencia JSON corrige la asociación sin identidad observada allí.

## Componentes y uso

- `json-client.ts`: `DigifortJsonClient`, consulta explícita de un servidor.
- `json-parser.ts`: `parseInventoryJson`, `parseStatusJson` y `associateCameras`.
- `json-types.ts`: DTOs de inventario y estado, cámara asociada y cobertura.
- `config.ts`: validación de servidores privados y `parseDigifortServers`.
- `http.ts`: transporte compartido, acotado y sin logs para XML y JSON.
- `errors.ts`: códigos tipados y mensajes sin datos privados.
- `parser.ts`, `client.ts`, `types.ts`: contrato XML sintético anterior, conservado por compatibilidad. No representa un parser XML real de Digifort.
- `index.ts`: exportaciones públicas del módulo.

El módulo no está instanciado por `server.ts` ni por las rutas Fastify. No tiene persistencia, scheduler, consultas automáticas ni nuevos endpoints públicos.

Uso programático futuro, sin valores de conexión en el código:

```ts
import { DigifortJsonClient, parseDigifortServers } from './digifort/index.js';

// Parsing configuration does not initiate requests.
const servers = parseDigifortServers(process.env.DIGIFORT_SERVERS_JSON);
const clients = servers.map(server => new DigifortJsonClient({ server }));
// Only an explicit getCameras() call initiates requests; not enabled at startup.
```

No registrar `servers`, la variable de entorno, URLs autenticadas ni resultados con datos municipales. El fragmento es ilustrativo y no está conectado al arranque de la aplicación.

## Transporte y autenticación

Por cada llamada a `getCameras()` se consultan en paralelo:

| Endpoint | Método | Parámetros |
| --- | --- | --- |
| `/Interface/Cameras/GetCameras` | GET | `ResponseFormat=JSON`, `AuthUser`, `AuthPass` |
| `/Interface/Cameras/GetStatus` | GET | `ResponseFormat=JSON`, `AuthUser`, `AuthPass` |

Se construyen parámetros con `URL.searchParams`: los caracteres reservados de las credenciales se codifican correctamente. Esta autenticación por query reproduce la referencia funcional; no es HTTP Basic. La autenticación de los consumidores de Fastify sigue fuera del alcance de este módulo.

La configuración de cada servidor requiere `id`, `baseUrl`, `username` y `password`. Acepta `name` y `nodeId` opcionales. `baseUrl` es sólo el origen HTTP/HTTPS, con puerto explícito si corresponde, sin ruta, query, fragmento ni credenciales incrustadas. No hay valores reales ni credenciales por defecto. Se rechazan IDs de servidor duplicados.

`parseDigifortServers` acepta el texto JSON de una variable privada `DIGIFORT_SERVERS_JSON` que contiene un array de estas configuraciones. Si está ausente o es `[]`, devuelve cero servidores; si está mal formada, falla con `CONFIGURATION` sin mostrar el contenido. No lee archivos ni carga dotenv de forma implícita. Cuando se habilite un despliegue, inyectar la configuración mediante un mecanismo privado y fuera de Git; esta etapa no modifica Compose ni los archivos de secretos.

HTTP se admite por compatibilidad con la referencia. No proporciona cifrado; habilitar HTTPS dependerá del soporte y certificados de la instalación. Nunca se desactiva la validación TLS. Las URLs autenticadas no se registran, pero la configuración del proxy/servidor remoto también deberá evitar registrar la query antes de utilizar servidores reales.

El cliente usa campos privados nativos de JavaScript para evitar que la inspección o serialización de una instancia muestre credenciales. Esa protección no convierte la configuración externa o los datos retornados en información pública.

## Respuestas y campos conservados

Ambos parsers exigen un array en `Response.Data.Cameras`, como la referencia. No esperan el envoltorio XML `Data/Cameras/Camera` ni la raíz sintética `SyntheticCameraList`. Un array vacío explícito es válido; estructura ausente, objeto en lugar de array o nombres ausentes no equivalen a lista vacía.

Cada cámara asociada devuelve `inventory` y `status` como DTOs con los nombres originales de campos, más un resumen normalizado. Se seleccionan únicamente campos consumidos por la API anterior; no se copia indiscriminadamente el objeto remoto.

| DTO | Campos |
| --- | --- |
| Inventario | `Name`, `Description`, `Active`, `Model`, `DeviceType`, `ConnectionAddress`, `ConnectionPort`, `Latitude`, `Longitude`, `Memo`, `MediaProfiles`, `Group` |
| Estado | `Name`, `Active`, `Working`, `ActiveTime`, `InactiveTime` |
| Grabación dentro de estado | `ConfiguredToRecord`, `WrittingToDisk`, `RecordingFPS`, `RecordingHours`, `RecordingHoursEstimative`, `UsedDiskSpace` |

`WrittingToDisk` conserva deliberadamente la grafía usada por la referencia. Los booleanos aceptan valores JSON booleanos y cadenas `true`/`false` sin distinguir mayúsculas. Ausencias y nulos se convierten en `null`; tokens como `yes` o `1` se rechazan en lugar de convertirse silenciosamente en falso.

Los valores numéricos o cadenas numéricas se conservan sin convertir unidades ni aplicar `||`: cero, falso y cadena vacía no se sustituyen por valores predeterminados. `MediaProfiles` y `Group` conservan su estructura JSON, incluyendo arrays y objetos. Los metadatos de texto conservan su contenido. La dirección se mantiene en `ConnectionAddress`: puede ser hostname y no se fuerza a una IPv4.

El resumen asociado contiene:

| Campo | Significado |
| --- | --- |
| `name`, `serverId` | Clave de consulta compuesta por servidor lógico y `Name` exacto |
| `serverName` | Etiqueta opcional de configuración; no se infiere del servidor remoto |
| `nodeId` | Contexto opcional, o `null`; no se infiere de IP |
| `cameraId`, `cameraType` | Convención heredada de Description: patrón de 2–4 dígitos seguido de F/D/P y `)`; tipos Fija/Domo/Punto; desconocido es `null` |
| `active`, `working` | Booleanos independientes o `null` |
| `activeSource` | `status`, `inventory` o `unknown`, según la procedencia del Active utilizado |
| `inventory`, `status` | DTOs completos seleccionados; estado sin correspondencia es `null` |

El cliente no publica `ServerIp`: la dirección del servidor permanece en la configuración privada y se identifica el resultado mediante `serverId` y etiqueta opcional. Tampoco se trasladan nombres municipales ni la regla del tercer octeto a un inventario de nodos. La asignación `nodeId` se aplica a todo el contexto de la consulta; si un servidor contiene varios nodos, dejarla en `null` y resolver cada relación con inventario en una etapa posterior.

## Asociación y estado desconocido

La unión utiliza un mapa por **`Name` exacto dentro de un único servidor**. Se preservan mayúsculas y espacios, sin normalizar silenciosamente la clave. Se rechazan nombres repetidos en cualquiera de los arrays con `DUPLICATE_NAME`, incluso si se llama a la asociación directamente con DTOs. Reordenar el estado no altera la cámara a la que pertenece.

Name es una clave de asociación confirmada por el código funcional de referencia, no un UUID inmutable. Si se renombra una cámara, cambia esa clave. `cameraId` derivado de Description es una convención local editable y no se utiliza como sustituto para unir respuestas. La persistencia futura necesitará una decisión explícita de identidad y renombrados.

`coverage` contiene sólo contadores:

- `matched`: cámaras de inventario con estado coincidente.
- `missingStatus`: cámaras de inventario sin estado; permanecen en el resultado.
- `orphanStatus`: estados sin inventario; no crean cámaras ficticias.

Active da prioridad al estado y, si es nulo o está ausente, utiliza Active de inventario, como la referencia. `activeSource` conserva esa procedencia. Working procede exclusivamente del estado y permanece desconocido cuando no está disponible. Los campos de grabación ausentes también permanecen nulos; no se inventan cero FPS ni falta de grabación.

Las nueve combinaciones de Active y Working (`true`, `false`, `null`) son válidas e independientes. Un endpoint fallido rechaza la consulta con un error tipado: no devuelve un snapshot vacío ni transforma el servidor en cámaras falsas. Tampoco se afirma que un fallo HTTP de autenticación sea un servidor caído.

Las dos consultas no son una instantánea atómica. El snapshot no certifica integridad temporal ni totalidad del inventario por sí solo; deberá validarse paginación y semántica de resultados con documentación o muestras autorizadas.

## Límites y errores

`DigifortJsonClientOptions` permite transporte `fetch` inyectado, `timeoutMs` (5000 por defecto) y `maxResponseBytes` (1 MiB por defecto, sólo reducible). Ambos límites se aplican por endpoint. El timeout cubre headers y cuerpo; cancela el stream al vencer. Las redirecciones están bloqueadas y el límite se comprueba durante la lectura, independientemente de `Content-Length`.

Los cuerpos se decodifican como UTF-8 estricto. El JSON directo también tiene límite de 1 MiB y profundidad máxima de 32 niveles. El parser síncrono no puede interrumpirse mediante timer, por eso se acota su entrada. No se exige un Content-Type específico para no añadir una condición no observada en la referencia.

| Código | Significado |
| --- | --- |
| `CONFIGURATION` | Configuración privada o límites inválidos |
| `HTTP_ERROR` | HTTP no exitoso; sólo conserva código numérico en `httpStatus` |
| `NETWORK_ERROR` | Conexión, TLS, redirección rechazada o lectura interrumpida |
| `TIMEOUT` | Venció el plazo de ese endpoint |
| `RESPONSE_TOO_LARGE` | Se excedió el límite de bytes |
| `INVALID_JSON` | JSON o UTF-8 inválidos |
| `INVALID_RESPONSE` | Envoltorio, tipos o campos obligatorios incompatibles |
| `DUPLICATE_NAME` | Unión ambigua por nombres duplicados |
| `INVALID_XML` | Error del contrato XML sintético conservado |

Los errores no conservan causa, URLs, cuerpos, headers, configuración ni identificadores municipales. No hay logs del conector. No se introdujo una regla de error funcional de Digifort no documentada: una respuesta HTTP 200 sin el envoltorio esperado se rechaza, pero aún se debe confirmar cómo informa errores de negocio la instalación.

## Contrato XML sintético conservado

`DigifortClient` y `parseSyntheticCameras` siguen disponibles exclusivamente para el contrato sintético v1 anterior. Sus fixtures `synthetic-*.xml` declaran su naturaleza de ensayo. Exigen `SyntheticCameraList version="1"`, elementos `Camera` con `Id`, `Name`, `IP`, `Active` y `Working`, y literales booleanos minúsculos. Conservan validación de campos, IDs únicos, IPv4/IPv6, DTDs prohibidos, caracteres y entidades XML legales, límite de tamaño y 16 niveles de anidamiento.

Este contrato no debe conectarse a los endpoints JSON. `NormalizedCamera` continúa describiendo sólo ese contrato completo; `DigifortJsonCamera` permite explícitamente observaciones desconocidas y metadatos separados.

## Pruebas y validación pendiente

En `apps/api`: `npm run build` y `npm test` (o antes `npm ci` si faltan dependencias). Las fixtures JSON `synthetic-inventory.json` y `synthetic-status.json` contienen nombres ficticios y direcciones de documentación; no son capturas ni copias de producción.

Se prueba normalización completa, ceros y falsos, flags desconocidos, grabación, unión por Name reordenado, duplicados, faltantes, huérfanos, aislamiento por servidor, configuración inválida, codificación de credenciales ficticias, ausencia de secretos en errores/inspección del cliente, HTTP, límites, timeout y cancelación. Las pruebas XML y de salud Fastify siguen vigentes. No hay conexiones reales ni cambios a PostgreSQL o al frontend.

Quedan pendientes muestras JSON anonimizadas y documentación de la instalación para confirmar versiones, tipos efectivos, nombres y unidades, errores funcionales, cardinalidad, paginación, límites apropiados, TLS y estabilidad de Name. No se activa el conector hasta una etapa explícita posterior.

## Identidad municipal oficial desde Description

`parseMunicipalDescription` recibe exclusivamente Description y devuelve source
Description, originalDescription íntegro, delimitador, clasificación y componentes.
Ejemplos: `025D`, `025D) Avenida Principal` y `025D Avenida Principal` producen código
`025D`, número textual `025` y tipo D. No se incluye `)` ni se quitan ceros.
El código debe comenzar en posición cero: dígitos ASCII y letra mayúscula, con `)`
opcional; sin delimitador, el texto posterior requiere un espacio. Se rechazan
controles, prefijos descriptivos y extracciones parciales. Se conservan valid, absent,
invalid y unknown_type. D/F/P es el catálogo inicial, extensible explícitamente.

Name y Description se conservan completos en los DTOs. Name exacto sólo une respuestas
por servidor y resuelve vínculos técnicos; no aporta código de fallback. Name con un
código válido y Description ausente produce candidato ausente. Los campos legados
cameraId/cameraType conservan su extractor restringido por compatibilidad, pero no
sustituyen municipalIdentity ni autorizan asignaciones.

`parseMunicipalCameraName` permanece únicamente para comparación diagnóstica en la
pantalla de inspección. Ningún flujo de identidad lo usa como fuente alternativa.
Los candidatos no confirman códigos, no fusionan cámaras ni modifican UUID.

## Colección manual por endpoint

`DigifortJsonClient.collectEndpoints()` es aditivo: conserva el contrato de `getCameras()` y recoge intentos independientes mediante el mismo transporte y parsers. Las respuestas válidas mantienen completitud unknown; no se presume que HTTP 200 sea suficiente. Flujo, reintentos, metadatos y límites de persistencia: [manual-synchronization.md](manual-synchronization.md).

## Validación SQL vigente

004_description_identity incorpora validación desde Description y procedencia de
propuestas. 001/002/003 no se modifican. Ver [description-identity.md](description-identity.md).
La siguiente evidencia es histórica, anterior al cambio de fuente; no se repitieron
consultas reales durante esta corrección.

## Validación de lectura del parser ampliado — 2026-10-24

Una única petición GetCameras autorizada devolvió HTTP 200 y 118 cámaras: 22
candidatos municipales válidos, 0 ausentes, 96 inválidos y 0 de tipo desconocido.
El parser de inventario aceptó la estructura; no se encontraron Name duplicados.
La completitud permanece desconocida. No se consultó GetStatus ni se guardó la
respuesta completa; el análisis fue en memoria, sin persistir cámaras o identidades.
Pruebas: 187 aprobadas con Node 22.23.4 y compilación API correcta.
