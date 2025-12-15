/**
 * MCP Factory - Step 4: Packager
 * Builds, packages, and optionally containerizes MCP servers
 */

const fs = require('fs').promises;
const path = require('path');
const { execSync, exec } = require('child_process');

class MCPPackager {
  constructor(options = {}) {
    this.outputDir = options.outputDir || '/opt/mcp-factory/output';
    this.enableDocker = options.enableDocker || false;
    this.verbose = options.verbose || false;
  }

  log(msg) {
    if (this.verbose) console.log(`[Packager] ${msg}`);
  }

  /**
   * Run shell command with error handling
   */
  async runCommand(cmd, cwd = null) {
    return new Promise((resolve, reject) => {
      const options = { maxBuffer: 10 * 1024 * 1024 };
      if (cwd) options.cwd = cwd;
      
      exec(cmd, options, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Command failed: ${cmd}\n${stderr || error.message}`));
        } else {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
      });
    });
  }

  /**
   * Build TypeScript server
   */
  async build(serverDir) {
    this.log(`Building ${serverDir}`);
    
    // Check if package.json exists
    const pkgPath = path.join(serverDir, 'package.json');
    try {
      await fs.access(pkgPath);
    } catch {
      return { success: false, error: 'package.json not found' };
    }

    // Read package.json to get name
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    
    // Check if dist/ already exists with content
    const distDir = path.join(serverDir, 'dist');
    let skipBuild = false;
    try {
      const distFiles = await fs.readdir(distDir);
      if (distFiles.length > 0) {
        this.log('dist/ already exists with content, skipping build');
        skipBuild = true;
      }
    } catch {
      // dist doesn't exist, need to build
    }

    // Run npm run build if needed and build script exists
    if (!skipBuild && pkg.scripts?.build) {
      try {
        await this.runCommand('npm run build', serverDir);
        this.log('TypeScript build completed');
      } catch (err) {
        return { success: false, error: `Build failed: ${err.message}` };
      }
    } else if (!skipBuild) {
      this.log('No build script found, skipping TypeScript compilation');
    }

    // Verify dist/ or build/ exists (reuse distDir from above)
    const buildDir = path.join(serverDir, 'build');
    let outputDir = null;

    try {
      await fs.access(distDir);
      outputDir = distDir;
    } catch {
      try {
        await fs.access(buildDir);
        outputDir = buildDir;
      } catch {
        // No dist/build - might be JS-only project
        this.log('No dist/ or build/ directory - using src/ directly');
        outputDir = path.join(serverDir, 'src');
      }
    }

    return { success: true, outputDir, name: pkg.name, version: pkg.version || '1.0.0' };
  }


  /**
   * Create npm tarball (.tgz)
   */
  async createTarball(serverDir) {
    this.log(`Creating tarball for ${serverDir}`);
    
    const pkgPath = path.join(serverDir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    const name = pkg.name.replace(/^@.*\//, ''); // Strip scope
    const version = pkg.version || '1.0.0';
    
    try {
      // npm pack creates <name>-<version>.tgz
      const { stdout } = await this.runCommand('npm pack', serverDir);
      const tarballName = stdout.split('\n').pop(); // Last line is filename
      const tarballPath = path.join(serverDir, tarballName);
      
      this.log(`Created tarball: ${tarballPath}`);
      return { success: true, tarballPath, tarballName };
    } catch (err) {
      return { success: false, error: `Failed to create tarball: ${err.message}` };
    }
  }

  /**
   * Build Docker image (optional)
   */
  async buildDocker(serverDir) {
    if (!this.enableDocker) {
      return { success: false, skipped: true, reason: 'Docker disabled' };
    }

    const pkgPath = path.join(serverDir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    const name = pkg.name.replace(/^@.*\//, '').replace(/[^a-z0-9-]/g, '-');
    const version = pkg.version || '1.0.0';
    const imageName = `${name}:${version}`;

    // Check if Dockerfile exists
    const dockerfilePath = path.join(serverDir, 'Dockerfile');
    try {
      await fs.access(dockerfilePath);
    } catch {
      // Generate basic Dockerfile
      const dockerfile = this.generateDockerfile(pkg);
      await fs.writeFile(dockerfilePath, dockerfile);
      this.log('Generated Dockerfile');
    }

    try {
      await this.runCommand(`docker build -t ${imageName} .`, serverDir);
      this.log(`Built Docker image: ${imageName}`);
      return { success: true, imageName };
    } catch (err) {
      return { success: false, error: `Docker build failed: ${err.message}` };
    }
  }

  /**
   * Generate basic Dockerfile for MCP server
   */
  generateDockerfile(pkg) {
    const mainFile = pkg.main || 'dist/index.js';
    return `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "${mainFile}"]
`;
  }

  /**
   * Generate Claude Desktop config snippet
   */
  generateClaudeConfig(serverDir, pkg) {
    const name = pkg.name.replace(/^@.*\//, '');
    return {
      [name]: {
        command: "node",
        args: [path.join(serverDir, pkg.main || 'dist/index.js')],
        env: {}
      }
    };
  }

  /**
   * Main packaging workflow
   */
  async package(serverDir, options = {}) {
    this.log(`Packaging ${serverDir}`);
    const results = { steps: [], errors: [], warnings: [] };
    
    // Resolve absolute path
    serverDir = path.resolve(serverDir);
    
    // Step 1: Build
    const buildResult = await this.build(serverDir);
    results.steps.push({ name: 'build', ...buildResult });
    
    if (!buildResult.success) {
      results.errors.push(`Build failed: ${buildResult.error}`);
      return { success: false, ...results };
    }

    // Read package.json for metadata
    const pkg = JSON.parse(await fs.readFile(path.join(serverDir, 'package.json'), 'utf8'));
    const name = pkg.name.replace(/^@.*\//, '');
    const version = pkg.version || '1.0.0';

    // Step 2: Create tarball
    const tarballResult = await this.createTarball(serverDir);
    results.steps.push({ name: 'tarball', ...tarballResult });
    
    if (!tarballResult.success) {
      results.warnings.push(`Tarball creation failed: ${tarballResult.error}`);
    }

    // Step 3: Docker (optional)
    let dockerResult = { skipped: true };
    if (options.docker || this.enableDocker) {
      this.enableDocker = true;
      dockerResult = await this.buildDocker(serverDir);
      results.steps.push({ name: 'docker', ...dockerResult });
    }

    // Step 4: Generate manifest
    const manifest = {
      name,
      version,
      description: pkg.description || '',
      package: tarballResult.success ? tarballResult.tarballPath : null,
      docker: dockerResult.success ? dockerResult.imageName : null,
      serverDir,
      claude_config: this.generateClaudeConfig(serverDir, pkg),
      created_at: new Date().toISOString()
    };

    // Write manifest to server directory
    const manifestPath = path.join(serverDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    this.log(`Wrote manifest to ${manifestPath}`);

    return {
      success: true,
      manifest,
      manifestPath,
      ...results
    };
  }
}

// CLI execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: node packager.js <server-directory> [--docker] [--verbose]');
    console.log('');
    console.log('Example:');
    console.log('  node packager.js /opt/mcp-factory/output/mcp-weather');
    console.log('  node packager.js /opt/mcp-factory/output/mcp-weather --docker --verbose');
    process.exit(1);
  }

  const serverDir = args[0];
  const options = {
    docker: args.includes('--docker'),
    verbose: args.includes('--verbose')
  };

  const packager = new MCPPackager({ verbose: options.verbose, enableDocker: options.docker });
  
  try {
    console.log(`\n📦 Packaging MCP Server: ${serverDir}\n`);
    const result = await packager.package(serverDir, options);
    
    if (result.success) {
      console.log('✅ Packaging complete!\n');
      console.log('📋 Manifest:');
      console.log(JSON.stringify(result.manifest, null, 2));
      
      if (result.warnings.length > 0) {
        console.log('\n⚠️  Warnings:');
        result.warnings.forEach(w => console.log(`  - ${w}`));
      }
    } else {
      console.error('❌ Packaging failed:');
      result.errors.forEach(e => console.error(`  - ${e}`));
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Fatal error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { MCPPackager };

if (require.main === module) {
  main();
}
