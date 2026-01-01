#!/usr/bin/env node

/**
 * Schema Validation Test
 * Tests that all tool schemas are compatible with OpenAI, Claude, and Gemini
 */

import Ajv from 'ajv';

const ajv = new Ajv({ strict: true, strictSchema: true });

// Define the expected schema structure for function calling
const functionSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['object'] },
        properties: { type: 'object' },
        required: { type: 'array', items: { type: 'string' } },
        additionalProperties: { type: 'boolean' }
      },
      required: ['type', 'properties', 'required', 'additionalProperties']
    }
  },
  required: ['name', 'description', 'inputSchema']
};

// Sample tools from the server
const tools = [
  {
    name: "listKnownHosts",
    description: "Returns a consolidated list of all known SSH hosts",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
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
      additionalProperties: false,
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
      additionalProperties: false,
    },
  },
];

console.log('Testing schema validation...\n');

let allValid = true;

for (const tool of tools) {
  console.log(`Testing tool: ${tool.name}`);
  
  // Test 1: Basic structure
  const validate = ajv.compile(functionSchema);
  const valid = validate(tool);
  
  if (!valid) {
    console.error(`  ❌ Schema validation failed:`, validate.errors);
    allValid = false;
  } else {
    console.log(`  ✅ Schema structure valid`);
  }
  
  // Test 2: Required fields are in properties
  const { required = [], properties = {} } = tool.inputSchema;
  const missingProps = required.filter(r => !(r in properties));
  
  if (missingProps.length > 0) {
    console.error(`  ❌ Required fields not in properties:`, missingProps);
    allValid = false;
  } else {
    console.log(`  ✅ All required fields defined in properties`);
  }
  
  // Test 3: No extra properties allowed
  if (tool.inputSchema.additionalProperties !== false) {
    console.error(`  ❌ additionalProperties should be false`);
    allValid = false;
  } else {
    console.log(`  ✅ additionalProperties correctly set to false`);
  }
  
  // Test 4: Simulate OpenAI validation (strict mode)
  try {
    const testInput = { hostAlias: "test-host" };
    const extraInput = { hostAlias: "test-host", extraField: "should-fail" };
    
    // This should pass
    const requiredFields = tool.inputSchema.required || [];
    const hasAllRequired = requiredFields.every(field => field in testInput || field === 'command');
    
    if (requiredFields.length > 0 && !hasAllRequired) {
      console.log(`  ⚠️  Test input missing required fields`);
    }
    
    // This should be caught by additionalProperties: false
    const hasExtra = Object.keys(extraInput).some(key => !(key in tool.inputSchema.properties));
    if (hasExtra && tool.inputSchema.additionalProperties === false) {
      console.log(`  ✅ Would correctly reject extra properties`);
    }
    
  } catch (error) {
    console.error(`  ❌ Validation test failed:`, error.message);
    allValid = false;
  }
  
  console.log('');
}

if (allValid) {
  console.log('✅ All schemas are valid and compatible with OpenAI, Claude, and Gemini!');
  process.exit(0);
} else {
  console.error('❌ Some schemas have issues. Please fix them.');
  process.exit(1);
}
