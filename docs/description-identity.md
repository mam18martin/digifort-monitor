# Description como fuente oficial de identidad municipal

Decisión aprobada por el usuario tras la comparación visual de 118 cámaras: Description
reconocía 118 candidatos y Name 22, todos coincidentes. Ese resultado motivó el cambio
normativo; no se repitieron consultas reales durante esta implementación.
Este documento sustituye las reglas anteriores que tomaban Name como fuente municipal.

## Contrato vigente

- `parseMunicipalDescription(value, knownTypes?)` es el parser oficial. Devuelve
  `source: 'Description'`, `originalDescription` íntegra, delimitador, clasificación
  y componentes. No acepta Name como parámetro alternativo ni lo usa como fallback.
- Se reconoce un prefijo en posición cero de dígitos ASCII y letra mayúscula de tipo.
  Acepta `)` opcional y texto posterior; sin delimitador, el texto requiere un espacio.
  El código excluye `)`, conserva ceros iniciales y no se busca dentro del texto.
- Se mantienen valid, absent, invalid y unknown_type. D/F/P es el catálogo inicial;
  el escritor usa el catálogo PostgreSQL explícito. unknown_type conserva el candidato.
- Name y Description originales se conservan sin recorte o normalización. Name exacto
  sigue siendo la clave técnica `(server_id, Name)` para asociación y vínculos.
- Un candidato no asigna códigos confirmados, no modifica UUID ni fusiona cámaras.
  Un Description diferente puede generar conflicto, nunca reasignación automática.
- `parseMunicipalCameraName` permanece sólo para diagnóstico comparativo. Los campos
  legados cameraId/cameraType siguen separados y no constituyen el contrato oficial.

## Conector, coordinador y escritor

El conector genera municipalIdentity desde Description. El coordinador comprueba source
Description y coherencia de originalDescription con el DTO; no modifica Name. El
escritor recalcula los candidatos desde el original con el catálogo vigente, detecta
conflictos y conserva la política de provisionales y códigos confirmados inmutables.
Requiere migración 004 antes de aplicar datos.

Description exacta pasa a conservarse por defecto, bajo los controles existentes:
límite de tamaño, rechazo de secretos evidentes/URLs y fallo atómico saneado. No se
recorta ni sustituye por Name. selectInventoryText puede seleccionar modelo y dirección;
si entrega description debe coincidir con el original. No se almacenan respuestas
completas, Memo, perfiles o grupos ni secretos en diagnósticos.

Cada observación nueva usa `code_parser_version='description-v1'`. Las versiones
anteriores no se reescriben ni se reinterpretan. Un siguiente snapshot puede crear
una versión de inventario nueva, conservando cámara, vínculo e historial.

## Migración 004_description_identity

001, 002 y 003 permanecen intactas, con sus checksums originales.
004 incorpora:

1. `municipal_description_code(text)`: función SQL consistente con los límites del
   parser TypeScript; no utiliza Name. Mantiene el helper histórico identity_name_code.
2. `inventory_description_candidate`: valida que los componentes y clasificación de
   nuevas versiones description-v1 correspondan a Description original y al catálogo.
3. `identity_proposals.code_source`: las propuestas anteriores reciben procedencia
   histórica Name; las nuevas sólo admiten Description. Los códigos, UUIDs, decisiones
   y referencias de evidencia anteriores permanecen intactos.
4. Validación de propuestas/evidencias contra la versión Description referenciada.
   Los candidatos legados no son fallback. La detección de duplicados compara Description
   entre nombres técnicos distintos y contra códigos confirmados, incluidos propietarios
   históricos; nunca fusiona entidades.
5. Índice de candidato Description actual. La deduplicación incluye fuente Description
   para no mezclar nuevas observaciones con expedientes históricos derivados de Name.

El down directo de 004 se bloquea si hay observaciones/propuestas Description: eliminar
su procedencia dejando el resto de tablas produciría una interpretación incorrecta.
El down completo del migrador mantiene su semántica existente de retirar todas las
migraciones en una transacción; sólo para ese caso señala full_schema_rollback.
No habilita una degradación parcial ni modifica la autorización requerida por el CLI.

No se aplicó ninguna migración a bases persistentes. Antes de habilitar ingestión en
ellas debe ejecutarse un mantenimiento autorizado que aplique 004. No hay scheduler
ni activación automática; una base antigua no es compatible con el nuevo escritor.

## Inspección visual

**http://127.0.0.1:8083/#/inspection**

Recargar la pantalla muestra Description como fuente oficial y Name como comparación.
Se mantienen originales, dos candidatos/resultados, diferencias y filtros. La lectura
existente se reutiliza hasta su vencimiento; si venció, el botón permite una renovación
manual. La actualización de código no contacta Digifort, no consulta GetStatus y no
introduce datos reales en PostgreSQL.

## Validación

Node 22.23.4: 202 pruebas API/SQL embebidas aprobadas, incluidas pruebas nuevas de
paridad SQL/TypeScript, ausencia de fallback, upgrade de propuestas Name existentes,
inmutabilidad de UUID/código confirmado, duplicados Description entre Name distintos,
constraints, DDL fallido, reaplicación, idempotencia y rollback completo/parcial protegido.

PostgreSQL 17.11 nativo ARM64 temporal: 49 pruebas del conjunto nativo existente y 8 de
la fuente nueva aprobadas. Abarcan roles, integridad, concurrencia, fencing, migraciones
y auditoría. Sólo datos sintéticos. Dos contenedores nuevos con red none/namespace
compartido, PostgreSQL en tmpfs; sin redes ni volúmenes nuevos. Ambos retirados. El
inventario Docker previo permaneció intacto. No se usó el PostgreSQL de la demo ni el
principal, ni credenciales de oficina para las pruebas.

Pruebas de comparación web y compilaciones API/web deben mantenerse junto al cambio.
La prueba visual se ejecuta con INSPECTION_NO_QUERY=1 para no contactar Digifort.

```bash
cd apps/api
node --import tsx --test tests/description-identity.test.ts
cd ../..
npm --prefix apps/web run test:comparison
DEMO_URL=http://127.0.0.1:8083 INSPECTION_NO_QUERY=1 npm --prefix apps/web run test:inspection
```

Para PostgreSQL nativo, el entorno debe ser nuevo, vacío y desechable. El ensayo
`tests/description-identity-native.ts` requiere RUN_NATIVE_DB_TESTS=1,
TEST_POSTGRES_HOST=127.0.0.1, TEST_POSTGRES_DATABASE=digifort_test_isolated y puerto
explícito TEST_POSTGRES_PORT. No usa PG* ni DATABASE_URL como fallback.

Archivos afectados: parser/exportaciones/DTO/conector, coordinador/escritor/opciones,
detector y lectura de incidencias, migrador y nuevos SQL 004, fixtures demo, pruebas
sintéticas/nativas y de comparación, pantallas de inspección/identidades y documentación.
No hay commits ni pushes.
