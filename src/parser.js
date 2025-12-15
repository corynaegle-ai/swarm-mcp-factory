/**
 * MCP Factory - Parser Phase
 * Converts natural language descriptions into structured MCP specifications
 */

const Anthropic = require('@anthropic-ai/sdk');

const SPEC_SCHEMA = {
  type: 'object',
  required: ['name', 'description', 'tools'],
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    description: { type: 'string' },
    version: { type: 'string', default: '1.0.0' },
    runtime: { type: 'string', enum: ['typescript', 'python'], default: 'typescript' },
    auth: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['none', 'bearer', 'api_key', 'oauth2'] },
        env_var: { type: 'string' },
        header_name: { type: 'string' }
      }
    },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'description'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          parameters: { type: 'array' },
          returns: { type: 'string' }
        }
      }
    },
    resources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'uri_template'],
        properties: {
          name: { type: 'string' },
          uri_template: { type: 'string' },
          description: { type: 'string' },
          mime_type: { type: 'string' }
        }
      }
    }
  }
};

const EXTRACTION_PROMPT = `You are an MCP (Model Context Protocol) specification expert. Extract a structured specification from the user's description.

Output ONLY valid JSON matching this schema:
{
  "name": "kebab-case-name",
  "description": "One sentence description",
  "version": "1.0.0",
  "runtime": "typescript",
  "auth": {
    "type": "bearer|api_key|none",
    "env_var": "ENV_VAR_NAME"
  },
  "tools": [
    {
      "name": "snake_case_name",
      "description": "What this tool does",
      "parameters": [
        {
          "name": "param_name",
          "type": "string|number|boolean|array|object",
          "required": true,
          "description": "Parameter description",
          "enum": ["optional", "values"],
          "default": "optional_default"
        }
      ],
      "returns": "Description of return value"
    }
  ],
  "resources": [
    {
      "name": "resource_name",
      "uri_template": "protocol://{param}/path",
      "description": "What this resource provides",
      "mime_type": "application/json"
    }
  ]
}

Rules:
1. Infer auth type from API mentions (GitHub/Notion = bearer, etc.)
2. Generate sensible parameter types and names
3. Include common CRUD operations if implied
4. Resources are optional - only include if data retrieval is mentioned
5. Use snake_case for tool/resource names, kebab-case for package name`;

class MCPParser {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Parse natural language into structured MCP spec
   */
  async parse(description, options = {}) {
    const { runtime = 'typescript', validate = true } = options;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `${EXTRACTION_PROMPT}\n\nUser Description:\n${description}\n\nPreferred runtime: ${runtime}`
        }
      ]
    });

    const content = response.content[0].text;
    
    // Extract JSON from response (handle markdown code blocks)
    let spec;
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/) || 
                        content.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : content;
      spec = JSON.parse(jsonStr.trim());
    } catch (e) {
      throw new Error(`Failed to parse LLM response as JSON: ${e.message}`);
    }

    // Apply defaults
    spec.version = spec.version || '1.0.0';
    spec.runtime = runtime;
    spec.auth = spec.auth || { type: 'none' };
    spec.resources = spec.resources || [];

    if (validate) {
      const errors = this.validate(spec);
      if (errors.length > 0) {
        throw new Error(`Spec validation failed: ${errors.join(', ')}`);
      }
    }

    return spec;
  }

  /**
   * Validate spec against schema
   */
  validate(spec) {
    const errors = [];

    // Required fields
    if (!spec.name) errors.push('Missing required field: name');
    if (!spec.description) errors.push('Missing required field: description');
    if (!spec.tools || spec.tools.length === 0) errors.push('At least one tool is required');

    // Name format
    if (spec.name && !/^[a-z][a-z0-9-]*$/.test(spec.name)) {
      errors.push('Name must be kebab-case starting with letter');
    }

    // Tool validation
    if (spec.tools) {
      spec.tools.forEach((tool, i) => {
        if (!tool.name) errors.push(`Tool ${i}: missing name`);
        if (!tool.description) errors.push(`Tool ${i}: missing description`);
        if (tool.name && !/^[a-z][a-z0-9_]*$/.test(tool.name)) {
          errors.push(`Tool ${tool.name}: must be snake_case`);
        }
      });
    }

    // Auth validation
    if (spec.auth && spec.auth.type !== 'none' && !spec.auth.env_var) {
      errors.push('Auth requires env_var when type is not "none"');
    }

    return errors;
  }

  /**
   * Parse from YAML string (pass-through for pre-structured specs)
   */
  parseYAML(yamlString) {
    const yaml = require('js-yaml');
    const spec = yaml.load(yamlString);
    const errors = this.validate(spec);
    if (errors.length > 0) {
      throw new Error(`YAML spec validation failed: ${errors.join(', ')}`);
    }
    return spec;
  }
}

module.exports = { MCPParser, SPEC_SCHEMA };

// CLI usage
if (require.main === module) {
  const readline = require('readline');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('MCP Factory Parser - Enter description (Ctrl+D to finish):');
  
  let input = '';
  rl.on('line', (line) => { input += line + '\n'; });
  rl.on('close', async () => {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('Error: ANTHROPIC_API_KEY not set');
      process.exit(1);
    }
    
    const parser = new MCPParser(process.env.ANTHROPIC_API_KEY);
    try {
      const spec = await parser.parse(input.trim());
      console.log('\n--- Generated Specification ---\n');
      console.log(JSON.stringify(spec, null, 2));
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  });
}
