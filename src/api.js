require("dotenv").config();
/**
 * MCP Factory API Server
 * Express API orchestrating the full MCP generation pipeline
 */

const express = require('express');
const crypto = require('crypto');
const { MCPParser, SPEC_SCHEMA } = require('./parser');
const { MCPGenerator } = require('./generator');
const { MCPValidator } = require('./validator');
const { MCPPackager } = require('./packager');
const { MCPRegistry } = require('./registry');

const app = express();
app.use(express.json());

// Job queue (in-memory)
const jobs = new Map();

// Singletons
const registry = new MCPRegistry();
let registryInitialized = false;

// Generate unique job ID
function generateJobId() {
  return `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// Ensure registry is initialized
async function ensureRegistry() {
  if (!registryInitialized) {
    await registry.init();
    registryInitialized = true;
  }
}

// Pipeline processor
async function processJob(jobId, description, runtime = 'node') {
  const job = jobs.get(jobId);
  const stages = [];
  
  try {
    // Validate API key
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable not set');
    }

    // Stage 1: Parse natural language → spec
    job.stage = 'parsing';
    jobs.set(jobId, { ...job });
    stages.push('parse');
    
    const parser = new MCPParser(process.env.ANTHROPIC_API_KEY);
    const spec = await parser.parse(description);
    
    if (!spec || !spec.name) {
      throw new Error('Parser failed to generate valid spec');
    }
    
    // Stage 2: Generate server code
    job.stage = 'generating';
    jobs.set(jobId, { ...job });
    stages.push('generate');
    
    const generator = new MCPGenerator();
    const genResult = await generator.generate(spec, `/opt/swarm-mcp-factory/output/${spec.name}`);
    const serverDir = genResult.serverDir;
    
    // Stage 3: Validate generated code
    job.stage = 'validating';
    jobs.set(jobId, { ...job });
    stages.push('validate');
    
    const validator = new MCPValidator();
    const validation = await validator.validate(serverDir);
    
    if (!validation.valid) {
      // Log warnings but continue if no critical errors
      const criticalErrors = validation.errors.filter(e => {
        const msg = typeof e === 'string' ? e : (e.message || String(e));
        return msg.includes('TypeScript') || msg.includes('import') || msg.includes('syntax');
      });
      if (criticalErrors.length > 0) {
        throw new Error(`Validation failed: ${criticalErrors.join('; ')}`);
      }
    }
    
    // Stage 4: Package for distribution
    job.stage = 'packaging';
    jobs.set(jobId, { ...job });
    stages.push('package');
    
    const packager = new MCPPackager();
    const pkgResult = await packager.package(serverDir, {
      runtime: runtime,
      outputDir: '/opt/swarm-mcp-factory/packages'
    });
    
    // Stage 5: Register in registry
    job.stage = 'registering';
    jobs.set(jobId, { ...job });
    stages.push('register');
    
    await ensureRegistry();
    const manifest = await registry.register({
      name: spec.name,
      package_path: pkgResult.packagePath,
      description: spec.description || '',
      spec: spec,
      version: spec.version || '1.0.0'
    });
    
    // Complete
    jobs.set(jobId, {
      status: 'complete',
      stage: 'done',
      created_at: job.created_at,
      completed_at: new Date(),
      result: {
        name: spec.name,
        serverDir,
        package_path: pkgResult.packagePath,
      description: spec.description || '',
      spec: spec,
        manifest,
        stages_completed: stages
      }
    });
    
    console.log(`[${jobId}] Complete: ${spec.name}`);
    
  } catch (err) {
    console.error(`[${jobId}] Failed at ${job.stage}:`, err.message);
    jobs.set(jobId, {
      status: 'failed',
      stage: job.stage,
      created_at: job.created_at,
      failed_at: new Date(),
      errors: [err.message],
      stages_completed: stages
    });
  }
}

// ==================== ENDPOINTS ====================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// POST /api/generate - Full pipeline: NL → registered MCP server
app.post('/api/generate', async (req, res) => {
  try {
    const { description, runtime } = req.body;
    
    if (!description || typeof description !== 'string') {
      return res.status(400).json({ 
        error: 'Missing or invalid description field' 
      });
    }
    
    const jobId = generateJobId();
    jobs.set(jobId, { 
      status: 'processing', 
      stage: 'queued',
      created_at: new Date() 
    });
    
    res.json({ job_id: jobId, status: 'processing' });
    
    // Process asynchronously
    setImmediate(() => processJob(jobId, description, runtime));
    
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id - Check job status
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json({
    job_id: req.params.id,
    status: job.status,
    stage: job.stage,
    created_at: job.created_at,
    completed_at: job.completed_at,
    failed_at: job.failed_at,
    result: job.result,
    errors: job.errors,
    stages_completed: job.stages_completed
  });
});

// GET /api/servers - List all registered servers
app.get('/api/servers', async (req, res) => {
  try {
    await ensureRegistry();
    const servers = await registry.list();
    res.json({ servers, count: servers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/servers/:name - Get server details + claude_config
app.get('/api/servers/:name', async (req, res) => {
  try {
    await ensureRegistry();
    const server = registry.get(req.params.name);
    
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/validate - Validate existing server or spec
app.post('/api/validate', async (req, res) => {
  try {
    const { serverDir, spec } = req.body;
    
    if (!serverDir && !spec) {
      return res.status(400).json({ 
        error: 'Provide either serverDir or spec' 
      });
    }
    
    const validator = new MCPValidator();
    
    if (serverDir) {
      // Validate existing server directory
      const result = await validator.validate(serverDir);
      return res.json(result);
    }
    
    if (spec) {
      // Validate spec against schema
      const schemaErrors = [];
      
      if (!spec.name) schemaErrors.push('Missing required field: name');
      if (!spec.tools && !spec.resources && !spec.prompts) {
        schemaErrors.push('At least one of tools, resources, or prompts required');
      }
      
      if (spec.tools) {
        spec.tools.forEach((tool, i) => {
          if (!tool.name) schemaErrors.push(`Tool ${i}: missing name`);
          if (!tool.description) schemaErrors.push(`Tool ${i}: missing description`);
        });
      }
      
      return res.json({
        valid: schemaErrors.length === 0,
        errors: schemaErrors,
        warnings: []
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// DELETE /api/servers/:name - Unregister a server
app.delete('/api/servers/:name', async (req, res) => {
  try {
    await ensureRegistry();
    const deleted = registry.unregister(req.params.name);
    
    if (!deleted) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    res.json({ success: true, name: req.params.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs - List recent jobs
app.get('/api/jobs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const jobList = Array.from(jobs.entries())
    .slice(-limit)
    .map(([id, job]) => ({
      job_id: id,
      status: job.status,
      stage: job.stage,
      created_at: job.created_at,
      result: job.result ? { name: job.result.name } : undefined
    }));
  
  res.json({ jobs: jobList, count: jobList.length });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ==================== SERVER STARTUP ====================

const PORT = process.env.PORT || 3456;

async function startup() {
  try {
    // Initialize registry
    await ensureRegistry();
    console.log('Registry initialized');
    
    // Ensure output directories exist
    const fs = require('fs');
    ['/opt/swarm-mcp-factory/output', '/opt/swarm-mcp-factory/packages'].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
    });
    
    // Start server
    app.listen(PORT, () => {
      console.log(`MCP Factory API running on port ${PORT}`);
      console.log(`Endpoints:`);
      console.log(`  POST /api/generate     - Generate MCP server from description`);
      console.log(`  GET  /api/jobs/:id     - Check job status`);
      console.log(`  GET  /api/jobs         - List recent jobs`);
      console.log(`  GET  /api/servers      - List registered servers`);
      console.log(`  GET  /api/servers/:n   - Get server details`);
      console.log(`  POST /api/validate     - Validate server or spec`);
      console.log(`  DEL  /api/servers/:n   - Unregister server`);
    });
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
}

startup();

module.exports = { app };
