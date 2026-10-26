# Fase 3B.5 — consulta web de identidades

> Regla vigente: [Description como fuente oficial](description-identity.md). Desde esta corrección, Name es sólo la clave técnica exacta; no hay fallback automático. Las referencias anteriores a Name como fuente son históricas.

La pantalla **Identidades** integra PostgreSQL, Fastify y React. Es exclusivamente
consultiva: no publica servicios de revisión, aprobación, rechazo, asignación o fusión.
No requiere migración nueva; 001, 002 y 003 permanecen intactas.

## Datos y detección

- `identity_proposals` conserva duplicados y discrepancias detectadas por el escritor
  existente; `identity_proposal_evidence` referencia versiones, ejecuciones e incidencias
  saneadas de `sync_issues`. Las propuestas conservan códigos capturados al detectar,
  separados del código confirmado actual.
- Las cámaras con código confirmado NULL se proyectan como `unconfirmed_code`, incluso
  sin vínculo técnico. Estado `pending` **derivado**, no una decisión del operador.
  Su evidencia es el inventario actual y, cuando existen, las incidencias de
  sincronización asociadas. No se insertan filas durante una consulta GET.
- Los candidatos nuevos se extraen de Description original en versiones description-v1.
  Los históricos conservan code_source Name; no se reinterpretan. Name se muestra
  exactamente como vínculo técnico y nunca se usa como fallback.
- Un posible cambio de Name o reemplazo requiere una hipótesis explícita registrada
  mediante los servicios internos existentes. La pantalla la presenta como hipótesis,
  sin deducir continuidad física, renombrado ni ubicación permanente. Esta etapa no
  habilita el alta de hipótesis desde el navegador.
- La auditoría existente se consulta con operador UUID, fecha, motivo, acción y revisión.
  No existen botones de decisión. Los estados aprobados/resueltos no se habilitan por
  agregarlos al filtro: el modelo actual sigue bloqueando esas operaciones.

No se modifica el código confirmado, UUID, vínculo ni historial al leer, filtrar o
abrir evidencia. Las propuestas históricas pueden continuar pendientes aunque el
inventario posterior cambie; la lectura no las cierra automáticamente.

## API

Sólo disponible cuando la API de monitoreo de demostración está habilitada:

- `GET /api/v1/monitor/identities?kind=&server=&state=&page=1&pageSize=20`
- `GET /api/v1/monitor/identities/:id`

Tipos: `unconfirmed_code`, `duplicate_code`, `confirmed_code_mismatch`,
`possible_rename`, `possible_replacement`.
Estados: `pending`, `approved`, `rejected`, `resolved`.
Servidor: UUID exacto; página 1–10000 y tamaño 1–100. Filtros parametrizados;
400 ante valores inválidos, 404 para incidencia inexistente, 503 saneado ante error.
Respuestas `Cache-Control: no-store`, `readOnly: true`; detalle `applicationBlocked: true`.
Los IDs de consulta son `p-<proposal UUID>` o `u-<camera UUID>`; el segundo es derivado,
no una nueva entidad persistida. Evidencia y auditoría se leen en una sola sentencia
para obtener una instantánea coherente. No se exponen endpoints, secretos ni respuestas
remotas. El rol demo_reader obtiene SELECT sobre las tablas necesarias en la carga de
una base **nueva y vacía**, sin modificar roles de bases existentes.

## Escenario y recorrido

En una demo nueva, abrir `http://127.0.0.1:8081/#/identities` después de iniciar según
[visual-demo.md](visual-demo.md). Una demo antigua ya iniciada no recibe fixtures nuevos
ni permisos adicionales automáticamente: no reconstruirla ni resetearla si debe
preservarse. Cambiar DEMO_PORT no crea otro proyecto Compose.

La muestra conserva 48 cámaras y agrega **9 incidencias**:

| Tipo | Cantidad | Ejemplo |
|---|---:|---|
| Sin código confirmado | 3 | DEMO-PROVISIONAL-8; Description contiene 9999F), sin atribuir identidad |
| Candidato duplicado | 2 | Name 1390D) observado en Centro y Oeste; una propuesta por cámara |
| Código observado diferente | 2 | Confirmado 1420D frente a Name 9090F); confirmado 1418P frente a 1390D) |
| Posible cambio de Name | 1 | Hipótesis sintética explícita entre dos vínculos, no continuidad confirmada |
| Posible reemplazo | 1 | Hipótesis sintética con códigos distintos, sin trasladar historial |

Todas están pendientes; no se inventan aprobaciones o rechazos para poblar filtros.
El fixture se carga de forma atómica y sólo en inventario vacío. Sus asignaciones
iniciales confirmadas son sintéticas, no son autorizaciones derivadas de observaciones.

1. Abrir **Identidades** desde la navegación lateral/inferior.
2. Filtrar **Candidato duplicado**: aparecen dos incidencias, una por cámara.
3. Abrir **Ver evidencia**: comparar Name exacto, candidato y confirmado capturado;
   revisar ejecución, inventario e incidencia. Seguir el enlace a la otra cámara.
4. Volver y elegir **Código observado diferente** para ver 1420D / 9090F.
5. Elegir **Sin código confirmado** para ver las tres provisionales.
6. Filtrar Nodo Oeste o estado Rechazado (vacío esperado). Restaurar los filtros.
7. Probar a 390 px: navegación inferior con cuatro accesos, filtros y tarjetas apilados.

La validación del 24/10/2026 dejó una **vista temporal separada** en
`http://127.0.0.1:8082/#/identities`: PostgreSQL 17.11 nativo en tmpfs, red `none`,
relay Node en su mismo namespace y puertos de proceso host exclusivamente 127.0.0.1.
No se invocó Compose sobre la demo previa en 8081 ni se crearon redes Docker.
Esta vista es temporal; la entrada reproducible de despliegue sigue siendo Compose
con los fixtures del repositorio, cuando esté autorizado crear su entorno de demo.

## Pruebas reproducibles

Pruebas API/SQL embebidas, sin Docker ni conexiones remotas:

```bash
cd apps/api
node --import tsx --test tests/identity-monitoring.test.ts tests/monitoring.test.ts
npm run build
cd ../web
npm run build
```

Navegador: Google Chrome en macOS, Node.js 22 o posterior y demo nueva accesible.
El script abre un perfil temporal, verifica que el puerto de debugging esté libre,
recorre escritorio/móvil, filtros, evidencia y detalle; cierra únicamente su Chrome.

```bash
DEMO_URL=http://127.0.0.1:8082 npm --prefix apps/web run test:browser
```

Para elegir Node 22 instalado fuera del PATH: `NODE_BINARY=/ruta/a/node`.
Las capturas quedan en el directorio temporal del sistema, no en el repositorio.

Validación local: **185 pruebas** con Node 22.23.4/PGlite aprobadas; compilaciones API/web;
recorrido Chrome 1512 px y 390 px sin errores ni desbordamiento. Además se verificaron
los 9 detalles mediante API real/PostgreSQL 17.11 y demo_reader: filtros/paginación,
evidencia, vínculos a cámaras, identidad estable, DDL y UPDATE bloqueados, y ausencia
de rutas de modificación. La integración nativa se ejecutó exclusivamente en la
instancia temporal, sin usar la base principal.

## Decisiones pendientes para corregir identidades

1. Autenticación y autorización: operadores, permisos y posible doble aprobación.
2. Operaciones autorizables y evidencia exigida: asignar código a provisional, corregir
   un confirmado, vincular Name y documentar reemplazo son acciones diferentes.
3. Política para duplicados legítimos, tipos desconocidos y candidatos divergentes.
4. Ciclo de revisión, motivos y condiciones de resolución; control de revisión optimista
   e idempotencia de cada futura orden de modificación.
5. Conservación explícita de UUID e historial; ninguna fusión o transferencia automática.
6. Confirmación externa de un renombrado o reemplazo; similitud, descripción y cercanía
   nunca bastan para afirmar identidad o continuidad física.

Hasta definir y aprobar esas políticas, cualquier aplicación de identidad permanece bloqueada.

## Archivos de esta entrega

- `apps/api/src/monitor/identities.ts` (nuevo): proyecciones SQL consultivas y evidencia.
- `apps/api/src/monitor/repository.ts`, `routes.ts`: integración y contratos GET.
- `apps/api/src/demo/fixtures.ts`, `seed-cli.ts`: casos sintéticos atómicos y permisos
  SELECT exclusivamente para la creación de una demo vacía.
- `apps/api/tests/identity-monitoring.test.ts` (nuevo): contrato, filtros, procedencia,
  códigos, ausencia de mutaciones, errores saneados y provisionales sin vínculo.
- `apps/api/tests/monitoring.test.ts`: búsqueda ajustada a dos Name 1390D) en servidores distintos.
- `apps/web/src/api.ts`, `main.tsx`, `style.css`: tipos, navegación, filtros, evidencia y responsive.
- `apps/web/package.json`: comando `test:browser`.
- `apps/web/tests/identities-browser.mjs`, `ops/test-identities-browser.py` (nuevos):
  recorrido reproducible mediante Chrome DevTools Protocol, sin dependencia adicional.
- `docs/identity-web-review.md` (nuevo), `docs/identity-review.md`, `docs/visual-demo.md`:
  semántica, recorrido, resultados y políticas pendientes.

Git conserva HEAD `27cfd2b` y los cambios locales anteriores. No se hicieron commits ni
pushes; no se modificaron migraciones. El helper de validación y su inventario Docker
quedaron fuera del repositorio, en `/private/tmp/digifort-identities-*`.

La vista temporal actual utiliza únicamente `digifort-identities-x13pe0ts-db` y
`digifort-identities-x13pe0ts-relay`. La comparación final verificó IDs y estado de
contenedores previos, mounts, redes y volúmenes sin cambios (se excluyen únicamente los
logs de healthchecks que avanzan naturalmente). Para cerrar **sólo esta vista temporal**:

```bash
python3 /private/tmp/digifort-identities-stop.py
```

El supervisor cierra Fastify/relay y retira sólo sus dos contenedores, comprobando sus
etiquetas. No usar `ops/demo.sh stop/reset` para cerrar esta vista: esos comandos
corresponden a la demo anterior, que se mantuvo intacta.
