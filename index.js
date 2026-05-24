import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import fetch from 'node-fetch';
import { createServer } from 'http';

const TRILIUM_URL = process.env.TRILIUM_URL || 'http://localhost:8080';
const TRILIUM_TOKEN = process.env.TRILIUM_TOKEN || '';
const PORT = process.env.PORT || 3000;

const authHeader = { 'Authorization': TRILIUM_TOKEN };

// ============================================================================
// HELPER: petición a la ETAPI de Trilium
// FIX del bug: detecta el Content-Type para no romperse con respuestas HTML
// ============================================================================
async function triliumRequest(method, path, body = null, opts = {}) {
  const url = `${TRILIUM_URL}/etapi${path}`;
  const isStringBody = typeof body === 'string';
  const headers = { ...authHeader };

  if (isStringBody) {
    // FIX: Trilium ETAPI tiene un bug con Content-Type: text/html en PUT /notes/{id}/content
    // que devuelve "Cannot set null content" y corrompe la nota a [object Object].
    // Usar text/plain — el body sigue siendo HTML crudo, Trilium guarda los bytes igual.
    // Referencia: https://github.com/io7/trilium-cli
    headers['Content-Type'] = 'text/plain';
  } else if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const options = { method, headers };
  if (body !== null && body !== undefined) {
    options.body = isStringBody ? body : JSON.stringify(body);
  }

  const res = await fetch(url, options);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Trilium API error ${res.status}: ${text}`);
  }

  if (res.status === 204) return null;
  if (opts.expectBinary) return Buffer.from(await res.arrayBuffer());

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  return res.text();
}

// ============================================================================
// HELPER: HTML básico a Markdown (para previews legibles de notas)
// ============================================================================
function htmlToMarkdown(html) {
  if (!html) return '';
  let md = String(html);
  md = md.replace(/<!--[\s\S]*?-->/g, '');
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1');
  md = md.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  md = md.replace(/<input[^>]*type="checkbox"[^>]*checked[^>]*\/?>/gi, '[x]');
  md = md.replace(/<input[^>]*type="checkbox"[^>]*\/?>/gi, '[ ]');
  md = md.replace(/<table[^>]*>|<\/table>/gi, '\n');
  md = md.replace(/<thead[^>]*>|<\/thead>|<tbody[^>]*>|<\/tbody>/gi, '');
  md = md.replace(/<tr[^>]*>/gi, '| ');
  md = md.replace(/<\/tr>/gi, ' |\n');
  md = md.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, '$1 | ');
  md = md.replace(/<figure[^>]*>|<\/figure>/gi, '');
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<p[^>]*>/gi, '');
  md = md.replace(/<\/p>/gi, '\n');
  md = md.replace(/<div[^>]*>|<\/div>/gi, '\n');
  md = md.replace(/<span[^>]*>|<\/span>|<label[^>]*>|<\/label>/gi, '');
  md = md.replace(/<[^>]+>/g, '');
  md = md.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}

function formatNoteSummary(note) {
  const lines = [
    `ID: ${note.noteId}`,
    `Título: ${note.title}`,
    `Tipo: ${note.type}${note.mime ? ' (' + note.mime + ')' : ''}`,
  ];
  if (note.parentNoteIds?.length) lines.push(`Padres: ${note.parentNoteIds.join(', ')}`);
  if (note.dateCreated) lines.push(`Creada: ${note.dateCreated}`);
  if (note.dateModified) lines.push(`Modificada: ${note.dateModified}`);
  return lines.join('\n');
}

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });

// ============================================================================
// DEFINICIÓN DE TOOLS (17 en total)
// ============================================================================
const TOOLS = [
  // --- LECTURA ---
  {
    name: 'get_note',
    description: 'Obtener metadata y contenido de una nota. Devuelve también el contenido convertido a Markdown legible para que se pueda procesar fácilmente.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'ID de la nota' },
        format: { type: 'string', description: 'html | markdown | both (default: both)', default: 'both' },
      },
      required: ['noteId'],
    },
  },
  {
    name: 'get_note_children',
    description: 'Obtener las notas hijas de una nota',
    inputSchema: {
      type: 'object',
      properties: { noteId: { type: 'string', description: 'ID de la nota padre' } },
      required: ['noteId'],
    },
  },
  {
    name: 'search_notes',
    description: 'Buscar notas. Soporta texto libre o sintaxis avanzada de Trilium (ej. "#etiqueta", "@dateCreated >= 2026-01-01 AND #proyecto"). Ver https://docs.triliumnotes.org para la sintaxis completa.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto o query DSL de Trilium' },
        limit: { type: 'number', description: 'Máximo de resultados (default: 10)', default: 10 },
        fastSearch: { type: 'boolean', description: 'Búsqueda rápida solo en título (default: false)', default: false },
        includeArchivedNotes: { type: 'boolean', description: 'Incluir archivadas (default: false)', default: false },
      },
      required: ['query'],
    },
  },
  // --- ESCRITURA BÁSICA ---
  {
    name: 'create_note',
    description: 'Crear una nota. El contenido puede ser HTML enriquecido (tablas, listas, admoniciones, etc).',
    inputSchema: {
      type: 'object',
      properties: {
        parentNoteId: { type: 'string', description: 'ID del padre (usa "root" para raíz)' },
        title: { type: 'string', description: 'Título de la nota' },
        content: { type: 'string', description: 'Contenido HTML o texto' },
        type: { type: 'string', description: 'text, code, book, etc (default: text)', default: 'text' },
        mime: { type: 'string', description: 'MIME type (default según tipo)' },
      },
      required: ['parentNoteId', 'title', 'content'],
    },
  },
  {
    name: 'update_note',
    description: 'Actualizar contenido y/o título de una nota',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'ID de la nota' },
        title: { type: 'string', description: 'Nuevo título (opcional)' },
        content: { type: 'string', description: 'Nuevo contenido' },
      },
      required: ['noteId', 'content'],
    },
  },
  {
    name: 'delete_note',
    description: 'Eliminar una nota (y sus hijos)',
    inputSchema: {
      type: 'object',
      properties: { noteId: { type: 'string', description: 'ID a eliminar' } },
      required: ['noteId'],
    },
  },
  // --- TANDA 1: MOVE / CLONE / EXPORT ---
  {
    name: 'move_note',
    description: 'Mover una nota a otro padre. Si quieres que aparezca en VARIOS padres a la vez sin moverla, usa clone_note.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'ID de la nota a mover' },
        newParentNoteId: { type: 'string', description: 'ID del nuevo padre' },
      },
      required: ['noteId', 'newParentNoteId'],
    },
  },
  {
    name: 'clone_note',
    description: 'Clonar una nota: la misma nota aparece en MÚLTIPLES padres (no es copia, es referencia). Feature única de Trilium.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'ID de la nota a clonar' },
        targetParentNoteId: { type: 'string', description: 'ID del padre adicional donde aparecerá también' },
        prefix: { type: 'string', description: 'Prefijo opcional para esta aparición (ej. "alias:")' },
      },
      required: ['noteId', 'targetParentNoteId'],
    },
  },
  {
    name: 'export_note',
    description: 'Exportar una nota (y su subárbol) como ZIP en formato HTML o Markdown. Devuelve un resumen del export con tamaño en bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'ID de la nota raíz a exportar' },
        format: { type: 'string', description: 'html | markdown (default: markdown)', default: 'markdown' },
      },
      required: ['noteId'],
    },
  },
  // --- TANDA 2: ATRIBUTOS, SHARE, DAY NOTE ---
  {
    name: 'get_attributes',
    description: 'Obtener todos los atributos (labels y relations) de una nota. Labels son #tags, relations son ~conexiones a otras notas.',
    inputSchema: {
      type: 'object',
      properties: { noteId: { type: 'string', description: 'ID de la nota' } },
      required: ['noteId'],
    },
  },
  {
    name: 'set_attribute',
    description: 'Agregar un atributo (label o relation) a una nota. Labels (#tag) clasifican y permiten búsquedas tipo "#proyecto". Relations (~target) conectan notas entre sí.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'ID de la nota' },
        type: { type: 'string', description: 'label o relation', enum: ['label', 'relation'] },
        name: { type: 'string', description: 'Nombre del atributo (ej. "tag", "proyecto", "shared")' },
        value: { type: 'string', description: 'Valor: para label es texto, para relation es noteId destino', default: '' },
        isInheritable: { type: 'boolean', description: 'Si los descendientes heredan este atributo (default: false)', default: false },
      },
      required: ['noteId', 'type', 'name'],
    },
  },
  {
    name: 'delete_attribute',
    description: 'Eliminar un atributo de una nota por su attributeId (lo obtienes con get_attributes)',
    inputSchema: {
      type: 'object',
      properties: { attributeId: { type: 'string', description: 'ID del atributo a eliminar' } },
      required: ['attributeId'],
    },
  },
  {
    name: 'enable_share',
    description: 'Activar compartir público de una nota (agrega el label #shared). Devuelve la URL pública. Compartir incluye automáticamente todo el subárbol.',
    inputSchema: {
      type: 'object',
      properties: {
        noteId: { type: 'string', description: 'ID de la nota a compartir' },
        shareBaseUrl: { type: 'string', description: 'Base URL del Trilium para construir el link (ej. https://trilium.jbs.red)' },
      },
      required: ['noteId'],
    },
  },
  {
    name: 'disable_share',
    description: 'Desactivar compartir público (elimina el label #shared)',
    inputSchema: {
      type: 'object',
      properties: { noteId: { type: 'string', description: 'ID de la nota' } },
      required: ['noteId'],
    },
  },
  {
    name: 'get_day_note',
    description: 'Obtener (o crear si no existe) la nota del día para una fecha específica. Trilium tiene un sistema nativo de diario jerárquico año/mes/día.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Fecha en formato YYYY-MM-DD (default: hoy)' },
      },
    },
  },
  // --- TANDA 3: APP INFO, INBOX, REFRESH ---
  {
    name: 'get_app_info',
    description: 'Info de la instancia de Trilium: versión, fecha de build, sync version, etc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_inbox',
    description: 'Obtener la nota de inbox para una fecha (donde van las notas capturadas rápido)',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Fecha YYYY-MM-DD (default: hoy)' },
      },
    },
  },
];

// ============================================================================
// IMPLEMENTACIÓN DE HANDLERS
// ============================================================================
async function handleCall(name, args) {
  switch (name) {
    // --- LECTURA ---
    case 'get_note': {
      const [note, content] = await Promise.all([
        triliumRequest('GET', `/notes/${args.noteId}`),
        triliumRequest('GET', `/notes/${args.noteId}/content`),
      ]);
      const format = args.format || 'both';
      const parts = [formatNoteSummary(note), ''];
      if (format === 'html' || format === 'both') {
        parts.push('--- HTML ---', content, '');
      }
      if (format === 'markdown' || format === 'both') {
        parts.push('--- Markdown ---', htmlToMarkdown(content));
      }
      return ok(parts.join('\n'));
    }
    case 'get_note_children': {
      const note = await triliumRequest('GET', `/notes/${args.noteId}`);
      if (!note.childNoteIds?.length) return ok('Esta nota no tiene hijos');
      const children = await Promise.all(
        note.childNoteIds.map(id => triliumRequest('GET', `/notes/${id}`))
      );
      const list = children.map(n => `- [${n.noteId}] ${n.title}`).join('\n');
      return ok(`Notas hijas de ${args.noteId}:\n${list}`);
    }
    case 'search_notes': {
      const params = new URLSearchParams({
        search: args.query,
        limit: String(args.limit || 10),
        fastSearch: String(args.fastSearch || false),
        includeArchivedNotes: String(args.includeArchivedNotes || false),
      });
      const results = await triliumRequest('GET', `/notes?${params.toString()}`);
      const items = results?.results || [];
      if (!items.length) return ok('No se encontraron notas');
      const list = items.map(n => `- [${n.noteId}] ${n.title}`).join('\n');
      return ok(`Resultados (${items.length}):\n${list}`);
    }

    // --- ESCRITURA BÁSICA ---
    case 'create_note': {
      const type = args.type || 'text';
      const mime = args.mime || (type === 'code' ? 'text/plain' : 'text/html');
      const result = await triliumRequest('POST', '/create-note', {
        parentNoteId: args.parentNoteId,
        title: args.title,
        content: args.content,
        type,
        mime,
      });
      return ok(`Nota creada con ID: ${result.note.noteId}\nTítulo: ${result.note.title}`);
    }
    case 'update_note': {
      // ============ DEBUG LOGS ============
      console.log('[update_note] args recibidos:', JSON.stringify(args, null, 2));
      console.log('[update_note] typeof args.content:', typeof args.content);
      console.log('[update_note] args.content length:', args.content?.length);
      console.log('[update_note] args.content preview:', String(args.content || '').substring(0, 100));
      // ====================================

      if (args.content === undefined || args.content === null) {
        throw new Error(
          `Content es null/undefined. Args recibidos: ${JSON.stringify(Object.keys(args || {}))}`
        );
      }

      if (args.title) {
        await triliumRequest('PATCH', `/notes/${args.noteId}`, { title: args.title });
      }

      // Forzar a string por si llega como objeto, número, o cualquier otra cosa
      let contentStr = typeof args.content === 'string'
        ? args.content
        : String(args.content);

      // Si está vacío, mandar al menos un párrafo vacío (Trilium ETAPI necesita body no vacío)
      if (contentStr.length === 0) {
        contentStr = '<p></p>';
      }

      console.log('[update_note] contentStr final length:', contentStr.length);

      await triliumRequest('PUT', `/notes/${args.noteId}/content`, contentStr);
      return ok(`Nota ${args.noteId} actualizada correctamente`);
    }
    case 'delete_note': {
      await triliumRequest('DELETE', `/notes/${args.noteId}`);
      return ok(`Nota ${args.noteId} eliminada`);
    }

    // --- TANDA 1: MOVE / CLONE / EXPORT ---
    case 'move_note': {
      // La ETAPI no permite cambiar parentNoteId de una branch existente.
      // Solución: crear branch nueva en el destino, borrar la vieja.
      const note = await triliumRequest('GET', `/notes/${args.noteId}`);
      if (!note.parentBranchIds?.length) {
        throw new Error('La nota no tiene branches (¿es la raíz?)');
      }
      // Tomamos la primera branch como "la principal" a mover
      const oldBranchId = note.parentBranchIds[0];
      const oldBranch = await triliumRequest('GET', `/branches/${oldBranchId}`);

      // 1) Crear nueva branch en el destino
      const newBranch = await triliumRequest('POST', '/branches', {
        noteId: args.noteId,
        parentNoteId: args.newParentNoteId,
        prefix: oldBranch.prefix || '',
        isExpanded: oldBranch.isExpanded || false,
      });

      // 2) Borrar la branch vieja (no borra la nota porque sigue clonada en la nueva)
      await triliumRequest('DELETE', `/branches/${oldBranchId}`);

      return ok(`Nota ${args.noteId} movida de ${oldBranch.parentNoteId} a ${args.newParentNoteId}\nNueva branch: ${newBranch.branchId}`);
    }
    case 'clone_note': {
      // Clonar = crear una branch nueva apuntando a la misma nota desde otro padre
      const body = {
        noteId: args.noteId,
        parentNoteId: args.targetParentNoteId,
      };
      if (args.prefix) body.prefix = args.prefix;
      const branch = await triliumRequest('POST', '/branches', body);
      return ok(`Nota ${args.noteId} clonada bajo ${args.targetParentNoteId}\nBranch ID: ${branch.branchId}`);
    }
    case 'export_note': {
      const format = args.format || 'markdown';
      const buf = await triliumRequest(
        'GET',
        `/notes/${args.noteId}/export?format=${format}`,
        null,
        { expectBinary: true }
      );
      return ok(`Export OK\nNota: ${args.noteId}\nFormato: ${format}\nTamaño del ZIP: ${buf.length} bytes\n\n(El ZIP no se puede transferir por el MCP, pero el export se ejecutó correctamente. Para descargarlo usa la UI de Trilium o un script que lo guarde a disco.)`);
    }

    // --- TANDA 2: ATRIBUTOS / SHARE / DAY NOTE ---
    case 'get_attributes': {
      const note = await triliumRequest('GET', `/notes/${args.noteId}`);
      if (!note.attributes?.length) return ok('La nota no tiene atributos');
      const list = note.attributes.map(a => {
        const prefix = a.type === 'label' ? '#' : '~';
        const value = a.value ? `=${a.value}` : '';
        const inh = a.isInheritable ? ' (heredable)' : '';
        return `- [${a.attributeId}] ${prefix}${a.name}${value}${inh}`;
      }).join('\n');
      return ok(`Atributos de ${args.noteId}:\n${list}`);
    }
    case 'set_attribute': {
      const attr = await triliumRequest('POST', '/attributes', {
        noteId: args.noteId,
        type: args.type,
        name: args.name,
        value: args.value || '',
        isInheritable: args.isInheritable || false,
      });
      const prefix = args.type === 'label' ? '#' : '~';
      return ok(`Atributo creado: ${prefix}${args.name}${args.value ? '=' + args.value : ''}\nID: ${attr.attributeId}`);
    }
    case 'delete_attribute': {
      await triliumRequest('DELETE', `/attributes/${args.attributeId}`);
      return ok(`Atributo ${args.attributeId} eliminado`);
    }
    case 'enable_share': {
      const attr = await triliumRequest('POST', '/attributes', {
        noteId: args.noteId,
        type: 'label',
        name: 'shared',
        value: '',
        isInheritable: false,
      });
      const base = args.shareBaseUrl || TRILIUM_URL.replace(/\/$/, '');
      const url = `${base}/share/${args.noteId}`;
      return ok(`Nota ${args.noteId} compartida públicamente\nURL: ${url}\nAttribute ID: ${attr.attributeId}`);
    }
    case 'disable_share': {
      const note = await triliumRequest('GET', `/notes/${args.noteId}`);
      const sharedAttr = note.attributes?.find(a => a.type === 'label' && a.name === 'shared');
      if (!sharedAttr) return ok('La nota no estaba compartida');
      await triliumRequest('DELETE', `/attributes/${sharedAttr.attributeId}`);
      return ok(`Compartir desactivado para ${args.noteId}`);
    }
    case 'get_day_note': {
      const date = args.date || new Date().toISOString().split('T')[0];
      const note = await triliumRequest('GET', `/calendar/days/${date}`);
      return ok(`Day note de ${date}:\n${formatNoteSummary(note)}`);
    }

    // --- TANDA 3: INFO ---
    case 'get_app_info': {
      const info = await triliumRequest('GET', '/app-info');
      return ok(`Trilium App Info:\n${JSON.stringify(info, null, 2)}`);
    }
    case 'get_inbox': {
      const date = args.date || new Date().toISOString().split('T')[0];
      const note = await triliumRequest('GET', `/inbox/${date}`);
      return ok(`Inbox de ${date}:\n${formatNoteSummary(note)}`);
    }

    default:
      throw new Error(`Herramienta desconocida: ${name}`);
  }
}

// ============================================================================
// MCP SERVER SETUP
// ============================================================================
function createMCPServer() {
  const server = new Server(
    { name: 'trilium-mcp', version: '3.0.3' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleCall(name, args || {});
    } catch (error) {
      return fail(error.message);
    }
  });

  return server;
}

// ============================================================================
// HTTP TRANSPORT (Streamable HTTP)
// ============================================================================
const transports = {};

const httpServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'trilium-mcp',
      version: '3.0.3',
      transport: 'streamable-http',
      tools: TOOLS.length,
    }));
    return;
  }

  if (req.url === '/mcp' || req.url.startsWith('/mcp?')) {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    try {
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const parsedBody = JSON.parse(body);

        if (parsedBody.method === 'initialize') {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => { transports[sid] = transport; },
          });

          transport.onclose = () => {
            if (transport.sessionId) delete transports[transport.sessionId];
          };

          const server = createMCPServer();
          await server.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          return;
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          }));
          return;
        }
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Invalid session' },
          id: null,
        }));
        return;
      }

      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        await transport.handleRequest(req, res, JSON.parse(body));
      } else {
        await transport.handleRequest(req, res);
      }
    } catch (e) {
      console.error('Error manejando request MCP:', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: `Internal error: ${e.message}` },
          id: null,
        }));
      }
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

httpServer.listen(PORT, () => {
  console.log(`Trilium MCP server v3.0.3 corriendo en puerto ${PORT}`);
  console.log(`Trilium URL: ${TRILIUM_URL}`);
  console.log(`Tools registradas: ${TOOLS.length}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health endpoint: http://localhost:${PORT}/health`);
});
