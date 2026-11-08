import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import * as contracts from '../src/index.js';

const schemas = Object.fromEntries(Object.entries(contracts)
  .filter(([name, value]) => name.endsWith('Schema') && value instanceof z.ZodType)
  .map(([name, value]) => [name, z.toJSONSchema(value as z.ZodType, { target: 'draft-2020-12', io: 'input' })]));
const dir = new URL('../generated/', import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(new URL('schemas.json', dir), JSON.stringify(schemas, null, 2) + '\n');
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string) => ({ description: 'Success', content: { 'application/json': { schema: ref(name) } } });
const operation = (request: string | null, result: string, node = false, status = '200') => ({
  security: [{ [node ? 'nodeToken' : 'userToken']: [] }],
  ...(request ? { requestBody: { required: true, content: { 'application/json': { schema: ref(request) } } } } : {}),
  responses: { [status]: response(result), default: { ...response('apiErrorSchema'), description: 'Error' } },
});
const parameter = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
const document = {
  openapi: '3.1.0', info: { title: 'Curilo Agent protocol', version: contracts.PROTOCOL_VERSION },
  paths: {
    '/v1/nodes': { get: operation(null, 'nodesResponseSchema') },
    '/v1/nodes/register': { post: operation('registrationSchema', 'leaseSchema', true) },
    '/v1/nodes/{nodeId}/heartbeats': { parameters: [parameter('nodeId')], post: operation('heartbeatSchema', 'leaseSchema', true) },
    '/v1/conversations': { post: operation(null, 'conversationSchema', false, '201') },
    '/v1/conversations/{conversationId}': { parameters: [parameter('conversationId')], get: operation(null, 'conversationSchema') },
    '/v1/conversations/{conversationId}/messages': {
      parameters: [parameter('conversationId')], post: {
        ...operation('submitMessageSchema', 'taskResponseSchema', false, '202'),
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 128 } }],
      },
    },
    '/v1/conversations/{conversationId}/events': { parameters: [parameter('conversationId')], get: {
      security: [{ userToken: [] }], parameters: [{ name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'Last-Event-ID', in: 'header', schema: { type: 'string' } }],
      responses: { '200': { description: 'Durable ordered SSE; data validates against eventSchema. Reconnect using last event ID.', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
    } },
    '/v1/tasks/{taskId}': { parameters: [parameter('taskId')], get: operation(null, 'taskSchema') },
    '/v1/tasks/{taskId}/cancel': { parameters: [parameter('taskId')], post: operation(null, 'taskSchema') },
    '/v1/tasks/{taskId}/decisions': { parameters: [parameter('taskId')], get: {
      security: [{ userToken: [] }], responses: { '200': { description: 'Audit records', content: { 'application/json': { schema: { type: 'object', properties: { decisions: { type: 'array', items: ref('decisionSchema') } }, required: ['decisions'] } } } } },
    } },
    '/v1/executions': { post: operation('executionRequestSchema', 'executionSnapshotSchema', true, '202') },
    '/v1/executions/{attemptId}': { parameters: [parameter('attemptId')], get: operation(null, 'executionSnapshotSchema', true) },
    '/v1/executions/{attemptId}/cancel': { parameters: [parameter('attemptId')], post: operation(null, 'executionSnapshotSchema', true) },
  },
  components: { schemas, securitySchemes: { userToken: { type: 'http', scheme: 'bearer' }, nodeToken: { type: 'http', scheme: 'bearer' } } },
};
await writeFile(new URL('openapi.json', dir), JSON.stringify(document, null, 2) + '\n');
