import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import { createServer } from 'http';

const TRILIUM_URL = process.env.TRILIUM_URL || 'http://localhost:8080';
const TRILIUM_TOKEN = process.env.TRILIUM_TOKEN || '';
const PORT = process.env.PORT || 3000;

const headers = {
  'Authorization': TRILIUM_TOKEN,
  'Content-Type': 'application/json',
};

async function triliumRequest(method, path, body = null) {
  const url = `${TRILIUM_URL}/etapi${path}`;
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trilium API error ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function createMCPServer() {
  const server = new Server(
    { name: 'trilium-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'create_note',
        description: 'Crear una nota en Trilium',
        inputSchema: {
          type: 'object',
          properties: {
            parentNoteId: { type: 'string', description: 'ID del nodo padre (usa "root" para raíz)' },
            title: { type: 'string', description: 'Título de la nota' },
            content: { type: 'string', description: 'Contenido en HTML o texto' },
            type: { type: 'string', description: 'Tipo: text, code (default: text)', default: 'text' },
          },
          required: ['parentNoteId', 'title', 'content'],
        },
      },
      {
        name: 'get_note',
        description: 'Obtener una nota por su ID',
        inputSchema: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: 'ID de la nota' },
          },
          required: ['noteId'],
        },
      },
      {
        name: 'update_note',
        description: 'Actualizar el contenido de una nota existente',
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
        name: 'search_notes',
        description: 'Buscar notas en Trilium',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Texto a buscar' },
            limit: { type: 'number', description: 'Máximo de resultados (default: 10)', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_note_children',
        description: 'Obtener las notas hijas de una nota',
        inputSchema: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: 'ID de la nota padre' },
          },
          required: ['noteId'],
        },
      },
      {
        name: 'delete_note',
        description: 'Eliminar una nota por su ID',
        inputSchema: {
          type: 'object',
          properties: {
            noteId: { type: 'string', description: 'ID de la nota a eliminar' },
          },
          required: ['noteId'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case 'create_note': {
          const result = await triliumRequest('POST', '/create-note', {
            parentNoteId: args.parentNoteId,
            title: args.title,
            content: args.content,
            type: args.type || 'text',
            mime: args.type === 'code' ? 'text/plain' : 'text/html',
          });
          return { content: [{ type: 'text', text: `Nota creada con ID: ${result.note.noteId}\nTítulo: ${result.note.title}` }] };
        }
        case 'get_note': {
          const [note, content] = await Promise.all([
            triliumRequest('GET', `/notes/${args.noteId}`),
            triliumRequest('GET', `/notes/${args.noteId}/content`),
          ]);
          return { content: [{ type: 'text', text: `ID: ${note.noteId}\nTítulo: ${note.title}\nTipo: ${note.type}\n\nContenido:\n${content}` }] };
        }
        case 'update_note': {
          if (args.title) await triliumRequest('PATCH', `/notes/${args.noteId}`, { title: args.title });
          await triliumRequest('PUT', `/notes/${args.noteId}/content`, args.content);
          return { content: [{ type: 'text', text: `Nota ${args.noteId} actualizada correctamente` }] };
        }
        case 'search_notes': {
          const results = await triliumRequest('GET', `/notes?search=${encodeURIComponent(args.query)}&limit=${args.limit || 10}`);
          if (!results || !results.length) return { content: [{ type: 'text', text: 'No se encontraron notas' }] };
          const list = results.map(n => `- [${n.noteId}] ${n.title}`).join('\n');
          return { content: [{ type: 'text', text: `Resultados:\n${list}` }] };
        }
        case 'get_note_children': {
          const note = await triliumRequest('GET', `/notes/${args.noteId}`);
          if (!note.childNoteIds || !note.childNoteIds.length) return { content: [{ type: 'text', text: 'Esta nota no tiene hijos' }] };
          const children = await Promise.all(note.childNoteIds.map(id => triliumRequest('GET', `/notes/${id}`)));
          const list = children.map(n => `- [${n.noteId}] ${n.title}`).join('\n');
          return { content: [{ type: 'text', text: `Notas hijas de ${args.noteId}:\n${list}` }] };
        }
        case 'delete_note': {
          await triliumRequest('DELETE', `/notes/${args.noteId}`);
          return { content: [{ type: 'text', text: `Nota ${args.noteId} eliminada` }] };
        }
        default:
          throw new Error(`Herramienta desconocida: ${name}`);
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  });

  return server;
}

// HTTP server con SSE
const transports = {};

const httpServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'trilium-mcp' }));
    return;
  }

  if (req.method === 'GET' && req.url === '/sse') {
    const transport = new SSEServerTransport('/messages', res);
    const server = createMCPServer();
    transports[transport.sessionId] = transport;
    res.on('close', () => delete transports[transport.sessionId]);
    await server.connect(transport);
    return;
  }

  if (req.method === 'POST' && req.url === '/messages') {
    const sessionId = new URL(req.url, `http://localhost`).searchParams.get('sessionId');
    const transport = transports[sessionId];
    if (!transport) { res.writeHead(404); res.end('Session not found'); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        await transport.handlePostMessage(req, res, JSON.parse(body));
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

httpServer.listen(PORT, () => {
  console.log(`Trilium MCP server corriendo en puerto ${PORT}`);
  console.log(`Trilium URL: ${TRILIUM_URL}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
