# Auditoría semanal del Content Index

Compara cada semana los **reportes del Content Index** (GTM, Support y T&S) con lo que hay en las carpetas de Drive, y deja el resultado en la pestaña **`ka_audit`** del sheet del corpus, además de mandarlo por correo.

## Qué detecta

| Estado | Qué significa | Qué hacer |
|---|---|---|
| En Salesforce sin Doc | Está en un reporte, pero no tiene Doc en la carpeta de publicados | Abrir el KA y darle **+ New** |
| Archivado por error | Su Doc está en la carpeta de archivados, pero el KA sigue en el reporte | Regresar el Doc a publicados |
| Docs duplicados | Hay más de un Doc para el mismo KA | Borrar los sobrantes |
| Desactualizado | El KA tiene una versión más nueva en Salesforce que la del Doc (si la versión es la misma, sale OK) | **⟳ Refresh outdated** o **↑ Update** en el KA |
| Equipo distinto | El nombre del Doc dice un equipo y el reporte otro | Revisar con el equipo |
| Doc de más | Tiene Doc, pero el KA ya no está en ningún reporte | Revisar si hay que archivarlo |
| Doc sin datos del KA | El Doc no tiene guardado su número de KA ni su URL Name | Darle **↑ Update** a su KA |
| OK | Todo bien | Nada |

## Cómo se corre

1. El lunes te llega el correo **"Recordatorio: auditoría semanal de KAs"**.
2. Abre cualquier KA en Salesforce y dale clic a **📋 Audit**, abajo a la derecha. También está en el menú de Tampermonkey → **Run Content Index audit**.
3. Deja la pestaña abierta: pasa sola por los 3 reportes (1–2 minutos).
4. Al terminar ves el resumen, te llega el correo y queda actualizada la pestaña `ka_audit`. Cada corrida se agrega también a `ka_audit_log`.

No cambia nada ni en Salesforce ni en Drive: solo lee y escribe en el sheet.

## Piezas

- `apps-script/Code.gs`: el Google Script (v2.3.1). Acción `audit`, pestañas `ka_audit` y `ka_audit_log`, correo y recordatorio semanal (`setupAuditReminderTrigger`).
- `tampermonkey/kaRefresh-admin.user.js`: la copia de admin del script (v2.3.1) con los botones **📋 Audit**, **⟳ Refresh outdated** (solo lo que la última auditoría marcó como desactualizado) y **⟳ Refresh all** (todos, para cuando cambie el formato). Se actualiza sola desde GitHub.
- `tests/`: pruebas sin conexión (`node tests/apps-script.test.js`) y de punta a punta en Chromium (`node tests/audit-e2e.test.js`).

## Configuración (Script Properties del Google Script)

- `SHARED_SECRET` (obligatoria): la clave de sincronización. Ya no va escrita en el código.
- `AUDIT_EMAILS` (opcional): más correos para el resumen, separados por comas.

Los reportes están en `AUDIT_REPORTS`, tanto en `Code.gs` como en el script de admin. Si Nichole cambia o agrega un reporte, hay que actualizar los dos.
