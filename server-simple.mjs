#!/usr/bin/env node

/**
 * MCP SSH Agent - A Model Context Protocol server for managing SSH connections
 * 
 * This is a simplified implementation that directly imports from specific files
 * to avoid module resolution issues.
 */

// Import required Node.js modules
import { homedir } from 'os';
import { readFile } from 'fs/promises';
import { join, resolve as resolvePath, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Use createRequire to work around ESM import issues
const require = createRequire(import.meta.url);

// Required libraries
const { spawn, exec, execFile } = require('child_process');
const { promisify } = require('util');
const sshConfig = require('ssh-config');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Silent mode for MCP clients - disable debug output when used as MCP server
const SILENT_MODE = process.env.MCP_SILENT === 'true' || process.argv.includes('--silent');

function getCliArgValue(flagName) {
  const argv = process.argv;

  // Supports:
  //   --flag value
  //   --flag=value
  //   --flagValue is NOT supported intentionally
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === flagName) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${flagName}`);
      }
      return value;
    }
    if (arg.startsWith(flagName + '=')) {
      const value = arg.slice(flagName.length + 1);
      if (!value) {
        throw new Error(`Missing value for ${flagName}`);
      }
      return value;
    }
  }

  return null;
}

function expandUserPath(maybePath) {
  if (!maybePath) return maybePath;
  if (maybePath === '~') return homedir();
  if (maybePath.startsWith('~/')) {
    return join(homedir(), maybePath.slice(2));
  }
  return maybePath;
}

function resolveSshConfigPath() {
  // Precedence: CLI flag > env var > default
  const cliValue = getCliArgValue('--ssh-config');
  const envValue = process.env.SSH_CONFIG_PATH;
  const rawValue = cliValue || envValue;

  if (!rawValue) {
    return join(homedir(), '.ssh', 'config');
  }

  const expanded = expandUserPath(rawValue);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(process.cwd(), expanded);
}

function resolveSshGroupsPath(sshConfigPath) {
  // Precedence: CLI flag > env var > default next to config
  const cliValue = getCliArgValue('--ssh-groups');
  const envValue = process.env.SSH_GROUPS_PATH;
  const rawValue = cliValue || envValue;

  if (!rawValue) {
    return `${sshConfigPath}.groups.json`;
  }

  const expanded = expandUserPath(rawValue);
  if (isAbsolute(expanded)) {
    return expanded;
  }
  return resolvePath(process.cwd(), expanded);
}

async function loadGroupsFile(groupsPath) {
  try {
    const content = await readFile(groupsPath, 'utf-8');
    const parsed = JSON.parse(content);

    // Expected format: { "group-name": ["host1", "host2"] }
    const groups = {};
    if (parsed && typeof parsed === 'object') {
      for (const [groupName, hosts] of Object.entries(parsed)) {
        if (!Array.isArray(hosts)) continue;
        groups[groupName] = hosts.filter(h => typeof h === 'string' && h.trim() !== '');
      }
    }
    return groups;
  } catch (error) {
    // Missing or invalid file should not break the server
    debugLog(`Groups file not loaded (${groupsPath}): ${error.message}\n`);
    return {};
  }
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const concurrency = Math.max(1, Math.floor(limit || 1));

  async function runner() {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const runners = [];
  const runnerCount = Math.min(concurrency, items.length);
  for (let i = 0; i < runnerCount; i++) runners.push(runner());
  await Promise.all(runners);
  return results;
}

// Debug logging function - only outputs in non-silent mode
function debugLog(message) {
  if (!SILENT_MODE) {
    process.stderr.write(message);
  }
}

// Import MCP components using proper export paths
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// SSH Configuration Parser
class SSHConfigParser {
  constructor(configPath) {
    const homeDir = homedir();
    this.configPath = configPath || join(homeDir, '.ssh', 'config');
    this.knownHostsPath = join(homeDir, '.ssh', 'known_hosts');
    this.lastError = null; // Store last error for diagnostics
  }

  async parseConfig() {
    const { existsSync } = require('fs');
    this.lastError = null;
    
    // Check if file exists first
    if (!existsSync(this.configPath)) {
      debugLog(`SSH config file not found: ${this.configPath} (this is normal if you don't have one)\n`);
      return [];
    }
    
    try {
      const content = await readFile(this.configPath, 'utf-8');
      const config = sshConfig.parse(content);
      return this.extractHostsFromConfig(config, this.configPath);
    } catch (error) {
      // Distinguish between different error types
      if (error.code === 'EACCES') {
        this.lastError = { type: 'permission', message: `Permission denied reading SSH config: ${this.configPath}` };
        debugLog(`[WARNING] ${this.lastError.message}\n`);
      } else if (error.name === 'SyntaxError' || error.message.includes('parse')) {
        this.lastError = { type: 'parse', message: `SSH config syntax error in ${this.configPath}: ${error.message}` };
        debugLog(`[WARNING] ${this.lastError.message}\n`);
      } else {
        this.lastError = { type: 'unknown', message: `Error reading SSH config: ${error.message}` };
        debugLog(`[WARNING] ${this.lastError.message}\n`);
      }
      return [];
    }
  }

  async processIncludeDirectives(configPath) {
    const { existsSync } = require('fs');
    
    // Check if file exists first
    if (!existsSync(configPath)) {
      if (configPath === this.configPath) {
        debugLog(`SSH config file not found: ${configPath} (this is normal if you don't have one)\n`);
      }
      return [];
    }
    
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = sshConfig.parse(content);
      const hosts = [];
      
      for (const section of config) {
        if (section.param === 'Include' && section.value) {
          const includePaths = this.expandIncludePath(section.value, configPath);
          
          for (const includePath of includePaths) {
            try {
              const includeHosts = await this.processIncludeDirectives(includePath);
              hosts.push(...includeHosts);
            } catch (error) {
              debugLog(`Error processing include file ${includePath}: ${error.message}\n`);
            }
          }
        }
      }
      
      // Add hosts from the current config file
      const currentHosts = this.extractHostsFromConfig(config, configPath);
      hosts.push(...currentHosts);
      
      return hosts;
    } catch (error) {
      // Provide more specific error messages
      if (error.code === 'EACCES') {
        debugLog(`[WARNING] Permission denied reading config file: ${configPath}\n`);
      } else if (error.name === 'SyntaxError' || error.message.includes('parse')) {
        debugLog(`[WARNING] Syntax error in SSH config file ${configPath}: ${error.message}\n`);
      } else {
        debugLog(`[WARNING] Error processing config file ${configPath}: ${error.message}\n`);
      }
      return [];
    }
  }

  expandIncludePath(includePath, baseConfigPath) {
    const { dirname, resolve } = require('path');
    const { glob } = require('glob');
    const { existsSync } = require('fs');
    
    // Handle tilde expansion
    if (includePath.startsWith('~/')) {
      includePath = includePath.replace('~', homedir());
    }
    
    // Handle relative paths
    if (!includePath.startsWith('/')) {
      const baseDir = dirname(baseConfigPath);
      includePath = resolve(baseDir, includePath);
    }
    
    try {
      // Handle glob patterns
      if (includePath.includes('*') || includePath.includes('?')) {
        return glob.sync(includePath).filter(path => existsSync(path));
      } else {
        return existsSync(includePath) ? [includePath] : [];
      }
    } catch (error) {
      debugLog(`Error expanding include path ${includePath}: ${error.message}\n`);
      return [];
    }
  }

  extractHostsFromConfig(config, configPath) {
    const hosts = [];

    for (const section of config) {
      // Skip Include directives as they are processed separately
      if (section.param === 'Include') {
        continue;
      }
      
      if (section.param === 'Host' && section.value !== '*') {
        const hostInfo = {
          hostname: '',
          alias: section.value,
          configFile: configPath
        };

        // Search all entries for this host
        for (const param of section.config) {
          // Safety check for undefined param
          if (!param || !param.param) {
            continue;
          }
          
          switch (param.param.toLowerCase()) {
            case 'hostname':
              hostInfo.hostname = param.value;
              break;
            case 'user':
              hostInfo.user = param.value;
              break;
            case 'port':
              hostInfo.port = parseInt(param.value, 10);
              break;
            case 'identityfile':
              hostInfo.identityFile = param.value;
              break;
            default:
              // Store other parameters
              hostInfo[param.param.toLowerCase()] = param.value;
          }
        }

        // Only add hosts with complete information
        if (hostInfo.hostname) {
          hosts.push(hostInfo);
        }
      }
    }

    return hosts;
  }

  async parseKnownHosts() {
    const { existsSync } = require('fs');
    
    // Check if file exists first
    if (!existsSync(this.knownHostsPath)) {
      debugLog(`known_hosts file not found: ${this.knownHostsPath} (this is normal for new systems)\n`);
      return [];
    }
    
    try {
      const content = await readFile(this.knownHostsPath, 'utf-8');
      const knownHosts = content
        .split('\n')
        .filter(line => line.trim() !== '' && !line.startsWith('#')) // Skip empty lines and comments
        .map(line => {
          // Format: hostname[,hostname2...] key-type public-key
          const parts = line.split(' ')[0];
          return parts.split(',')[0];
        })
        .filter(host => host); // Remove any empty entries

      return knownHosts;
    } catch (error) {
      if (error.code === 'EACCES') {
        debugLog(`[WARNING] Permission denied reading known_hosts: ${this.knownHostsPath}\n`);
      } else {
        debugLog(`[WARNING] Error reading known_hosts file: ${error.message}\n`);
      }
      return [];
    }
  }

  async getAllKnownHosts() {
    // First: Get all hosts from ~/.ssh/config including Include directives (these are prioritized)
    const configHosts = await this.processIncludeDirectives(this.configPath);
    
    // Second: Get hostnames from ~/.ssh/known_hosts
    const knownHostnames = await this.parseKnownHosts();

    // Create a comprehensive list starting with config hosts
    const allHosts = [...configHosts];

    // Add hosts from known_hosts that aren't already in the config
    // These will appear after the config hosts
    for (const hostname of knownHostnames) {
      if (!configHosts.some(host => 
          host.hostname === hostname || 
          host.alias === hostname)) {
        allHosts.push({
          hostname: hostname,
          source: 'known_hosts'
        });
      }
    }

    // Mark config hosts for clarity
    configHosts.forEach(host => {
      host.source = 'ssh_config';
    });

    return allHosts;
  }
}

// SSH Client Implementation
class SSHClient {
  constructor(options = {}) {
    this.configParser = new SSHConfigParser(options.configPath);
    this.groupsPath = options.groupsPath;
    this.groups = options.groups || {};
  }

  async reloadGroups() {
    if (!this.groupsPath) {
      this.groups = {};
      return this.groups;
    }
    this.groups = await loadGroupsFile(this.groupsPath);
    return this.groups;
  }

  async listHostGroups() {
    // Always attempt to refresh so edits take effect without restart
    await this.reloadGroups();
    return this.groups;
  }

  async runBatchCommand(hosts, command, options = {}) {
    const hostList = uniqueStrings(hosts || []);
    if (hostList.length === 0) {
      return {
        results: [],
        success: false,
        message: 'No hosts provided'
      };
    }
    if (typeof command !== 'string' || command.trim() === '') {
      return {
        results: [],
        success: false,
        message: 'No command provided'
      };
    }

    const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 5;
    const perHostTimeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;

    const results = await runWithConcurrency(hostList, concurrency, async (hostAlias) => {
      const result = await this.runRemoteCommand(hostAlias, command);
      return {
        host: hostAlias,
        ...result
      };
    });

    const success = results.every(r => r && r.code === 0);
    return {
      results,
      success
    };
  }

  async runGroupCommand(group, command, options = {}) {
    await this.reloadGroups();
    const groupName = typeof group === 'string' ? group.trim() : '';
    if (!groupName) {
      return { results: [], success: false, message: 'No group provided' };
    }
    const hosts = this.groups[groupName] || [];
    if (!Array.isArray(hosts) || hosts.length === 0) {
      return { results: [], success: false, message: `Group not found or empty: ${groupName}` };
    }
    return await this.runBatchCommand(hosts, command, options);
  }

  async listKnownHosts() {
    return await this.configParser.getAllKnownHosts();
  }

  async runRemoteCommand(hostAlias, command) {
    try {
      // Use execFile for security - prevents command injection
      debugLog(`Executing: ssh ${hostAlias} ${command}\n`);
      
      const { stdout, stderr } = await execFileAsync('ssh', [hostAlias, command], {
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      });
      
      return {
        stdout: stdout || '',
        stderr: stderr || '',
        code: 0
      };
    } catch (error) {
      debugLog(`Error executing command on ${hostAlias}: ${error.message}\n`);
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        code: error.code || 1
      };
    }
  }

  async getHostInfo(hostAlias) {
    const hosts = await this.configParser.processIncludeDirectives(this.configParser.configPath);
    return hosts.find(host => host.alias === hostAlias || host.hostname === hostAlias) || null;
  }

  async checkConnectivity(hostAlias) {
    try {
      // Simple connectivity test using ssh
      const result = await this.runRemoteCommand(hostAlias, 'echo connected');
      const connected = result.code === 0 && result.stdout.trim() === 'connected';
      
      return {
        connected,
        message: connected ? 'Connection successful' : 'Connection failed'
      };
    } catch (error) {
      debugLog(`Connectivity error with ${hostAlias}: ${error.message}\n`);
      return {
        connected: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async uploadFile(hostAlias, localPath, remotePath) {
    try {
      debugLog(`Executing: scp ${localPath} ${hostAlias}:${remotePath}\n`);
      
      await execFileAsync('scp', [localPath, `${hostAlias}:${remotePath}`], { 
        timeout: 60000 // 60 second timeout for file transfer
      });
      return true;
    } catch (error) {
      debugLog(`Error uploading file to ${hostAlias}: ${error.message}\n`);
      return false;
    }
  }

  async downloadFile(hostAlias, remotePath, localPath) {
    try {
      debugLog(`Executing: scp ${hostAlias}:${remotePath} ${localPath}\n`);
      
      await execFileAsync('scp', [`${hostAlias}:${remotePath}`, localPath], { 
        timeout: 60000 // 60 second timeout for file transfer
      });
      return true;
    } catch (error) {
      debugLog(`Error downloading file from ${hostAlias}: ${error.message}\n`);
      return false;
    }
  }

  /**
   * Sync a local file to multiple remote hosts
   * Supports both scp and rsync modes
   */
  async syncFile(localPath, remotePath, hosts, options = {}) {
    const hostList = uniqueStrings(hosts || []);
    if (hostList.length === 0) {
      return {
        results: [],
        success: false,
        message: 'No hosts provided'
      };
    }
    if (!localPath || typeof localPath !== 'string') {
      return {
        results: [],
        success: false,
        message: 'No local path provided'
      };
    }
    if (!remotePath || typeof remotePath !== 'string') {
      return {
        results: [],
        success: false,
        message: 'No remote path provided'
      };
    }

    const useRsync = options.useRsync === true;
    const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 5;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000; // 2 min default for file sync

    const results = await runWithConcurrency(hostList, concurrency, async (hostAlias) => {
      try {
        if (useRsync) {
          // rsync mode: -avz for archive, verbose, compress
          const rsyncArgs = ['-avz', '--progress'];
          if (options.delete) {
            rsyncArgs.push('--delete');
          }
          rsyncArgs.push(localPath, `${hostAlias}:${remotePath}`);
          
          debugLog(`Executing: rsync ${rsyncArgs.join(' ')}\n`);
          const { stdout, stderr } = await execFileAsync('rsync', rsyncArgs, { timeout: timeoutMs });
          return {
            host: hostAlias,
            success: true,
            stdout: stdout || '',
            stderr: stderr || ''
          };
        } else {
          // scp mode
          debugLog(`Executing: scp ${localPath} ${hostAlias}:${remotePath}\n`);
          const { stdout, stderr } = await execFileAsync('scp', ['-r', localPath, `${hostAlias}:${remotePath}`], { timeout: timeoutMs });
          return {
            host: hostAlias,
            success: true,
            stdout: stdout || '',
            stderr: stderr || ''
          };
        }
      } catch (error) {
        debugLog(`Error syncing file to ${hostAlias}: ${error.message}\n`);
        return {
          host: hostAlias,
          success: false,
          error: error.message,
          stdout: error.stdout || '',
          stderr: error.stderr || ''
        };
      }
    });

    const allSuccess = results.every(r => r && r.success);
    return {
      results,
      success: allSuccess,
      successCount: results.filter(r => r && r.success).length,
      failCount: results.filter(r => r && !r.success).length
    };
  }

  /**
   * Sync a local file to all hosts in a group
   */
  async syncFileToGroup(localPath, remotePath, group, options = {}) {
    await this.reloadGroups();
    const groupName = typeof group === 'string' ? group.trim() : '';
    if (!groupName) {
      return { results: [], success: false, message: 'No group provided' };
    }
    const hosts = this.groups[groupName] || [];
    if (!Array.isArray(hosts) || hosts.length === 0) {
      return { results: [], success: false, message: `Group not found or empty: ${groupName}` };
    }
    return await this.syncFile(localPath, remotePath, hosts, options);
  }

  async runCommandBatch(hostAlias, commands) {
    try {
      const results = [];
      let success = true;
      
      for (const command of commands) {
        const result = await this.runRemoteCommand(hostAlias, command);
        results.push(result);
        
        if (result.code !== 0) {
          success = false;
          // Continue executing remaining commands
        }
      }
      
      return {
        results,
        success
      };
    } catch (error) {
      debugLog(`Error during batch execution on ${hostAlias}: ${error.message}\n`);
      return {
        results: [{
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          code: 1
        }],
        success: false
      };
    }
  }
}

// Main function to start the MCP server
async function main() {
  try {
    // Create an instance of the SSH client
    debugLog("Initializing SSH client...\n");
    const sshConfigPath = resolveSshConfigPath();
    const sshGroupsPath = resolveSshGroupsPath(sshConfigPath);
    debugLog(`Using SSH config: ${sshConfigPath}\n`);
    debugLog(`Using groups file: ${sshGroupsPath}\n`);

    const initialGroups = await loadGroupsFile(sshGroupsPath);
    const sshClient = new SSHClient({
      configPath: sshConfigPath,
      groupsPath: sshGroupsPath,
      groups: initialGroups
    });

    debugLog("Creating MCP server...\n");
    // Create an MCP server
    const server = new Server(
      { name: "mcp-ssh", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    debugLog("Setting up request handlers...\n");
    // Handler for listing available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      debugLog("Received listTools request\n");
      return {
        tools: [
          {
            name: "listKnownHosts",
            description: "Returns a consolidated list of all known SSH hosts, prioritizing SSH config entries first (default ~/.ssh/config, overridable via --ssh-config or SSH_CONFIG_PATH), then additional hosts from ~/.ssh/known_hosts",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "runRemoteCommand",
            description: "Executes a shell command on an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
                command: {
                  type: "string",
                  description: "The shell command to execute",
                },
              },
              required: ["hostAlias", "command"],
            },
          },
          {
            name: "getHostInfo",
            description: "Returns all configuration details for an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
              },
              required: ["hostAlias"],
            },
          },
          {
            name: "checkConnectivity",
            description: "Checks if an SSH connection to the host is possible",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
              },
              required: ["hostAlias"],
            },
          },
          {
            name: "uploadFile",
            description: "Uploads a local file to an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
                localPath: {
                  type: "string",
                  description: "Path to the local file",
                },
                remotePath: {
                  type: "string",
                  description: "Path on the remote host",
                },
              },
              required: ["hostAlias", "localPath", "remotePath"],
            },
          },
          {
            name: "downloadFile",
            description: "Downloads a file from an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
                remotePath: {
                  type: "string",
                  description: "Path on the remote host",
                },
                localPath: {
                  type: "string",
                  description: "Path to the local destination",
                },
              },
              required: ["hostAlias", "remotePath", "localPath"],
            },
          },
          {
            name: "runCommandBatch",
            description: "Executes multiple shell commands sequentially on an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
                commands: {
                  type: "array",
                  items: { type: "string" },
                  description: "List of shell commands to execute",
                },
              },
              required: ["hostAlias", "commands"],
            },
          },
          {
            name: "runBatchCommand",
            description: "Executes the same shell command across multiple SSH hosts and returns aggregated results",
            inputSchema: {
              type: "object",
              properties: {
                hosts: {
                  type: "array",
                  items: { type: "string" },
                  description: "List of SSH host aliases",
                },
                command: {
                  type: "string",
                  description: "The shell command to execute on each host",
                },
                concurrency: {
                  type: "number",
                  description: "Max number of hosts to run in parallel (default: 5)",
                },
                timeoutMs: {
                  type: "number",
                  description: "Per-host SSH command timeout in ms (default: 30000)",
                },
              },
              required: ["hosts", "command"],
            },
          },
          {
            name: "listHostGroups",
            description: "Lists host groups loaded from the groups JSON file (default: <ssh-config>.groups.json; overridable via --ssh-groups or SSH_GROUPS_PATH)",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "runGroupCommand",
            description: "Executes a shell command across all hosts in a named group",
            inputSchema: {
              type: "object",
              properties: {
                group: {
                  type: "string",
                  description: "Group name from the groups file",
                },
                command: {
                  type: "string",
                  description: "The shell command to execute on each host in the group",
                },
                concurrency: {
                  type: "number",
                  description: "Max number of hosts to run in parallel (default: 5)",
                },
                timeoutMs: {
                  type: "number",
                  description: "Per-host SSH command timeout in ms (default: 30000)",
                },
              },
              required: ["group", "command"],
            },
          },
          {
            name: "syncFile",
            description: "Sync a local file or directory to multiple remote SSH hosts (supports scp or rsync)",
            inputSchema: {
              type: "object",
              properties: {
                localPath: {
                  type: "string",
                  description: "Path to the local file or directory to sync",
                },
                remotePath: {
                  type: "string",
                  description: "Destination path on the remote hosts",
                },
                hosts: {
                  type: "array",
                  items: { type: "string" },
                  description: "List of SSH host aliases to sync to",
                },
                useRsync: {
                  type: "boolean",
                  description: "Use rsync instead of scp (default: false)",
                },
                delete: {
                  type: "boolean",
                  description: "When using rsync, delete files on remote that don't exist locally (default: false)",
                },
                concurrency: {
                  type: "number",
                  description: "Max number of hosts to sync in parallel (default: 5)",
                },
                timeoutMs: {
                  type: "number",
                  description: "Per-host sync timeout in ms (default: 120000)",
                },
              },
              required: ["localPath", "remotePath", "hosts"],
            },
          },
          {
            name: "syncFileToGroup",
            description: "Sync a local file or directory to all hosts in a named group",
            inputSchema: {
              type: "object",
              properties: {
                localPath: {
                  type: "string",
                  description: "Path to the local file or directory to sync",
                },
                remotePath: {
                  type: "string",
                  description: "Destination path on the remote hosts",
                },
                group: {
                  type: "string",
                  description: "Group name from the groups file",
                },
                useRsync: {
                  type: "boolean",
                  description: "Use rsync instead of scp (default: false)",
                },
                delete: {
                  type: "boolean",
                  description: "When using rsync, delete files on remote that don't exist locally (default: false)",
                },
                concurrency: {
                  type: "number",
                  description: "Max number of hosts to sync in parallel (default: 5)",
                },
                timeoutMs: {
                  type: "number",
                  description: "Per-host sync timeout in ms (default: 120000)",
                },
              },
              required: ["localPath", "remotePath", "group"],
            },
          },
        ],
      };
    });

    // Handler for tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      debugLog(`Received callTool request for tool: ${name}\n`);

      if (!args && name !== "listKnownHosts") {
        throw new Error(`No arguments provided for tool: ${name}`);
      }

      try {
        switch (name) {
          case "listKnownHosts": {
            const hosts = await sshClient.listKnownHosts();
            return {
              content: [{ type: "text", text: JSON.stringify(hosts, null, 2) }],
            };
          }

          case "runRemoteCommand": {
            const result = await sshClient.runRemoteCommand(
              args.hostAlias,
              args.command
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          case "getHostInfo": {
            const hostInfo = await sshClient.getHostInfo(args.hostAlias);
            return {
              content: [{ type: "text", text: JSON.stringify(hostInfo, null, 2) }],
            };
          }

          case "checkConnectivity": {
            const status = await sshClient.checkConnectivity(args.hostAlias);
            return {
              content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
            };
          }

          case "uploadFile": {
            const success = await sshClient.uploadFile(
              args.hostAlias,
              args.localPath,
              args.remotePath
            );
            return {
              content: [{ type: "text", text: JSON.stringify({ success }, null, 2) }],
            };
          }

          case "downloadFile": {
            const success = await sshClient.downloadFile(
              args.hostAlias,
              args.remotePath,
              args.localPath
            );
            return {
              content: [{ type: "text", text: JSON.stringify({ success }, null, 2) }],
            };
          }

          case "runCommandBatch": {
            const result = await sshClient.runCommandBatch(
              args.hostAlias,
              args.commands
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          case "runBatchCommand": {
            const result = await sshClient.runBatchCommand(
              args.hosts,
              args.command,
              {
                concurrency: args.concurrency,
                timeoutMs: args.timeoutMs
              }
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          case "listHostGroups": {
            const groups = await sshClient.listHostGroups();
            return {
              content: [{ type: "text", text: JSON.stringify(groups, null, 2) }],
            };
          }

          case "runGroupCommand": {
            const result = await sshClient.runGroupCommand(
              args.group,
              args.command,
              {
                concurrency: args.concurrency,
                timeoutMs: args.timeoutMs
              }
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          case "syncFile": {
            const result = await sshClient.syncFile(
              args.localPath,
              args.remotePath,
              args.hosts,
              {
                useRsync: args.useRsync,
                delete: args.delete,
                concurrency: args.concurrency,
                timeoutMs: args.timeoutMs
              }
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          case "syncFileToGroup": {
            const result = await sshClient.syncFileToGroup(
              args.localPath,
              args.remotePath,
              args.group,
              {
                useRsync: args.useRsync,
                delete: args.delete,
                concurrency: args.concurrency,
                timeoutMs: args.timeoutMs
              }
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        debugLog(`Error executing tool ${name}: ${error.message}\n`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    });

    debugLog("Starting MCP SSH Agent on STDIO...\n");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    debugLog("MCP SSH Agent connected and ready!\n");
    
  } catch (error) {
    debugLog(`Error starting MCP SSH Agent: ${error.message}\n`);
    process.exit(1);
  }
}

// Start the server
main().catch(error => {
  debugLog(`Unhandled error: ${error.message}\n`);
  process.exit(1);
});
