# Hoja de Ruta (Roadmap): Agente Odoo para Cliente Final

Registro histórico de versiones y evolución de capacidades del agente conversacional para empleados en Telegram.

---

## Hitos Completados

### Versión 0.1.0 – Piloto Base en Telegram
- Canal privado de Telegram conectado con n8n 2.30.5.
- API propia de control (`control-api`) en Node.js/Express.
- Identidad por `telegram_user_id` y cifrado de API keys de Odoo con AES-256-GCM.
- Rechazo automático de grupos, supergrupos y canales de Telegram.
- Consultas básicas de ventas, compras, productos, inventario, facturas y clientes.
- Planificador semántico `ReadPlanV1` con compilador determinista hacia JSON-2 de Odoo 19.

### Versión 0.2.0 – Flujo Documental y Seguridad Avanzada
- Recepción de facturas de proveedores en formatos PDF, JPG y PNG.
- Integración de escaneo antivirus en memoria con ClamAV previo al procesamiento de visión.
- Extracción de datos de factura con LLM multimodal y validación cruzada de proveedores, impuestos y totales.
- Flujo interactivo de confirmación con vencimiento de 5 minutos y creación en borrador con adjunto en Odoo.
- Aislamiento de memoria de sesión por tupla `(cliente, chat, usuario)`.
- Soporte dual de despliegue: Docker Compose y WSL 2 nativo sin Docker.

### Versión 0.3.0 – Sistema de Onboarding Cifrado
- Incorporación de clientes mediante paquetes `.odooai` cifrados con RSA-3072 y AES-256-GCM.
- Importador automatizado `Importar-PaqueteCliente.ps1`.
- Configuración dinámica de límites de peticiones y tokens por cliente y usuario.

---

## Próximos Pasos Planificados

1. **Ampliación de Casos de Uso Operativos**:
   - Consulta de órdenes de fabricación (MRP) y estado de producción.
   - Consulta de tickets de soporte técnico o incidencias de clientes.
2. **Mejoras en el Planificador Semántico**:
   - Soporte para filtros temporales relativos más sofisticados ("hace dos trimestres", "semana actual vs semana anterior").
   - Agregaciones estadísticas avanzadas calculadas en código para reducir consumo de tokens.
3. **Observabilidad y Monitoreo**:
   - Exportación de métricas de uso y latencia a Prometheus / Grafana.
   - Alertas automáticas ante anomalías en consumo de tokens o llamadas fallidas a Odoo.
