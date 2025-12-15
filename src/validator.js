/**
 * MCP Factory - Validator (Step 3)
 * Validates generated MCP server packages for correctness
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class MCPValidator {
  constructor(options = {}) {
    this.verbose = options.verbose || false;
  }

  /**
   * Main validation entry point
   */
  async validate(serverDir) {
    const errors = [];
    const warnings = [];

    // Check directory exists
    if (!fs.existsSync(serverDir)) {
      return {
        valid: false,
        errors: [{ type: 'filesystem', message: `Directory not found: ${serverDir}` }],
        warnings: []
      };
    }

    // Run all checks
    const tsResult = await this.checkTypeScript(serverDir);
    if (!tsResult.success) {
      errors.push(...tsResult.errors);
    }

    const lintResult = await this.checkLint(serverDir);
    if (lintResult.warnings.length > 0) {
      warnings.push(...lintResult.warnings);
    }
    if (lintResult.errors.length > 0) {
      errors.push(...lintResult.errors);
    }

    const protocolResult = await this.checkProtocol(serverDir);
    if (!protocolResult.compliant) {
      errors.push(...protocolResult.issues.map(issue => ({
        type: 'protocol',
        issue
      })));
    }

    const depsResult = await this.checkDependencies(serverDir);
    if (!depsResult.valid) {
      errors.push(...depsResult.missing.map(dep => ({
        type: 'dependency',
        message: `Missing required dependency: ${dep}`
      })));
    }
    if (depsResult.warnings.length > 0) {
      warnings.push(...depsResult.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * TypeScript compilation check
   */
  async checkTypeScript(serverDir) {
    const result = { success: true, errors: [] };

    try {
      // Check if tsconfig exists
      const tsconfigPath = path.join(serverDir, 'tsconfig.json');
      if (!fs.existsSync(tsconfigPath)) {
        result.errors.push({
          type: 'typescript',
          file: 'tsconfig.json',
          line: 0,
          message: 'tsconfig.json not found'
        });
        result.success = false;
        return result;
      }

      // Check if node_modules exists (npm install required first)
      const nodeModulesPath = path.join(serverDir, 'node_modules');
      if (!fs.existsSync(nodeModulesPath)) {
        result.errors.push({
          type: 'typescript',
          file: 'node_modules',
          line: 0,
          message: 'node_modules not found - run "npm install" first'
        });
        result.success = false;
        return result;
      }

      // Check if typescript is available
      const tscPath = path.join(serverDir, 'node_modules', '.bin', 'tsc');
      if (!fs.existsSync(tscPath)) {
        result.errors.push({
          type: 'typescript',
          file: 'typescript',
          line: 0,
          message: 'typescript not installed - run "npm install" first'
        });
        result.success = false;
        return result;
      }

      // Run tsc --noEmit using local typescript
      execSync('./node_modules/.bin/tsc --noEmit', {
        cwd: serverDir,
        stdio: 'pipe',
        timeout: 60000
      });

      if (this.verbose) console.log('✓ TypeScript compilation passed');
    } catch (error) {
      result.success = false;
      const output = error.stdout?.toString() || error.stderr?.toString() || '';
      
      // Parse tsc errors: src/index.ts(42,5): error TS2322: ...
      const errorRegex = /(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)/g;
      let match;
      
      while ((match = errorRegex.exec(output)) !== null) {
        result.errors.push({
          type: 'typescript',
          file: match[1],
          line: parseInt(match[2]),
          column: parseInt(match[3]),
          message: match[4]
        });
      }

      // If no parsed errors but still failed, add generic error
      if (result.errors.length === 0) {
        result.errors.push({
          type: 'typescript',
          file: 'unknown',
          line: 0,
          message: output.trim() || 'TypeScript compilation failed'
        });
      }
    }

    return result;
  }

  /**
   * ESLint check (optional - only if config exists)
   */
  async checkLint(serverDir) {
    const result = { errors: [], warnings: [] };

    // Check if eslint config exists
    const eslintConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', 'eslint.config.js'];
    const hasEslint = eslintConfigs.some(config => 
      fs.existsSync(path.join(serverDir, config))
    );

    if (!hasEslint) {
      if (this.verbose) console.log('⊘ ESLint skipped (no config)');
      return result;
    }

    try {
      const output = execSync('npx eslint src/ --format json', {
        cwd: serverDir,
        stdio: 'pipe',
        timeout: 30000
      });

      const lintResults = JSON.parse(output.toString());
      
      for (const file of lintResults) {
        for (const msg of file.messages) {
          const entry = {
            type: 'lint',
            file: path.relative(serverDir, file.filePath),
            line: msg.line,
            message: msg.message,
            rule: msg.ruleId
          };

          if (msg.severity === 2) {
            result.errors.push(entry);
          } else {
            result.warnings.push(entry);
          }
        }
      }

      if (this.verbose) console.log('✓ ESLint check passed');
    } catch (error) {
      // ESLint returns non-zero on lint errors
      try {
        const output = error.stdout?.toString() || '';
        if (output.startsWith('[')) {
          const lintResults = JSON.parse(output);
          for (const file of lintResults) {
            for (const msg of file.messages) {
              const entry = {
                type: 'lint',
                file: path.relative(serverDir, file.filePath),
                line: msg.line,
                message: msg.message,
                rule: msg.ruleId
              };
              if (msg.severity === 2) {
                result.errors.push(entry);
              } else {
                result.warnings.push(entry);
              }
            }
          }
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    return result;
  }


  /**
   * MCP Protocol compliance check
   */
  async checkProtocol(serverDir) {
    const result = { compliant: true, issues: [] };
    
    const srcDir = path.join(serverDir, 'src');
    const indexPath = path.join(srcDir, 'index.ts');

    if (!fs.existsSync(indexPath)) {
      result.compliant = false;
      result.issues.push('Missing src/index.ts');
      return result;
    }

    const content = fs.readFileSync(indexPath, 'utf8');

    // Check for ListToolsRequestSchema handler
    if (!content.includes('ListToolsRequestSchema')) {
      result.compliant = false;
      result.issues.push('Missing ListToolsRequestSchema handler');
    }

    // Check for CallToolRequestSchema handler
    if (!content.includes('CallToolRequestSchema')) {
      result.compliant = false;
      result.issues.push('Missing CallToolRequestSchema handler');
    }

    // Extract tool names from ListTools handler
    const listToolsMatch = content.match(/tools:\s*\[([\s\S]*?)\]/);
    const definedTools = new Set();
    
    if (listToolsMatch) {
      const toolNameRegex = /name:\s*['"]([^'"]+)['"]/g;
      let match;
      while ((match = toolNameRegex.exec(listToolsMatch[1])) !== null) {
        definedTools.add(match[1]);
      }
    }

    // Extract tool names from CallTool switch/if statements
    const handledTools = new Set();
    const switchCaseRegex = /case\s*['"]([^'"]+)['"]\s*:/g;
    let match;
    while ((match = switchCaseRegex.exec(content)) !== null) {
      handledTools.add(match[1]);
    }

    // Also check for if-else pattern
    const ifToolRegex = /request\.params\.name\s*===?\s*['"]([^'"]+)['"]/g;
    while ((match = ifToolRegex.exec(content)) !== null) {
      handledTools.add(match[1]);
    }

    // Compare defined vs handled tools
    for (const tool of definedTools) {
      if (!handledTools.has(tool)) {
        result.compliant = false;
        result.issues.push(`Missing tool handler for '${tool}'`);
      }
    }

    for (const tool of handledTools) {
      if (!definedTools.has(tool) && tool !== 'default') {
        result.issues.push(`Handler for undeclared tool '${tool}'`);
      }
    }

    // Check inputSchema structure
    const inputSchemaRegex = /inputSchema:\s*\{([\s\S]*?)(?=\},?\s*\n)/g;
    while ((match = inputSchemaRegex.exec(content)) !== null) {
      const schema = match[1];
      if (!schema.includes('type:') && !schema.includes('"type"')) {
        result.issues.push('inputSchema missing "type" property');
      }
    }

    // Check for server.connect call
    if (!content.includes('server.connect') && !content.includes('.run(')) {
      result.compliant = false;
      result.issues.push('Missing server connection/run call');
    }

    if (this.verbose && result.compliant) {
      console.log('✓ MCP Protocol compliance passed');
    }

    return result;
  }

  /**
   * Dependency check
   */
  async checkDependencies(serverDir) {
    const result = { valid: true, missing: [], warnings: [] };
    
    const pkgPath = path.join(serverDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      result.valid = false;
      result.missing.push('package.json');
      return result;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Required dependencies
    const required = ['@modelcontextprotocol/sdk', 'zod'];
    for (const dep of required) {
      if (!deps[dep]) {
        result.valid = false;
        result.missing.push(dep);
      }
    }

    // Check TypeScript in devDependencies
    if (!deps['typescript']) {
      result.warnings.push({
        type: 'dependency',
        message: 'typescript not in devDependencies'
      });
    }

    // Check node engine version
    if (pkg.engines?.node) {
      const nodeVersion = pkg.engines.node;
      // Warn if requiring very old Node
      if (nodeVersion.match(/^(\d+)/) && parseInt(RegExp.$1) < 18) {
        result.warnings.push({
          type: 'compatibility',
          message: `Node version ${nodeVersion} may be too old for MCP SDK`
        });
      }
    }

    if (this.verbose && result.valid) {
      console.log('✓ Dependency check passed');
    }

    return result;
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
MCP Factory Validator

Usage: node validator.js <server-directory> [options]

Options:
  --verbose, -v    Show detailed output
  --json           Output as JSON
  --help           Show this help

Example:
  node validator.js /opt/mcp-factory/output/mcp-weather --verbose
`);
    process.exit(0);
  }

  const serverDir = args[0];
  const verbose = args.includes('--verbose') || args.includes('-v');
  const jsonOutput = args.includes('--json');

  const validator = new MCPValidator({ verbose });
  
  try {
    const result = await validator.validate(serverDir);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('\n' + '='.repeat(50));
      console.log(`Validation Results: ${serverDir}`);
      console.log('='.repeat(50));

      if (result.valid) {
        console.log('\n✅ Validation PASSED\n');
      } else {
        console.log('\n❌ Validation FAILED\n');
        console.log('Errors:');
        for (const err of result.errors) {
          if (err.file && err.line) {
            console.log(`  • [${err.type}] ${err.file}:${err.line} - ${err.message}`);
          } else if (err.issue) {
            console.log(`  • [${err.type}] ${err.issue}`);
          } else {
            console.log(`  • [${err.type}] ${err.message}`);
          }
        }
      }

      if (result.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const warn of result.warnings) {
          if (warn.file) {
            console.log(`  ⚠ [${warn.type}] ${warn.file}:${warn.line} - ${warn.message}`);
          } else {
            console.log(`  ⚠ [${warn.type}] ${warn.message}`);
          }
        }
      }

      console.log('\nSummary:');
      console.log(`  Errors:   ${result.errors.length}`);
      console.log(`  Warnings: ${result.warnings.length}`);
      console.log('');
    }

    process.exit(result.valid ? 0 : 1);
  } catch (error) {
    console.error('Validation error:', error.message);
    process.exit(2);
  }
}

// Export for programmatic use
module.exports = { MCPValidator };

// Run if called directly
if (require.main === module) {
  main();
}
