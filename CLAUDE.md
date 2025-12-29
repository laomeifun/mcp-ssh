# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is MCP SSH Agent (@laomeifun/mcp-ssh) - a Model Context Protocol (MCP) server that provides SSH operations for AI assistants like Claude Desktop. The project uses native SSH commands (`ssh`, `scp`) rather than JavaScript SSH libraries for maximum reliability and compatibility.

## Development Commands

### Basic Operations
- `npm start` - Start the MCP server (same as `npm run dev`)
- `npm run dev` - Start the MCP server with debug output
- `npm run build` - Currently a no-op (echo "Build skipped")
- `npm test` - Currently a no-op (echo "No tests specified")

### Development Scripts
- `./start.sh` - Start the server with debug output
- `./start-silent.sh` - Start the server in silent mode (no debug output)
- `node server-simple.mjs` - Direct server execution

### Publishing
- `npm version patch|minor|major` - Bump version and create git tag
- `npm publish` - Publish to npm (see PUBLISHING.md for details)
- `npm pack` - Create tarball for testing

### DXT Package Building
- `npm run build:dxt` - Build Desktop Extension (.dxt) package
- `./scripts/build-dxt.sh` - Direct build script execution

## Architecture

### Main Entry Point
- `server-simple.mjs` - Self-contained MCP server implementation that includes all functionality inline to avoid module resolution issues

### Source Structure (Development)
- `src/` - TypeScript source files (currently not compiled/used in production)
  - `ssh-client.ts` - SSH operations using node-ssh library (development version)
  - `ssh-config-parser.ts` - SSH config parsing utilities
  - `types.ts` - TypeScript type definitions
- `bin/mcp-ssh.js` - Binary wrapper for npx compatibility

### Key Design Decisions
1. **Native SSH Tools**: Uses system `ssh` and `scp` commands rather than JavaScript SSH libraries for reliability
2. **Self-contained**: `server-simple.mjs` includes all code inline to avoid ESM import issues
3. **Dual Implementation**: TypeScript source in `src/` for development, JavaScript implementation in `server-simple.mjs` for production
4. **Silent Mode**: Controlled by `MCP_SILENT` environment variable to disable debug output when used as MCP server

## SSH Configuration Integration

The agent automatically discovers SSH hosts from:
- `~/.ssh/config` - Primary source for host configurations
- `~/.ssh/known_hosts` - Additional hosts not in config

Host discovery prioritizes SSH config entries first, then adds additional hosts from known_hosts.

## MCP Tools Provided

1. **listKnownHosts()** - Lists all discovered SSH hosts
2. **runRemoteCommand(hostAlias, command)** - Execute commands via SSH
3. **getHostInfo(hostAlias)** - Get host configuration details
4. **checkConnectivity(hostAlias)** - Test SSH connectivity
5. **uploadFile(hostAlias, localPath, remotePath)** - Upload files via SCP
6. **downloadFile(hostAlias, remotePath, localPath)** - Download files via SCP
7. **runCommandBatch(hostAlias, commands)** - Execute multiple commands sequentially

## Testing and Debugging

### Manual Testing
```bash
# Test as MCP server
npx @laomeifun/mcp-ssh

# Test with debug output
MCP_SILENT=false npx @laomeifun/mcp-ssh

# Test installation
npm pack
npm install -g ./laomeifun-mcp-ssh-*.tgz
mcp-ssh
```

### Integration Testing
Configure in Claude Desktop's `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mcp-ssh": {
      "command": "npx",
      "args": ["@laomeifun/mcp-ssh"]
    }
  }
}
```

## Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `ssh-config` - SSH configuration file parsing
- Node.js built-ins: `child_process`, `fs/promises`, `os`, `path`

## Desktop Extension Support

The project supports Desktop Extensions (.dxt) for easy installation in Claude Desktop:

- `manifest.json` - DXT package manifest with server configuration
- `scripts/build-dxt.sh` - Build script that creates .dxt packages in `build/` directory
- `.dxt` files are ZIP archives containing the manifest and server files
- Built packages are excluded from git via `.gitignore` but can be uploaded to GitHub releases

## Important Notes

- The project is ESM-only (`"type": "module"` in package.json)
- Production code is in `server-simple.mjs`, not compiled from TypeScript
- SSH operations require properly configured SSH keys and host access
- The agent runs over STDIO as an MCP server, not as a standalone application
- DXT packages provide one-click installation alternative to manual JSON configuration