# Integración apicamstat — punto de continuación

## Implementado

- Servicio canónico en `services/apicamstat`, derivado del index.js existente. Mantiene
  CameraId, CameraType, campos y rutas `/cameras`, `/cameras/up`, `/cameras/down`,
  `/cameras/active`, `/cameras/inactive`, `/cameras/working`, `/cameras/nodos` y `/cameras/:id`.
- Servidores habilitados leídos de `digifort_servers` en PostgreSQL; sin lista hardcodeada.
- Login contra `app_users`, hashes scrypt con salt, JWT HS256 con audiencia/issuer,
  verificación de usuario habilitado/revisión y roles admin/viewer. Sin cuentas de
  contraseña conocida. Los tokens de la versión anterior deben renovarse.
- Fastify como intermediario: cookie HttpOnly/SameSite Strict, servicio JWT interno
  separado y autorización por rol actual de PostgreSQL. El navegador no llama apicamstat.
- CRUD de servidores: alta, listado, edición, habilitación/deshabilitación, baja lógica,
  revisión optimista y auditoría atómica. Sólo administradores. No hay CRUD de cámaras.
- Migración nueva `005_apicamstat_management`; 001–004 conservadas intactas.
- Secretos por archivos privados montados, perfiles por credential_ref, catálogo de
  nodos externo e imágenes sin .env, archivos históricos ni credenciales.
- Allowlist de destinos, DNS fijado a direcciones verificadas, redirects/proxy desactivados,
  timeout y respuestas acotadas. No se registran URLs autenticadas ni errores privados.

Cambio de seguridad informado: `/cameras/down` excluye estados ausentes/no válidos;
`/cameras/up` también exige flags válidas. El formato total/data se conserva y se agregan
metadatos de comunicación/procedencia. El backend no reinterpreta Description ni cambia
CameraId: el identificador legado contiene sólo la parte numérica y puede colisionar entre
servidores/tipos. Su mejora queda pendiente de la decisión del usuario. La clave técnica
de sesión sigue usando servidor + Name, sin fusiones.

## Entorno local de revisión

Se inició un proyecto Docker nuevo mediante `compose.integration.yaml`, independiente
del principal, con PostgreSQL 17 en tmpfs y roles de ejecución separados. Sólo web
publica un puerto, en 127.0.0.1. No se alteraron bases persistentes ni se eliminaron
contenedores/redes/volúmenes anteriores. No hay sincronización automática.

URL local: **http://127.0.0.1:8085**.
Acceso inicial generado aleatoriamente en `.local/integration/access.json` (ignorado,
permisos 0600). No subir ni compartir ese archivo. Configuración/proyecto/perfiles/
catálogo de nodos se guardan únicamente en `.local/integration/` y no están en GitHub.

```bash
bash ops/integration.sh status
bash ops/integration.sh start
```

El helper requiere la configuración local ya preparada; no aplica migraciones ni elimina
recursos. En otra máquina se deben provisionar secretos nuevos, dos roles no privilegiados,
una cuenta inicial segura y un proyecto aislado. `prepare-isolated` sólo sirve para una
base NUEVA VACÍA denominada `digifort_integration_isolated`; nunca usarlo en producción.
La base en tmpfs y los resultados de cámaras en RAM se pierden al reiniciar sus procesos.

El proyecto externo `/Users/miguelmartin/public_html/apicamstat` recibió un index.js
delegador a la implementación canónica, Dockerfile, documentación y dependencias
compatibles actualizadas. Se conservó un respaldo privado en `.local/`; esos cambios
externos no pertenecen al repositorio Git. La plantilla del delegador queda en
services/apicamstat/templates/legacy-index.js. Las implementaciones funcionales sí quedan
versionadas en services/apicamstat. No se reiniciaron procesos originales existentes.

## Validación realizada

- Regresión API: 215 pruebas aprobadas antes del último caso de timestamps futuros.
- Seis pruebas focalizadas de integración aprobadas: hashes, roles/CSRF, cookie HttpOnly, CRUD/auditoría,
  conflictos, rollback/reaplicación y conservación de CameraId. Caso adicional: una
  observación futura de apicamstat no puede clasificar una cámara como caída.
- Tres pruebas de apicamstat aprobadas: compatibilidad de mapeo, lista PostgreSQL,
  errores saneados, login/JWT y exclusión de estados desconocidos de /cameras/down.
- Compilaciones API y web correctas.
- Chrome escritorio/móvil: login, alta, edición, habilitación, deshabilitación, baja
  lógica, formulario responsive, logout y actualización por backend. Se consultó sólo
  el servidor previamente autorizado: 118 cámaras reales; en esa lectura, 113 operativas
  y 5 caídas. No se guardaron respuestas completas ni cámaras en PostgreSQL.
- npm audit: sin vulnerabilidades reportadas en el servicio integrado ni en las
  dependencias actualizadas del proyecto original. No equivale a auditoría exhaustiva.

## Pendientes prioritarios al retomar

1. Revisar el permiso de readiness: el manager consulta schema_migrations pero el
   bootstrap/grants todavía no le otorgan SELECT sobre esa tabla. Agregar ese permiso
   limitado al bootstrap temporal y al SQL de grants, probar /api/v1/ready y añadir
   healthcheck explícito de api antes de depender de él en Compose.
2. Reconstruir únicamente los servicios del proyecto temporal después de los últimos
   ajustes de código/CLI. No volver a ejecutar prepare-isolated sobre la base ya usada.
3. Comprobar privilegios efectivos de manager/reader e inventario final de recursos
   preexistentes; registrar evidencia sin secretos. Ampliar pruebas sólo si aparece fallo.
4. El recorrido de administración crea una configuración retirada y una habilitada del
   servidor autorizado en la base temporal. No importar la antigua lista completa de
   servidores sin revisar destinos, perfiles y allowlist con el operador.
5. Mantener el mapeo CameraId original hasta que el usuario explique la mejora pendiente.

## Antes de cualquier base persistente

**No se aplicó 005 a bases persistentes. Requiere confirmación explícita del usuario y
selección de la base destino.** Preparados: SQL 005, `ops/sql/apicamstat-grants.sql` y
CLI `bootstrap:admin` (stdin, sin contraseña en argumentos; mantenimiento con owner
no-login seleccionado mediante login no privilegiado). Revisar el permiso de readiness
indicado arriba antes de ejecutar los grants. Ningún arranque normal aplica migraciones.

No usar el Compose principal ni su volumen para repetir las pruebas temporales. No
eliminar recursos anteriores. No publicar la aplicación fuera de localhost sin HTTPS,
revisión de autorización y revisión de despliegue.
