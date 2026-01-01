# MCP Tool Schema 健壮性改进

## 问题描述

在使用 OpenAI 的函数调用时遇到错误:
```
Failed to parse image generation result: [ { "code": "invalid_value", "values": [ "proceed", "generate_image", "edit_image" ], "path": [ "action" ], "message": "Invalid input" } ] 
Received: {"hostAlias":"cachyos-root"}
```

## 根本原因

不同的 AI 提供商对 JSON Schema 的验证严格程度不同:

1. **OpenAI**: 最严格,要求完全符合 JSON Schema 规范
   - 必须有 `additionalProperties: false` 防止额外属性
   - 所有 `required` 字段必须在 `properties` 中定义
   - 不允许未定义的属性

2. **Claude (Anthropic)**: 中等严格,较为宽容

3. **Gemini (Google)**: 相对宽松

## 解决方案

### 1. 添加 `additionalProperties: false`

**修改前:**
```javascript
inputSchema: {
  type: "object",
  properties: {
    hostAlias: {
      type: "string",
      description: "Alias or hostname of the SSH host",
    },
  },
  required: ["hostAlias"],
}
```

**修改后:**
```javascript
inputSchema: {
  type: "object",
  properties: {
    hostAlias: {
      type: "string",
      description: "Alias or hostname of the SSH host",
    },
  },
  required: ["hostAlias"],
  additionalProperties: false,  // ✅ 新增
}
```

### 2. 确保所有工具都有完整的 schema 定义

即使是没有参数的工具,也需要完整的 schema:

```javascript
{
  name: "listKnownHosts",
  description: "Returns a consolidated list of all known SSH hosts",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,  // ✅ 必须
  },
}
```

## 修改的工具列表

所有 12 个工具都已更新:

1. ✅ `listKnownHosts` - 添加 `additionalProperties: false`
2. ✅ `runRemoteCommand` - 添加 `additionalProperties: false`
3. ✅ `getHostInfo` - 添加 `additionalProperties: false`
4. ✅ `checkConnectivity` - 添加 `additionalProperties: false`
5. ✅ `uploadFile` - 添加 `additionalProperties: false`
6. ✅ `downloadFile` - 添加 `additionalProperties: false`
7. ✅ `runCommandBatch` - 添加 `additionalProperties: false`
8. ✅ `runBatchCommand` - 添加 `additionalProperties: false`
9. ✅ `listHostGroups` - 添加 `additionalProperties: false`
10. ✅ `runGroupCommand` - 添加 `additionalProperties: false`
11. ✅ `syncFile` - 添加 `additionalProperties: false`
12. ✅ `syncFileToGroup` - 添加 `additionalProperties: false`

## 兼容性验证

### OpenAI 函数调用
```javascript
// ✅ 现在可以正确验证
{
  "hostAlias": "cachyos-root"
}

// ❌ 会被正确拒绝 (额外属性)
{
  "hostAlias": "cachyos-root",
  "extraField": "value"
}
```

### Claude MCP
```javascript
// ✅ 完全兼容 MCP 协议
{
  "name": "runRemoteCommand",
  "arguments": {
    "hostAlias": "server1",
    "command": "uptime"
  }
}
```

### Gemini 函数调用
```javascript
// ✅ 符合 Gemini 的 schema 要求
{
  "hostAlias": "server1",
  "command": "ls -la"
}
```

## 最佳实践

### 1. 始终使用严格模式
```javascript
inputSchema: {
  type: "object",
  properties: { /* ... */ },
  required: [ /* ... */ ],
  additionalProperties: false,  // 🔒 严格模式
}
```

### 2. 明确定义所有属性
```javascript
properties: {
  hostAlias: {
    type: "string",
    description: "Alias or hostname of the SSH host",  // 📝 清晰描述
  },
  command: {
    type: "string",
    description: "The shell command to execute",
  },
}
```

### 3. 可选参数也要定义
```javascript
properties: {
  concurrency: {
    type: "number",
    description: "Max number of hosts to run in parallel (default: 5)",  // 📌 说明默认值
  },
  timeoutMs: {
    type: "number",
    description: "Per-host SSH command timeout in ms (default: 30000)",
  },
}
// 注意: 可选参数不在 required 数组中
```

### 4. 数组类型要指定 items
```javascript
hosts: {
  type: "array",
  items: { type: "string" },  // ✅ 明确数组元素类型
  description: "List of SSH host aliases",
}
```

## 测试验证

运行测试脚本验证 schema:
```bash
node test-schema-validation.mjs
```

预期输出:
```
Testing schema validation...

Testing tool: listKnownHosts
  ✅ Schema structure valid
  ✅ All required fields defined in properties
  ✅ additionalProperties correctly set to false
  ✅ Would correctly reject extra properties

Testing tool: runRemoteCommand
  ✅ Schema structure valid
  ✅ All required fields defined in properties
  ✅ additionalProperties correctly set to false
  ✅ Would correctly reject extra properties

...

✅ All schemas are valid and compatible with OpenAI, Claude, and Gemini!
```

## 影响范围

- ✅ **向后兼容**: 现有的 MCP 客户端不受影响
- ✅ **OpenAI 兼容**: 现在可以在 OpenAI 函数调用中使用
- ✅ **Claude 兼容**: 继续在 Claude Desktop 中正常工作
- ✅ **Gemini 兼容**: 可以在 Gemini API 中使用

## 参考资料

- [JSON Schema Specification](https://json-schema.org/specification.html)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Anthropic Claude Tools](https://docs.anthropic.com/claude/docs/tool-use)
