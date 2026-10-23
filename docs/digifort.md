# Conector Digifort — Etapa 2

## Estado y límites

`apps/api/src/digifort` es un módulo independiente, sin conexión al arranque de Fastify, rutas públicas, acceso a PostgreSQL ni tareas periódicas. No se consultaron servidores Digifort. El transporte HTTP se implementó con `fetch` de Node.js 22; todas sus pruebas inyectan un transporte simulado, sin red.

**No conocemos todavía el contrato exacto de la API Digifort existente.** El parser `parseSyntheticCameras` implementa exclusivamente un contrato de ensayo local. Ni sus etiquetas ni la ruta usada en las pruebas representan endpoints o respuestas confirmados del proveedor. El cliente exige un adaptador explícito para evitar asumir compatibilidad.

## Componentes

- `types.ts`: `NormalizedCamera`, `CameraContext` y firma `CameraParser`.
- `parser.ts`: validación XML y normalización del contrato sintético mediante `fast-xml-parser`, con validación de tipos en ejecución. Referencia de la biblioteca: [repositorio oficial](https://github.com/NaturalIntelligence/fast-xml-parser).
- `client.ts`: GET configurable y acotado, sin reintentos ni solicitudes automáticas.
- `errors.ts`: errores tipados sin URL, headers, XML, credenciales ni errores originales.
- `index.ts`: exportaciones del módulo.

## Modelo normalizado

| Campo | Tipo | Decisión |
| --- | --- | --- |
| `id` | `string` | Obligatorio; conserva ceros iniciales. La identidad es el par `(serverId, id)` |
| `name` | `string` | Obligatorio, Unicode, sin espacios exteriores |
| `ip` | `string` | Dirección IPv4 o IPv6 válida; no se utiliza como identidad |
| `serverId` | `string` | Identificador lógico suministrado por configuración, no una dirección de servidor |
| `nodeId` | `string \| null` | Asignación externa; `null` significa desconocida o no asignada |
| `active` | `boolean` | Observación independiente del campo sintético `Active` |
| `working` | `boolean` | Observación independiente del campo sintético `Working` |

Servidor y nodo se suministran como contexto de cada consulta. Se aplica el mismo contexto a todas las cámaras de la respuesta; si pertenecen a nodos diferentes, debe suministrarse `nodeId: null` y resolver esa asignación con inventario en otra etapa. No se infiere por IP.

Un error de transporte o timeout no devuelve cámaras con `active: false` o `working: false`, ni una lista vacía. Rechaza la consulta con un error tipado. Una futura capa de sincronización deberá conservar las últimas observaciones y registrar su antigüedad y la accesibilidad del servidor por separado. Las cuatro combinaciones de Active y Working se conservan; su semántica definitiva debe validarse con el proveedor.

## Contrato XML sintético v1

Fixtures: `apps/api/tests/fixtures/digifort/synthetic-*.xml`. Cada archivo indica que es sintético; las direcciones pertenecen a los bloques de documentación `192.0.2.0/24` y `2001:db8::/32`.

```xml
<!-- SYNTHETIC TEST CONTRACT ONLY. Not an actual Digifort response. -->
<SyntheticCameraList version="1">
  <Camera>
    <Id>0001</Id>
    <Name>Cámara sintética</Name>
    <IP>192.0.2.10</IP>
    <Active>true</Active>
    <Working>false</Working>
  </Camera>
</SyntheticCameraList>
```

La raíz y la versión son obligatorias. Una raíz vacía con versión correcta representa una lista vacía válida. Una cámara requiere todos los campos; sólo se aceptan los literales `true` y `false`. Campos duplicados, desconocidos, IDs repetidos, IP inválida, campos vacíos o anidados y respuestas parciales rechazan el lote completo. No se convierten campos ausentes en falsos ni se devuelve una lista parcialmente válida.

Se conserva texto Unicode y se decodifican entidades XML estándar. Se rechazan DTDs y declaraciones de entidades, referencias no declaradas, caracteres XML ilegales, XML mal formado, exceso de tamaño y anidamiento superior a 16 niveles. No se resuelven entidades externas. El contrato es deliberadamente estricto y deberá sustituirse por un adaptador probado cuando se confirme el formato real.

## Configuración HTTP

`DigifortClientOptions` requiere `baseUrl`, `camerasPath`, `context` y `parseCameras`. Opcionalmente acepta `headers`, `timeoutMs` (5000 por defecto), `maxResponseBytes` (1 MiB por defecto, sólo reducible) y una implementación `fetch` para pruebas.

- GET, resolución estándar de URL sobre la base; una ruta con `/` inicial parte de la raíz del origen. No hay ruta de proveedor predeterminada.
- Sólo HTTP/HTTPS, mismo origen para la URL resuelta, sin usuario o contraseña en URL ni fragmentos. Las credenciales futuras deben suministrarse desde configuración privada; no están implementadas ni incluidas en los ejemplos.
- No se siguen redirecciones, para evitar transmitir headers a destinos inesperados. Con `fetch` nativo una redirección rechazada se presenta como error de transporte.
- Timeout para espera de headers y lectura del cuerpo. Se aborta la solicitud y se cancela la lectura al vencer el plazo. El límite de bytes se comprueba durante la lectura, incluso sin `Content-Length`.
- Cuerpo UTF-8; no se exige un `Content-Type` concreto hasta conocer el comportamiento real del proveedor. Una respuesta HTTP 200 no evita la validación XML y del contrato.
- No se deshabilita la validación TLS, no hay logs del conector, reintentos, scheduler ni persistencia. El parser es síncrono; el límite de bytes y profundidad acota su entrada, pero el timer no puede interrumpir CPU síncrona.

La construcción del cliente no hace solicitudes. Sólo una llamada explícita a `getCameras()` inicia una consulta. No se incorporó ninguna instancia con transporte real al backend.

| Código | Significado |
| --- | --- |
| `CONFIGURATION` | URL, contexto, timeout o límite no válidos |
| `HTTP_ERROR` | Estado HTTP no exitoso; sólo conserva el código numérico en `httpStatus` |
| `NETWORK_ERROR` | Fallo de conexión, TLS, redirección rechazada o lectura interrumpida |
| `TIMEOUT` | Venció el plazo de consulta |
| `RESPONSE_TOO_LARGE` | Se excedió el límite de bytes |
| `INVALID_XML` | XML o codificación no válidos, DTD o entrada fuera de límites estructurales |
| `INVALID_RESPONSE` | XML incompatible con el contrato o respuesta incompleta |

Estos códigos no diagnostican por sí solos que un servidor esté caído: HTTP 401 significa fallo de autenticación y un error XML significa formato incompatible. La futura capa de estado debe preservar esa distinción.

## Validaciones pendientes contra la API existente

Antes de habilitar consultas reales se necesitan documentación o muestras autorizadas y anonimizadas para confirmar:

1. Versión y producto Digifort, endpoints, método HTTP, parámetros, paginación y límites de consulta.
2. Autenticación, permisos de sólo lectura, HTTPS, certificados y tratamiento de errores, incluidos errores de negocio dentro de HTTP 200.
3. Raíz XML, namespaces, atributos frente a elementos, codificación, cardinalidad y representación explícita de una lista vacía.
4. Ubicación, estabilidad y alcance del identificador; forma del nombre y la dirección de cámara.
5. Representación de Active y Working (`true/false`, `0/1` u otra), significado de cada estado y campos omitidos o nulos. No asumir equivalencias.
6. Si inventario y estado vienen en endpoints separados, cómo unirlos por ID y detectar resultados parciales.
7. Procedencia de servidor y nodo, sin inferir relaciones por nombre ni dirección.

Las muestras originales con información municipal deben permanecer fuera del repositorio. Se escribirá un adaptador específico y sus pruebas con muestras anonimizadas una vez confirmado el contrato.

## Pruebas

En `apps/api`: `npm ci`, `npm run build` y `npm test`. Las pruebas cubren fixtures válidas, vacías, incompletas y mal formadas, normalización, identidad, flags independientes, límites, entidades, HTTP, errores de red, timeout de headers/cuerpo y cancelación. Ninguna prueba del conector usa servidores reales ni PostgreSQL.
