#!/usr/bin/env node

// Simple wrapper to run the main server-simple.mjs file
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import and run the main module
// Use pathToFileURL to ensure Windows compatibility (converts c:\... to file:///c:/...)
const mainModule = path.join(__dirname, '..', 'server-simple.mjs');
import(pathToFileURL(mainModule).href);
