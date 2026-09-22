# Guía de Contribución / Contributing Guidelines

¡Gracias por tu interés en contribuir a **Odoo AI Client Agent**! Este proyecto busca empoderar a la comunidad y a empresas con un copiloto de Inteligencia Artificial para Odoo 19 Enterprise / Community sin requerir módulos personalizados en el ERP.

---

## 🧭 Principios Fundamentales

1. **Cero Módulos Personalizados en Odoo**:
   - Todas las integraciones con Odoo 19 se realizan mediante la API JSON-2 nativa. No desarrollamos módulos `.py` para Odoo dentro de este repositorio.
2. **Seguridad y Confidencialidad Rigurosa**:
   - **NUNCA** subas secretos, API keys reales, tokens de Telegram o credenciales en PRs o issues.
   - Las API keys se almacenan cifradas con AES-256-GCM.
   - Las acciones operativas de escritura deben respetar la gobernanza de 3 niveles (Autónoma, Notificada, Aprobación interactiva).
3. **Calidad de Código y Pruebas**:
   - Todo cambio en la lógica de negocio o en la API debe incluir sus pruebas correspondientes (`node --test`).
   - La suite de pruebas debe pasar al 100% antes de abrir un PR.

---

## 🛠️ Entorno de Desarrollo Local

### Requisitos
- **Node.js**: v20 o v22 LTS (recomendado v22)
- **pnpm** o **npm**
- **Docker & Docker Compose** (opcional si usas entorno nativo WSL2 / Linux / macOS)

### Instalación Rápida
```bash
# 1. Clonar el repositorio
git clone https://github.com/jjaraujoa/Odoo-AI-Client-Agent.git
cd Odoo-AI-Client-Agent

# 2. Instalar dependencias de control-api
cd control-api
npm install

# 3. Ejecutar suite de pruebas
npm test
```

---

## 🌿 Flujo de Trabajo para Pull Requests

1. **Crear una rama**:
   - Para nuevas funciones: `feature/nombre-descriptivo`
   - Para corrección de errores: `fix/nombre-del-bug`
   - Para documentación: `docs/tema-actualizado`
2. **Mensajes de Commit (Conventional Commits)**:
   - `feat(mcp): agregar nueva herramienta para inventario`
   - `fix(governance): corregir validación de timeout en confirmación`
   - `docs(readme): actualizar diagrama de arquitectura`
   - `test(workflow): añadir prueba de condición límite`
3. **Verificar antes de subir**:
   ```bash
   npm run check
   ```
4. **Abrir Pull Request**:
   - Describe claramente el problema que resuelve y las pruebas ejecutadas.
   - Nuestro pipeline de CI validará automáticamente las pruebas en Node 20 y Node 22.

---

## 🧩 Cómo Contribuir Nuevos Flujos DSL YAML

Si deseas proponer un flujo automatizado de negocio para la comunidad:
1. Crea tu archivo YAML en `clients/demo/workflows/tu-flujo.yaml`.
2. Valida la estructura mediante el CLI:
   ```bash
   node control-api/bin/odoo-agent-cli.js flow validate --path clients/demo/workflows/tu-flujo.yaml
   ```
3. Añade la prueba unitaria correspondiente en `control-api/test/workflow-engine-and-cli.test.js`.

---

## 💬 Código de Conducta

Nos comprometemos a mantener una comunidad abierta, inclusiva, respetuosa y profesional. Los aportes constructivos son siempre bienvenidos.
