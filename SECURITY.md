# Política de Seguridad / Security Policy

La seguridad, la integridad de los datos y el aislamiento estricto por cliente y usuario son los pilares fundamentales de **Odoo AI Client Agent**.

---

## 🛡️ Versiones Soportadas

| Versión | Soportada |
| :--- | :--- |
| `0.1.x` (Rama `main`) | ✅ Sí |

---

## 🔒 Arquitectura de Seguridad Incorporada

- **Cifrado en Reposo**: Las claves API de Odoo y tokens de canal se cifran usando **AES-256-GCM** con clave maestra de 32 bytes y datos adicionales autenticados (AAD).
- **Zero Raw Secrets**: La API de control (`control-api`) nunca devuelve claves sin cifrar ni contraseñas en sus respuestas JSON ni en logs.
- **Consultas ERP Cerradas**: Todas las lecturas del LLM pasan obligatoriamente por el validador semántico `ReadPlanV1` contra un catálogo estricto de campos permitidos. El modelo de lenguaje nunca ejecuta código Python arbitrario ni métodos `eval` en Odoo.
- **Gobernanza de Acciones**: Acciones críticas de escritura requieren confirmación interactiva expresa con código de un solo uso y expiración temporal (15 minutos).

---

## 🚨 Reporte Responsable de Vulnerabilidades

Si descubres una vulnerabilidad potencial de seguridad en este proyecto:

1. **NO abras un issue público en GitHub**.
2. Envía un reporte detallado de divulgación responsable vía correo electrónico a:
   **`seguridad@xeta.com.co`** o al mantenedor en **`jjaraujoa@gmail.com`**.
3. Incluye:
   - Descripción de la vulnerabilidad y vector de ataque.
   - Pasos para reproducirla (PoC o transcripción de solicitud HTTP).
   - Impacto estimado sobre la confidencialidad, integridad o disponibilidad.
4. Responderemos dentro de un plazo de 48 horas laborables para confirmar la recepción y coordinar una solución antes de cualquier divulgación pública.
