/**
 * MCP Factory Registry
 * SQLite-backed server registry for MCP servers
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class MCPRegistry {
  constructor(dbPath = '/opt/mcp-factory/registry.db') {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        version TEXT NOT NULL,
        description TEXT,
        spec JSON,
        package_path TEXT,
        docker_image TEXT,
        claude_config JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_servers_name ON mcp_servers(name);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_created ON mcp_servers(created_at);
    `);

    console.log(`[Registry] Initialized at ${this.dbPath}`);
    return { success: true, dbPath: this.dbPath };
  }

  generateId() {
    return `mcp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  async register(manifest) {
    if (!this.db) await this.init();

    const {
      name,
      version = '1.0.0',
      description = '',
      spec = {},
      package_path = null,
      docker_image = null,
      claude_config = {}
    } = manifest;

    if (!name) {
      throw new Error('Server name is required');
    }

    const id = this.generateId();
    const now = new Date().toISOString();

    // Check if exists - update or insert
    const existing = this.db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(name);

    if (existing) {
      // Update existing
      const stmt = this.db.prepare(`
        UPDATE mcp_servers SET
          version = ?,
          description = ?,
          spec = ?,
          package_path = ?,
          docker_image = ?,
          claude_config = ?,
          updated_at = ?
        WHERE name = ?
      `);
      stmt.run(
        version,
        description,
        JSON.stringify(spec),
        package_path,
        docker_image,
        JSON.stringify(claude_config),
        now,
        name
      );
      console.log(`[Registry] Updated: ${name}@${version}`);
      return { id: existing.id, name, version, action: 'updated' };
    } else {
      // Insert new
      const stmt = this.db.prepare(`
        INSERT INTO mcp_servers (id, name, version, description, spec, package_path, docker_image, claude_config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        name,
        version,
        description,
        JSON.stringify(spec),
        package_path,
        docker_image,
        JSON.stringify(claude_config),
        now,
        now
      );
      console.log(`[Registry] Registered: ${name}@${version}`);
      return { id, name, version, action: 'created' };
    }
  }

  async get(name, version = null) {
    if (!this.db) await this.init();

    let row;
    if (version) {
      row = this.db.prepare('SELECT * FROM mcp_servers WHERE name = ? AND version = ?').get(name, version);
    } else {
      row = this.db.prepare('SELECT * FROM mcp_servers WHERE name = ? ORDER BY updated_at DESC LIMIT 1').get(name);
    }

    if (!row) return null;

    return this.parseRow(row);
  }

  async list(filter = {}) {
    if (!this.db) await this.init();

    let sql = 'SELECT * FROM mcp_servers';
    const params = [];
    const conditions = [];

    if (filter.name) {
      conditions.push('name LIKE ?');
      params.push(`%${filter.name}%`);
    }

    if (filter.version) {
      conditions.push('version = ?');
      params.push(filter.version);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY updated_at DESC';

    if (filter.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }

    const rows = this.db.prepare(sql).all(...params);
    return rows.map(row => this.parseRow(row));
  }

  async remove(name) {
    if (!this.db) await this.init();

    const existing = this.db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(name);
    if (!existing) {
      return { removed: false, reason: 'not_found' };
    }

    this.db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name);
    console.log(`[Registry] Removed: ${name}`);
    return { removed: true, name };
  }

  parseRow(row) {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description,
      spec: JSON.parse(row.spec || '{}'),
      package_path: row.package_path,
      docker_image: row.docker_image,
      claude_config: JSON.parse(row.claude_config || '{}'),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const registry = new MCPRegistry();

  try {
    await registry.init();

    switch (command) {
      case 'register': {
        const manifestPath = args[1];
        if (!manifestPath) {
          console.error('Usage: node registry.js register <manifest.json>');
          process.exit(1);
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const result = await registry.register(manifest);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'get': {
        const name = args[1];
        const version = args[2];
        if (!name) {
          console.error('Usage: node registry.js get <name> [version]');
          process.exit(1);
        }
        const server = await registry.get(name, version);
        if (server) {
          console.log(JSON.stringify(server, null, 2));
        } else {
          console.log(`Server '${name}' not found`);
          process.exit(1);
        }
        break;
      }

      case 'list': {
        const filter = {};
        if (args[1]) filter.name = args[1];
        const servers = await registry.list(filter);
        console.log(JSON.stringify(servers, null, 2));
        break;
      }

      case 'remove': {
        const name = args[1];
        if (!name) {
          console.error('Usage: node registry.js remove <name>');
          process.exit(1);
        }
        const result = await registry.remove(name);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        console.log(`
MCP Factory Registry CLI

Commands:
  register <manifest.json>  Register/update an MCP server
  get <name> [version]      Get server details
  list [name_filter]        List all servers
  remove <name>             Remove a server

Examples:
  node registry.js register /opt/mcp-factory/output/mcp-weather/manifest.json
  node registry.js get mcp-weather
  node registry.js list
  node registry.js list weather
  node registry.js remove mcp-weather
        `);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await registry.close();
  }
}

// Export for programmatic use
module.exports = { MCPRegistry };

// Run CLI if executed directly
if (require.main === module) {
  main();
}
