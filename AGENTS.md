# Instrucciones de Trabajo para Agentes (Odoo-AI-Client-Agent)

## Idioma y Usuario

- Trabajar y documentar siempre en español.
- Explicar procedimientos de forma clara y accesible para el equipo técnico y funcional.
- No afirmar que una integración funciona sin haber ejecutado las pruebas correspondientes o documentar claramente la validación pendiente.

---

## Alcance y Restricciones Técnicas

- **Plataforma**: Agente conversacional para usuarios finales de Odoo 19 Enterprise / Community alojado en Odoo.sh, Online u On-Premise.
- **Canal**: Telegram, exclusivamente conversaciones privadas directas.
- **Orquestación**: n8n (workflows en `n8n/workflows/`) y API propia de control (`control-api/` en Node.js/Express).
- **Integración ERP**: Odoo 19 mediante JSON-2, sin requerir módulos personalizados en Odoo.
- **Identidad**: API key individual de Odoo por cada usuario autenticado, vinculada a su `telegram_user_id`.
- **Base de Datos Auxiliar**: PostgreSQL. Las migraciones en `db/migrations/` deben ser estrictamente incrementales y compatibles hacia atrás.

---

## Reglas Críticas de Seguridad y Operación

1. **Secretos y Credenciales**:
   - NUNCA imprimir, registrar en consola, comitear a Git ni incluir en documentación valores de `.env`, API keys de Odoo, tokens de Telegram, claves privadas RSA o claves maestras AES.
   - Las API keys de Odoo deben almacenarse cifradas con AES-256-GCM.
   - Conservar el aislamiento estricto por cliente, usuario y chat en todas las consultas y almacenamiento de memoria.

2. **Acciones Bloqueadas (Incluso en Staging/Pruebas)**:
   - Prohibido instalar o activar módulos de DIAN, sincronización bancaria, pasarelas de pago reales, envío masivo de correos, WhatsApp, SMS o conectores de transportistas.
   - El agente no puede publicar facturas en estado definitivo, registrar pagos reales, eliminar registros (`unlink`), crear proveedores automáticamente ni procesar nómina.
   - La creación de facturas de proveedor se limita a estado **borrador** tras confirmación interactiva expresa del usuario con límite de tiempo.

3. **Herramientas Cerradas**:
   - No implementar endpoints genéricos que permitan ejecutar modelos o métodos arbitrarios de Odoo elegidos libremente por el LLM.
   - Toda consulta debe pasar por el planificador semántico `ReadPlanV1` y ser validada contra el catálogo administrado.

4. **Entornos de Ejecución**:
   - Mantener la compatibilidad tanto para despliegue en **Docker Compose** como en **WSL 2 nativo sin Docker**.
