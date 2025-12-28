#!/bin/bash

# Change to the directory where this script is located
cd "$(dirname "$0")"

# MCP SSH Agent Startup Script
# This script starts the MCP SSH server using npm
# Set MCP_SILENT=true to disable debug output for MCP clients

# Check if we should run in silent mode (for MCP clients)
if [ "$1" = "--silent" ] || [ "$MCP_SILENT" = "true" ]; then
    # Silent mode - no startup messages
    MCP_SILENT=true npm start -- "$@"
else
    # Normal mode with startup messages
    echo "Starting MCP SSH Agent..."
    npm start -- "$@"
fi
