# Guía de Publicación en GitHub: Odoo-AI-Client-Agent

Esta guía describe los pasos exactos para inicializar el repositorio local y publicarlo en tu cuenta de GitHub.

---

## Paso 1: Crear el Repositorio en GitHub

1. Entra a tu cuenta en [GitHub](https://github.com/new).
2. Asigna un nombre al repositorio, por ejemplo: `Odoo-AI-Client-Agent` (o el nombre de tu preferencia).
3. Selecciona la visibilidad deseada (**Privado** o **Público**; se recomienda **Privado** si manejarás configuraciones empresariales).
4. **NO** marques las opciones de "Add a README file", ".gitignore" o "license", ya que este proyecto ya cuenta con todos estos archivos listos y optimizados.
5. Haz clic en **Create repository**.
6. Copia la URL del repositorio remoto (ejemplo: `https://github.com/tu-usuario/Odoo-AI-Client-Agent.git` o `git@github.com:tu-usuario/Odoo-AI-Client-Agent.git`).

---

## Paso 2: Inicializar y Subir desde tu Equipo

Abre una terminal de PowerShell o Bash en la carpeta del proyecto:
`C:\Users\Jorge Araujo\Documents\Codex\Odoo-AI-Client-Agent`

Ejecuta los siguientes comandos:

```powershell
# 1. Inicializar el repositorio Git local si no está inicializado
git init -b main

# 2. Verificar el estado de los archivos (comprueba que .env y node_modules no aparezcan)
git status

# 3. Agregar todos los archivos preparados
git add .

# 4. Crear el commit inicial
git commit -m "feat: inicialización del agente Odoo para cliente final (piloto Telegram)"

# 5. Vincular el repositorio remoto de GitHub (reemplaza con tu URL real)
git remote add origin https://github.com/tu-usuario/Odoo-AI-Client-Agent.git

# 6. Subir a la rama principal
git push -u origin main
```

---

## Verificación de Seguridad Pre-Push

Antes de ejecutar `git push`, confirma que:
- El archivo `.env` **no** está en la lista de archivos rastreados (`git status`).
- No existen certificados privados (`.pem`, `.pfx`) incluidos en el commit.
- El archivo `.gitignore` está activo y respetado.
