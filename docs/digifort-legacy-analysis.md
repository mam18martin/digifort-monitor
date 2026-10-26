# Análisis del conector PHP legado y adaptación propuesta

## Alcance y grado de certeza

Se leyeron `AGENTS.md` y `docs/digifort.md`, los cuatro archivos PHP del directorio externo indicado por el usuario y el módulo `apps/api/src/digifort`. El análisis fue estático: no se ejecutó el PHP, no se consultó Digifort y no se copiaron originales al repositorio. Las lecturas se filtraron para ocultar literales sensibles antes de mostrarlos en la salida de las herramientas.

Este informe describe **lo que el PHP solicita y espera interpretar**, no una validación del contrato efectivo del servidor. No hay fixtures XML en el directorio analizado. Faltan respuestas anonimizadas y documentación de la versión instalada para confirmar raíz, identificadores, tipos, errores, codificación y cardinalidad. El nombre de un archivo que contiene una versión no demuestra la versión del servidor.

Fuentes locales, con referencias de línea de los originales:

| Archivo | Función en el sistema |
| --- | --- |
| `camaras-activas8.5.php` | Consultas, normalización local, asociación de estados y estadísticas |
| `nodos.php` | Tabla estática que relaciona un segmento IPv4 con nombres de nodos |
| `Generic.class.php` | Contenedor de campos, lectura/escritura mediante `member()` |
| `panel/index.php` | Incluye el cálculo y presenta los resultados; no agrega consultas Digifort en sus bloques PHP |

Se omiten hosts, puertos de despliegue, credenciales, inventario de servidores, nombres reales de nodos y demás datos municipales. Los nombres de endpoints y campos que siguen son elementos técnicos del protocolo, sin valores privados.

## 1. Consultas y autenticación observadas

`Servidor::getCameras()` construye una base HTTP con la dirección de cada servidor configurado y un puerto explícito. Realiza dos consultas secuenciales con `file_get_contents`:

| Consulta | Método implícito | Ruta completa | Parámetros |
| --- | --- | --- | --- |
| Inventario/configuración | GET | `/Interface/Cameras/GetCameras` | `ResponseFormat=XML`, `AuthUser`, `AuthPass` |
| Estados | GET | `/Interface/Cameras/GetStatus` | `ResponseFormat=XML`, `AuthUser`, `AuthPass` |

Referencia: `camaras-activas8.5.php:163–181`. Los parámetros de autenticación se concatenan desde una cadena con valores fijos. No se observan cabeceras Authorization, Basic/Digest, tokens de sesión ni construcción mediante `http_build_query`/`urlencode`. Por lo tanto, el mecanismo implementado es usuario y contraseña en la query, no HTTP Basic. No se reproducen sus valores ni una URL autenticada completa.

El contexto configura `timeout: 5` e `ignore_errors: false`; no declara otro método ni una política propia de redirecciones. Se silencian avisos con `@`. Si cualquiera de las dos lecturas devuelve `false`, se abandona el procesamiento del servidor. No se inspeccionan explícitamente códigos HTTP ni errores funcionales dentro de una respuesta HTTP exitosa. Las consultas se hacen al construir cada objeto servidor y los servidores se recorren secuencialmente (`:28–30`, `:114–118`).

**Implicaciones:** las credenciales en URL pueden aparecer en registros y el esquema observado no proporciona cifrado de transporte. La concatenación carece de codificación de parámetros. La futura adaptación deberá construir parámetros correctamente y mantenerlos fuera de logs y errores; cambiar a headers o HTTPS requiere verificar que la API instalada lo soporte, sin asumir equivalencia de autenticación.

## 2. Interpretación XML

Ambos cuerpos se procesan con `simplexml_load_string(..., LIBXML_NONET)`. Se habilitan temporalmente errores internos de libxml, se limpian y se restaura el estado anterior. Si falla cualquiera de los parseos, se retorna sin diferenciar el motivo (`:187–195`).

El acceso esperado es relativo al elemento raíz:

| Origen | Acceso utilizado |
| --- | --- |
| Inventario | `Data/Cameras/Camera` |
| Total declarado | `Data/Cameras/Count`, con alternativa de contar elementos de inventario |
| Estados | `Data/Cameras/Camera` |

El PHP no comprueba el nombre de la raíz ni una versión de esquema. Tampoco valida namespaces, integridad, unicidad o coincidencia de `Count` con el número de cámaras recibidas. Una estructura ausente puede convertirse en una colección vacía. **No se infiere de estos accesos que la raíz tenga un nombre específico.**

Campos consumidos (`:203–236`):

| Respuesta | Campo XML | Uso legado |
| --- | --- | --- |
| Inventario | `Description` | Divide por `)`; primer fragmento como `idcam`, segundo como descripción local |
| Inventario | `Name` | Nombre de cámara |
| Inventario | `ConnectionAddress`, `ConnectionPort` | Dirección y puerto; la dirección también decide el nodo |
| Inventario | `Model`, `DeviceType` | Metadatos de dispositivo |
| Inventario | `Latitude`, `Longitude` | Coordenadas |
| Inventario | `MediaProfiles` | Conversión directa a texto; no recorre una posible estructura anidada |
| Estado | `Active`, `Working` | Se conservan como cadenas y se comparan con `TRUE`/`FALSE` |
| Estado | `InactiveTime` | Se convierte a número y se divide por 86400 para mostrar días con dos decimales |

La división de `InactiveTime` evidencia que el PHP **asume segundos**; la unidad y su semántica no están confirmadas. El código tampoco demuestra que `Description` sea un identificador nativo o estable: sólo documenta una convención local. Si falta el separador, faltan segmentos; si se repite, sólo se utiliza el segundo segmento como descripción.

## 3. Estadísticas y relaciones

Por servidor (`:130–136`, `:242–251`):

| Métrica | Regla exacta de la lógica PHP |
| --- | --- |
| Total | `Count` de inventario si existe; de lo contrario, número de elementos |
| Activas | Cantidad con `Active == "TRUE"` |
| Inactivas | Cantidad con `Active == "FALSE"` |
| Funcionando | Cantidad con `Working == "TRUE"`, sin exigir Active |
| Caídas / no funcionando | Cantidad con `Active == "TRUE"` y `Working == "FALSE"` |
| `percentactive` | Funcionando / activas × 100; cero si no hay activas; dos decimales |

Globalmente se suman los contadores por servidor y se recalcula el porcentaje sobre esas sumas (`:34–47`). No es un promedio de porcentajes.

El servidor de una cámara se asigna según el servidor consultado y su nombre configurado; no proviene de un campo XML (`:235`). El inventario de servidores está definido en código mediante campos `serverip` y `servername`; sus valores se excluyen del informe.

El nodo se obtiene validando IPv4, separándola por puntos y buscando **el tercer octeto** en la tabla externa de nodos (`:139–148`). No se comprueba una subred completa ni se consulta una relación de nodo a Digifort. Una dirección inválida, IPv6 o sin correspondencia devuelve `null`. Durante la agrupación se utiliza un rótulo común de nodo desconocido y se agrupa por nombre, no por un identificador de inventario (`:305–335`).

Por nodo se cuentan activas y funcionando independientemente. Las caídas se calculan como `max(0, activas - funcionando)`, y el porcentaje como funcionando / activas × 100, con un decimal. **Esta fórmula no equivale siempre al conteo de cámaras activas que no funcionan utilizado por servidor.**

## 4. Errores y limitaciones detectados

### Asociación de respuestas sin identidad

El bucle de inventario toma una clave de `foreach` y consulta `$statuses[$i]` (`:208–218`). No busca un identificador común. Incluso si se reemplazara por un contador numérico, dependería del mismo orden y cardinalidad en ambas respuestas.

Además, no se convierte la colección SimpleXML en un array indexado: la clave de iteración corresponde al nombre del elemento, no a una posición garantizada. El acceso con una clave textual mediante corchetes representa acceso a atributos en SimpleXML. En una colección normal de elementos `Camera`, esa expresión puede buscar un atributo en lugar del estado correspondiente y activar los valores por defecto. Es un defecto estructural de la asociación, no sólo un riesgo de reordenamiento. Referencias oficiales: [clave de SimpleXMLElement](https://www.php.net/manual/en/simplexmlelement.key.php) y [acceso a atributos](https://www.php.net/manual/en/simplexml.examples-basic.php).

No se reprodujo el caso en un runtime PHP: el ejecutable `php` no está disponible en esta sesión. El efecto exacto sobre la respuesta instalada queda pendiente de una reproducción aislada con XML anonimizado; no se afirma una medición de producción.

### Estados desconocidos convertidos en falsos

Un estado sin correspondencia o sin campos se transforma en Active=`FALSE`, Working=`FALSE`, InactiveTime=0. Esto puede clasificar una observación desconocida como inactiva. En cambio, si falla una consulta completa o su XML, se mantienen los contadores previamente reiniciados en cero, sin un estado explícito de servidor inaccesible (`:155–161`, `:183–195`). Se confunden falta de datos, inventario vacío y resultados observados.

### Estadísticas inconsistentes

- El numerador de funcionamiento incluye cámaras con Active falso. Sin una garantía del proveedor sobre las combinaciones, el porcentaje puede superar 100%.
- Ejemplo exclusivamente hipotético: cámara `camera-a` activa y no funcionando; cámara `camera-b` inactiva y funcionando. El servidor cuenta una caída, mientras que el nodo calcula cero; ambos pueden mostrar 100% con una cámara activa caída.
- `max(0, ...)` oculta el resultado negativo de una discrepancia, sin diagnosticarla.
- Se confía en `Count` sin contrastarlo con registros, por lo que total, activas e inactivas pueden no reconciliar.
- No se consideran desconocidos ni antigüedad de datos. Las dos consultas no constituyen una instantánea atómica.
- Comparaciones con cadenas mayúsculas no normalizan variantes ni validan tokens desconocidos; valores diferentes pueden quedar fuera de todos los conteos.

### Inventario y operación

- `idcam` depende de texto editable, sin validación de unicidad; nombre, IP y nodo tampoco garantizan identidad estable.
- Resolver nodos sólo por el tercer octeto puede colisionar entre redes y no admite IPv6. Agrupar por nombre también puede fusionar nodos diferentes.
- La consulta en constructores acopla carga de objetos, red y generación del panel; los tiempos de espera se acumulan entre servidores y endpoints.
- No hay diagnóstico separado de autenticación, transporte, formato y error funcional, ni límite explícito de bytes del cuerpo en el código de aplicación.
- Como protecciones existentes, el código usa `LIBXML_NONET`, restaura el estado de errores libxml y escapa los valores de las tablas con `htmlspecialchars`. Esas medidas no corrigen la asociación de estados ni validan el contrato.

## 5. Comparación con TypeScript

| Área | PHP analizado | Implementación TypeScript actual |
| --- | --- | --- |
| Consultas | Inventario y estado separados | Una ruta configurable y un parser por cliente; no hay orquestación de ambas respuestas |
| Autenticación | `AuthUser` y `AuthPass` en query | Headers configurables y query posible en `camerasPath`; sin autenticación Digifort específica |
| XML | Espera `Data/Cameras/Camera` bajo una raíz no verificada | Sólo acepta `SyntheticCameraList version="1"` |
| Datos | Inventario y estado tienen campos distintos | Exige `Id`, `Name`, `IP`, `Active` y `Working` dentro de cada cámara sintética |
| Identificador | Fragmento de `Description` | `id` textual con ceros iniciales, único dentro de `serverId`; todavía sin campo real confirmado |
| Dirección | `ConnectionAddress`, usada como IPv4 para nodos | `ip` debe ser IPv4 o IPv6 válida; rechaza hostnames |
| Flags | Compara `TRUE`/`FALSE` | Sólo acepta `true`/`false` minúsculos |
| Nodo | Relación por cámara usando dirección | Un `nodeId` de contexto para toda la respuesta, o `null` |
| Datos parciales | Omisiones pasan a vacío/falso/cero | Parser sintético rechaza el lote incompleto |
| Errores | Retorno silencioso y contadores cero | Errores HTTP, red, timeout, XML y contrato separados |
| Límites | Timeout del stream de cinco segundos | Plazo de consulta y lectura, límite de 1 MiB y profundidad XML acotada |

El cliente TS bloquea redirecciones y omite datos privados en errores; esas propiedades deben conservarse. No corresponde adaptar el contrato real relajando indiscriminadamente el parser sintético. La biblioteca XML y sus protecciones son reutilizables, pero la validación de campos debe ser específica por respuesta.

## 6. Adaptación propuesta, todavía sin implementar

1. Mantener `parseSyntheticCameras` como contrato de ensayo. Incorporar adaptadores de inventario y estado sólo después de confirmar muestras autorizadas de ambos endpoints, sus raíces y sus errores funcionales.
2. Separar DTOs: inventario con identidad y metadatos; estado con identidad, Active, Working y eventualmente InactiveTime. No exigir nombre o dirección a una respuesta que sólo contiene estado.
3. Determinar un identificador nativo compartido por ambas respuestas. **El PHP no demuestra cuál es.** Revisar candidatos en XML y documentación; comprobar unicidad por servidor, estabilidad ante cambios de nombre/IP y presencia en ambas consultas. No utilizar automáticamente el fragmento de Description como clave técnica.
4. Unir mediante mapas por `serverId` e ID confirmado. Reordenar listas no debe alterar resultados. IDs duplicados, ausentes o sin correspondencia deben producir discrepancias explícitas, sin asociación alternativa por posición, nombre o IP.
5. Conservar Active y Working como observaciones distintas. Si hay estados incompletos, mantener el modelo completo mediante rechazo explícito, o diseñar un tipo de observación parcial con valores desconocidos antes de cambiar la interfaz. Nunca completar ausencias con `false`.
6. Mantener disponibilidad de servidor, resultado de cada endpoint y frescura separados del estado de cámara. Un error no demuestra que todas las cámaras estén caídas. Por ahora se trata sólo de un diseño; no implica persistencia ni sincronización.
7. Validar si `ConnectionAddress` siempre es una IP o puede ser hostname/URI antes de mapearla a `ip`. Proponer campo de dirección separado y `ip` opcional sólo si las muestras lo justifican.
8. Resolver nodo por cámara mediante un inventario explícito. La regla del tercer octeto debe identificarse como una política local heredada, no como semántica de Digifort. No incluir la tabla municipal en fixtures.
9. Agregar transporte para las dos rutas observadas y parámetros codificados. Cargar autenticación desde configuración privada; no poner credenciales en código, excepciones o logs. Confirmar mecanismo soportado y TLS antes de una conexión futura.
10. Acordar definiciones estadísticas: si se desea medir funcionamiento entre activas, usar activas-y-funcionando como numerador. Mantener la métrica independiente de Working si se necesita para diagnóstico. Mostrar desconocidos y cobertura, y evitar reproducir errores PHP como resultados esperados.

## 7. Plan de fixtures y pruebas sin red

Se necesitan pares de respuestas de inventario/estado anonimizadas de una misma consulta lógica, acompañadas por versión confirmada, estado HTTP y codificación, sin URL completa ni cabeceras de autenticación. Debe preservarse la correspondencia consistente de IDs entre archivos y reemplazarse nombres, direcciones, coordenadas y demás datos municipales. Usar nombres ficticios y bloques IP de documentación; la anonimización debe conservar namespaces, tipos, estructura, orden y relaciones relevantes.

| Caso | Resultado esperado a acordar y verificar |
| --- | --- |
| Par mínimo válido | Campos reales mapeados y unidos por ID confirmado |
| Estados reordenados | Mismas observaciones por identidad |
| IDs repetidos o faltantes | Error/discrepancia explícita, sin unión por posición |
| Estado huérfano o cámara sin estado | Cobertura incompleta explícita; no convertir a falso |
| IDs con ceros iniciales y mismos IDs en servidores distintos | Preservación textual y aislamiento por servidor |
| Cambios de nombre/dirección | La identidad permanece si así lo garantiza el identificador real |
| `TRUE`/`FALSE` y combinaciones independientes | Conversión verificada de cada flag; tokens ajenos rechazados |
| Lista vacía, un elemento y varios | Cardinalidad correcta y distinción de respuesta incompleta |
| `Count` incoherente o paginación | Diagnóstico de cobertura, sin asumir inventario completo |
| Error funcional con HTTP 200 | Error de API, nunca inventario vacío |
| XML inválido, DTD, cuerpo interrumpido y timeout | Errores tipados sin datos privados |
| Cámaras de nodos distintos en un servidor | Asignación independiente por cámara |
| Estadísticas heredadas | Comparar fórmulas con resultados calculados independientemente; documentar divergencias |

No se fabricaron fixtures con una supuesta raíz o clave real. Las futuras pruebas usarán transporte simulado, sin PHP original, servidores Digifort, PostgreSQL ni scheduler. Debe distinguirse una prueba pendiente por falta de muestra de una prueba de contrato aprobada.

## Resultado y pendientes

Quedaron identificados los dos endpoints, parámetros, autenticación por query, accesos XML, campos utilizados, fórmulas y relación local de nodos. La prioridad es corregir conceptualmente la unión entre inventario y estado y confirmar el identificador compartido. Faltan XML anonimizados para habilitar un adaptador real; este análisis por sí solo no verifica compatibilidad con el servidor.

Único archivo agregado por esta tarea: `docs/digifort-legacy-analysis.md`. No se modificó el conector, los PHP originales, PostgreSQL ni el frontend. No se ejecutaron commits ni pushes.

Nota vigente: Description es la fuente oficial del candidato municipal; el extractor
legado limitado no sustituye parseMunicipalDescription. Name se conserva como clave
técnica exacta, sin fallback de identidad. `)` es opcional y se excluye del código.
Ver [description-identity.md](description-identity.md).
