import { AppError } from "./errors.js";

export function toUnicodeEscapes(str) {
  if (typeof str !== "string") return str;
  return str.replace(/[\u007f-\uffff]/g, (c) => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));
}

export function normalizeDomainTo2d(domain) {
  if (!Array.isArray(domain) || domain.length === 0) return [];
  // Si es un arreglo plano tipo ["campo", "=", valor]
  if (domain.length === 3 && typeof domain[0] === "string" && typeof domain[1] === "string") {
    return [domain];
  }
  // Normalizar tuplas internas
  return domain.map((item) => {
    if (Array.isArray(item) && item.length === 3 && typeof item[0] === "string") {
      return item;
    }
    if (typeof item === "string" && ["&", "|", "!"].includes(item)) {
      return item;
    }
    return item;
  });
}

export function sanitizeOdooViewLink(linkUrl, { autoFix = true } = {}) {
  if (typeof linkUrl !== "string" || !linkUrl.startsWith("odoo://view/")) {
    return { valid: true, url: linkUrl };
  }

  const rawJson = linkUrl.slice("odoo://view/".length);
  let payload;
  try {
    payload = JSON.parse(decodeURIComponent(rawJson));
  } catch {
    try {
      payload = JSON.parse(rawJson);
    } catch {
      return { valid: false, error: "El enlace odoo://view contiene JSON inválido." };
    }
  }

  if (typeof payload !== "object" || payload === null) {
    return { valid: false, error: "El contenido de odoo://view debe ser un objeto." };
  }

  let fixed = false;
  // Regla estricta de Odoo 18/19/20: Todo enlace DEBE contener action anidado con xmlId
  if (!payload.action || typeof payload.action !== "object") {
    if (!autoFix) {
      return {
        valid: false,
        error: "Falta el objeto anidado 'action' en odoo://view. Colocar modelName o domain en la raíz provoca TypeError en Odoo.",
      };
    }
    payload.action = {
      xmlId: payload.xmlId || false,
      modelName: payload.modelName || payload.res_model || "res.partner",
      views: payload.views || [[false, "list"], [false, "form"]],
      domain: normalizeDomainTo2d(payload.domain || []),
      context: payload.context || {},
    };
    delete payload.modelName;
    delete payload.res_model;
    delete payload.domain;
    delete payload.xmlId;
    fixed = true;
  } else {
    // Si ya tiene action, verificar domain 2D
    if (payload.action.domain) {
      const normalized = normalizeDomainTo2d(payload.action.domain);
      if (JSON.stringify(normalized) !== JSON.stringify(payload.action.domain)) {
        payload.action.domain = normalized;
        fixed = true;
      }
    }
    if (!payload.action.views) {
      payload.action.views = [[false, "list"], [false, "form"]];
      fixed = true;
    }
  }

  if (!payload.name) payload.name = "Vista Odoo";
  if (!payload.viewType) payload.viewType = "list";

  const cleanUrl = `odoo://view/${encodeURIComponent(JSON.stringify(payload))}`;
  return { valid: true, url: cleanUrl, fixed, payload };
}

export function validateSpreadsheetDefinition(definition, { autoFix = true } = {}) {
  const errors = [];
  const warnings = [];

  let def = definition;
  if (typeof def === "string") {
    try {
      def = JSON.parse(def);
    } catch {
      return { valid: false, errors: ["La definición no es un JSON válido."], warnings, definition: null };
    }
  }

  if (!def || typeof def !== "object") {
    return { valid: false, errors: ["La definición del tablero debe ser un objeto."], warnings, definition: null };
  }

  // Clonar para auto-corrección segura
  const fixedDef = autoFix ? structuredClone(def) : def;

  // 1. Validar hojas (sheets)
  const sheets = Array.isArray(fixedDef.sheets) ? fixedDef.sheets : [];
  if (sheets.length === 0) {
    warnings.push("El tablero no contiene hojas de cálculo ('sheets').");
  }

  for (const sheet of sheets) {
    if (!sheet.name) sheet.name = "Hoja 1";

    // Validar celdas con enlaces
    const cells = sheet.cells && typeof sheet.cells === "object" ? sheet.cells : {};
    for (const [cellKey, cell] of Object.entries(cells)) {
      if (!cell || typeof cell !== "object") continue;

      let viewUrl = null;
      let isMarkdownContent = false;
      if (cell.link && typeof cell.link.url === "string" && cell.link.url.startsWith("odoo://view/")) {
        viewUrl = cell.link.url;
      } else if (typeof cell.content === "string") {
        const match = cell.content.match(/\(<?(odoo:\/\/view\/[^)>]+)>?\)/);
        if (match) {
          viewUrl = match[1];
          isMarkdownContent = true;
        }
      }

      if (viewUrl) {
        const linkCheck = sanitizeOdooViewLink(viewUrl, { autoFix });
        if (!linkCheck.valid) {
          errors.push(`Celda ${cellKey} en hoja '${sheet.name}': ${linkCheck.error}`);
        } else if (linkCheck.fixed) {
          if (!autoFix) {
            errors.push(`Celda ${cellKey} en hoja '${sheet.name}': enlace odoo://view sin objeto anidado 'action'`);
          } else {
            if (isMarkdownContent && typeof cell.content === "string") {
              cell.content = cell.content.replace(viewUrl, linkCheck.url);
            } else if (cell.link?.url) {
              cell.link.url = linkCheck.url;
            }
            warnings.push(`Celda ${cellKey}: enlace odoo://view corregido automáticamente (envoltura 'action' y dominio 2D).`);
          }
        }
      }

      // Limpiar texto para prevenir caracteres corruptos en etiquetas
      if (typeof cell.content === "string") {
        // Eliminar nombres técnicos entre paréntesis tipo "Ventas (sale_order)"
        if (autoFix && /\([a-z0-9_]+\)$/i.test(cell.content)) {
          cell.content = cell.content.replace(/\s*\([a-z0-9_]+\)$/i, "").trim();
        }
      }
    }

    // Validar figuras (gráficos y tablas)
    const figures = Array.isArray(sheet.figures) ? sheet.figures : [];
    for (const figure of figures) {
      if (!figure || typeof figure !== "object") continue;
      const data = figure.data && typeof figure.data === "object" ? figure.data : figure;

      // Verificar dominios en searchParams
      if (data.searchParams && data.searchParams.domain) {
        const normDomain = normalizeDomainTo2d(data.searchParams.domain);
        if (JSON.stringify(normDomain) !== JSON.stringify(data.searchParams.domain)) {
          if (autoFix) {
            data.searchParams.domain = normDomain;
            warnings.push(`Figura '${figure.id || "chart"}': dominio normalizado a arreglo 2D AST.`);
          } else {
            errors.push(`Figura '${figure.id || "chart"}': el dominio no es un arreglo 2D AST.`);
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    definition: fixedDef,
  };
}

export async function inspectDashboard(odoo, { dashboardId = null, name = null } = {}) {
  let domain = [];
  if (dashboardId) {
    domain = [["id", "=", Number(dashboardId)]];
  } else if (name) {
    domain = [["name", "ilike", String(name)]];
  }

  const rows = await odoo.searchRead(
    "spreadsheet.dashboard",
    domain,
    ["id", "name", "data", "group_ids", "write_date"],
    { limit: 5 },
  );

  if (!rows || rows.length === 0) {
    throw new AppError(404, "dashboard_not_found", "No se encontró ningún tablero de hoja de cálculo con los criterios indicados.");
  }

  const dashboard = rows[0];
  let parsedData = null;
  if (dashboard.data) {
    try {
      parsedData = typeof dashboard.data === "string" ? JSON.parse(dashboard.data) : dashboard.data;
    } catch {
      parsedData = null;
    }
  }

  const sheetsSummary = [];
  const linksFound = [];
  if (parsedData && Array.isArray(parsedData.sheets)) {
    for (const sheet of parsedData.sheets) {
      const cellCount = sheet.cells ? Object.keys(sheet.cells).length : 0;
      const figuresCount = Array.isArray(sheet.figures) ? sheet.figures.length : 0;
      sheetsSummary.push({
        id: sheet.id,
        name: sheet.name,
        cell_count: cellCount,
        figures_count: figuresCount,
      });

      if (sheet.cells) {
        for (const [key, cell] of Object.entries(sheet.cells)) {
          if (cell?.link?.url) {
            linksFound.push({ sheet: sheet.name, cell: key, url: cell.link.url });
          }
        }
      }
    }
  }

  return {
    id: dashboard.id,
    name: dashboard.name,
    write_date: dashboard.write_date,
    sheets_count: sheetsSummary.length,
    sheets: sheetsSummary,
    links: linksFound,
    has_valid_json: parsedData !== null,
  };
}

export async function createOrUpdateDashboard(odoo, {
  name,
  definition,
  groupId = null,
  dashboardId = null,
  autoFix = true,
}) {
  if (!name || String(name).trim().length === 0) {
    throw new AppError(400, "invalid_name", "El nombre del tablero es requerido.");
  }

  const validation = validateSpreadsheetDefinition(definition, { autoFix });
  if (!validation.valid) {
    throw new AppError(400, "invalid_spreadsheet_definition", `Definición inválida: ${validation.errors.join("; ")}`);
  }

  const serializedData = JSON.stringify(validation.definition);
  const values = {
    name: String(name).trim(),
    data: serializedData,
    ...(groupId ? { group_ids: [[6, 0, [Number(groupId)]]] } : {}),
  };

  if (dashboardId && Number(dashboardId) > 0) {
    const id = Number(dashboardId);
    await odoo.write("spreadsheet.dashboard", id, values);
    return {
      success: true,
      mode: "update",
      dashboard_id: id,
      name: values.name,
      warnings: validation.warnings,
      summary: `Tablero #${id} ('${values.name}') actualizado exitosamente en Odoo.`,
    };
  }

  const created = await odoo.create("spreadsheet.dashboard", values);
  const newId = Array.isArray(created) ? (created[0]?.id || created[0]) : (created?.id || created);

  return {
    success: true,
    mode: "create",
    dashboard_id: Number(newId),
    name: values.name,
    warnings: validation.warnings,
    summary: `Tablero #${newId} ('${values.name}') creado exitosamente en Odoo con validación 2D AST.`,
  };
}
