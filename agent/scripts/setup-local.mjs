import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const password = randomBytes(24).toString('hex');
const contents = `# Local development credentials. Never commit this file.
POSTGRES_DB=agent
POSTGRES_USER=agent
POSTGRES_PASSWORD=${password}
POSTGRES_PORT=55432
DATABASE_URL=postgresql://agent:${password}@127.0.0.1:55432/agent
API_TOKEN=${randomBytes(32).toString('hex')}
NODE_SHARED_TOKEN=${randomBytes(32).toString('hex')}
FRONTEND_PORT=3300
FRONTEND_BIND=127.0.0.1
BACKEND_PORT=3100
NODE_AGENT_PORT=3101
BACKEND_URL=http://127.0.0.1:3100
NODE_ENDPOINT=http://127.0.0.1:3101
NODE_ENDPOINT_ALLOWLIST=http://127.0.0.1:3101,http://node-agent:3101,http://host.docker.internal:3101
FRONTEND_ORIGINS=http://localhost:3300,http://127.0.0.1:3300,http://localhost:3000,http://127.0.0.1:3000
JEV_API_KEY=
# RUNTIME_CONFIG=/absolute/path/to/operator-approved-runtime.json
# AGENT_WORKSPACE_DIR=/absolute/path/to/project
# ENABLED_TOOLS=read,ls,grep,find
`;
try {
  await writeFile(new URL('../.env', import.meta.url), contents, { flag: 'wx', mode: 0o600 });
  console.info('Created agent/.env with distinct random credentials. Frontend port3300 and PostgreSQL port55432 avoid common development ports. Existing services were not changed.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.info('agent/.env already exists; left it unchanged.');
}
