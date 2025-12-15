/**
 * MCP Factory - Generator Phase
 * Template-based code generation for MCP servers
 */

const fs = require('fs').promises;
const path = require('path');

class MCPGenerator {
  constructor(templatesDir = path.join(__dirname, '../templates')) {
    this.templatesDir = templatesDir;
  }

  /**
   * Generate complete MCP server from spec
   */
  async generate(spec, outputDir) {
    const serverDir = path.join(outputDir, `mcp-${spec.name}`);
    
    // Create directory structure
    await fs.mkdir(serverDir, { recursive: true });
    await fs.mkdir(path.join(serverDir, 'src/tools'), { recursive: true });
    await fs.mkdir(path.join(serverDir, 'src/resources'), { recursive: true });
    await fs.mkdir(path.join(serverDir, 'tests'), { recursive: true });

    // Generate all files
    const files = [
      { path: 'package.json', content: this.genPackageJson(spec) },
      { path: 'tsconfig.json', content: this.genTsConfig() },
      { path: 'src/index.ts', content: this.genServerIndex(spec) },
      { path: 'src/schemas.ts', content: this.genSchemas(spec) },
      { path: 'src/client.ts', content: this.genClient(spec) },
      { path: 'README.md', content: this.genReadme(spec) },
      { path: 'Dockerfile', content: this.genDockerfile(spec) },
      { path: 'claude_desktop_config.json', content: this.genClaudeConfig(spec) },
    ];

    // Generate tool files
    for (const tool of spec.tools) {
      files.push({
        path: `src/tools/${tool.name}.ts`,
        content: this.genTool(tool, spec)
      });
    }

    // Generate resource files
    for (const resource of spec.resources || []) {
      files.push({
        path: `src/resources/${resource.name}.ts`,
        content: this.genResource(resource, spec)
      });
    }

    // Write all files
    for (const file of files) {
      await fs.writeFile(path.join(serverDir, file.path), file.content);
    }

    return { serverDir, files: files.map(f => f.path) };
  }

  genPackageJson(spec) {
    return JSON.stringify({
      name: `mcp-${spec.name}`,
      version: spec.version,
      description: spec.description,
      main: "dist/index.js",
      types: "dist/index.d.ts",
      scripts: {
        build: "tsc",
        start: "node dist/index.js",
        dev: "ts-node src/index.ts",
        test: "jest"
      },
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.0.0",
        "zod": "^3.22.0"
      },
      devDependencies: {
        "@types/node": "^20.0.0",
        "typescript": "^5.3.0",
        "ts-node": "^10.9.0",
        "jest": "^29.0.0",
        "@types/jest": "^29.0.0"
      },
      engines: { node: ">=18.0.0" }
    }, null, 2);
  }

  genTsConfig() {
    return JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "commonjs",
        lib: ["ES2022"],
        outDir: "./dist",
        rootDir: "./src",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        declaration: true
      },
      include: ["src/**/*"],
      exclude: ["node_modules", "dist"]
    }, null, 2);
  }

  genServerIndex(spec) {
    const toolImports = spec.tools.map(t => 
      `import { ${t.name}Tool } from './tools/${t.name}';`
    ).join('\n');
    
    const resourceImports = (spec.resources || []).map(r =>
      `import { ${r.name}Resource } from './resources/${r.name}';`
    ).join('\n');

    const toolRegistrations = spec.tools.map(t =>
      `  server.setRequestHandler(CallToolRequestSchema, ${t.name}Tool);`
    ).join('\n');

    return `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApiClient } from './client';
${toolImports}
${resourceImports}

const server = new Server(
  { name: 'mcp-${spec.name}', version: '${spec.version}' },
  { capabilities: { tools: {}, resources: {} } }
);

// Initialize API client
const client = new ApiClient();

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
${spec.tools.map(t => `    {
      name: '${t.name}',
      description: '${t.description}',
      inputSchema: {
        type: 'object',
        properties: {
${(t.parameters || []).map(p => `          ${p.name}: { type: '${p.type}'${p.description ? `, description: '${p.description}'` : ''} }`).join(',\n')}
        },
        required: [${(t.parameters || []).filter(p => p.required).map(p => `'${p.name}'`).join(', ')}]
      }
    }`).join(',\n')}
  ]
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
${spec.tools.map(t => `    case '${t.name}':
      return ${t.name}Tool(client, args);`).join('\n')}
    default:
      throw new Error(\`Unknown tool: \${name}\`);
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP server running on stdio');
}

main().catch(console.error);
`;
  }

  genSchemas(spec) {
    const toolSchemas = spec.tools.map(t => {
      const props = (t.parameters || []).map(p => {
        let zodType = 'z.string()';
        if (p.type === 'number') zodType = 'z.number()';
        if (p.type === 'boolean') zodType = 'z.boolean()';
        if (p.type === 'array') zodType = 'z.array(z.unknown())';
        if (p.enum) zodType = `z.enum([${p.enum.map(e => `'${e}'`).join(', ')}])`;
        if (!p.required) zodType += '.optional()';
        if (p.default !== undefined) zodType += `.default(${JSON.stringify(p.default)})`;
        return `  ${p.name}: ${zodType}`;
      });
      
      return `export const ${t.name}Schema = z.object({
${props.join(',\n')}
});

export type ${this.pascalCase(t.name)}Input = z.infer<typeof ${t.name}Schema>;`;
    });

    return `import { z } from 'zod';

${toolSchemas.join('\n\n')}
`;
  }

  genClient(spec) {
    const authSetup = spec.auth?.type === 'bearer' 
      ? `this.headers['Authorization'] = \`Bearer \${process.env.${spec.auth.env_var}}\`;`
      : spec.auth?.type === 'api_key'
      ? `this.headers['${spec.auth.header_name || 'X-API-Key'}'] = process.env.${spec.auth.env_var} || '';`
      : '';

    return `export class ApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.API_BASE_URL || '';
    this.headers = { 'Content-Type': 'application/json' };
    ${authSetup}
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(\`\${this.baseUrl}\${path}\`, { headers: this.headers });
    if (!res.ok) throw new Error(\`API error: \${res.status}\`);
    return res.json();
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(\`\${this.baseUrl}\${path}\`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(\`API error: \${res.status}\`);
    return res.json();
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(\`\${this.baseUrl}\${path}\`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(\`API error: \${res.status}\`);
    return res.json();
  }

  async delete<T>(path: string): Promise<T> {
    const res = await fetch(\`\${this.baseUrl}\${path}\`, {
      method: 'DELETE',
      headers: this.headers
    });
    if (!res.ok) throw new Error(\`API error: \${res.status}\`);
    return res.json();
  }
}
`;
  }

  genTool(tool, spec) {
    const params = (tool.parameters || []).map(p => p.name).join(', ');
    return `import { ApiClient } from '../client';
import { ${tool.name}Schema, ${this.pascalCase(tool.name)}Input } from '../schemas';

export async function ${tool.name}Tool(client: ApiClient, args: unknown) {
  const input = ${tool.name}Schema.parse(args);
  const { ${params} } = input;

  // TODO: Implement ${tool.name} logic
  // Example: const result = await client.get(\`/endpoint/\${param}\`);
  
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: true, message: '${tool.name} executed' })
      }
    ]
  };
}
`;
  }

  genResource(resource, spec) {
    return `import { ApiClient } from '../client';

export async function ${resource.name}Resource(client: ApiClient, uri: string) {
  // Parse URI: ${resource.uri_template}
  const match = uri.match(/^${resource.uri_template.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$/);
  if (!match?.groups) throw new Error('Invalid URI format');

  // TODO: Implement resource fetch logic
  // const data = await client.get(\`/path/\${match.groups.param}\`);

  return {
    contents: [
      {
        uri,
        mimeType: '${resource.mime_type || 'application/json'}',
        text: JSON.stringify({ resource: '${resource.name}' })
      }
    ]
  };
}
`;
  }

  genReadme(spec) {
    return `# MCP ${spec.name}

${spec.description}

## Installation

\`\`\`bash
npm install
npm run build
\`\`\`

## Configuration

${spec.auth?.env_var ? `Set the \`${spec.auth.env_var}\` environment variable with your API token.` : 'No authentication required.'}

## Claude Desktop Setup

Add to your Claude Desktop config (\`~/Library/Application Support/Claude/claude_desktop_config.json\`):

\`\`\`json
{
  "mcpServers": {
    "${spec.name}": {
      "command": "node",
      "args": ["${process.cwd()}/mcp-${spec.name}/dist/index.js"]${spec.auth?.env_var ? `,
      "env": {
        "${spec.auth.env_var}": "your-token-here"
      }` : ''}
    }
  }
}
\`\`\`

## Available Tools

${spec.tools.map(t => `### ${t.name}\n${t.description}\n`).join('\n')}

## Resources

${(spec.resources || []).map(r => `### ${r.name}\nURI: \`${r.uri_template}\`\n${r.description || ''}`).join('\n') || 'None'}
`;
  }

  genDockerfile(spec) {
    return `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
${spec.auth?.env_var ? `ENV ${spec.auth.env_var}=""` : ''}
CMD ["node", "dist/index.js"]
`;
  }

  genClaudeConfig(spec) {
    const config = {
      mcpServers: {
        [spec.name]: {
          command: "node",
          args: [`/path/to/mcp-${spec.name}/dist/index.js`]
        }
      }
    };
    if (spec.auth?.env_var) {
      config.mcpServers[spec.name].env = { [spec.auth.env_var]: "${" + spec.auth.env_var + "}" };
    }
    return JSON.stringify(config, null, 2);
  }

  pascalCase(str) {
    return str.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
  }
}

module.exports = { MCPGenerator };

// CLI usage
if (require.main === module) {
  const spec = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
  const outputDir = process.argv[3] || './output';
  
  const generator = new MCPGenerator();
  generator.generate(spec, outputDir).then(result => {
    console.log('Generated:', result.serverDir);
    console.log('Files:', result.files.join(', '));
  }).catch(console.error);
}
