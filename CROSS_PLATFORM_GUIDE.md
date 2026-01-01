# 跨平台 AI 兼容性指南

## 概述

MCP SSH Agent 现在完全兼容以下 AI 平台的函数调用:

- ✅ **OpenAI** (GPT-4, GPT-3.5-turbo 等)
- ✅ **Claude** (Anthropic - MCP 原生支持)
- ✅ **Gemini** (Google)

## OpenAI 集成示例

### 使用 OpenAI Python SDK

```python
import openai
import json

# 定义工具
tools = [
    {
        "type": "function",
        "function": {
            "name": "runRemoteCommand",
            "description": "Executes a shell command on an SSH host",
            "parameters": {
                "type": "object",
                "properties": {
                    "hostAlias": {
                        "type": "string",
                        "description": "Alias or hostname of the SSH host"
                    },
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    }
                },
                "required": ["hostAlias", "command"],
                "additionalProperties": False  # 🔒 严格模式
            }
        }
    }
]

# 调用 OpenAI
response = openai.chat.completions.create(
    model="gpt-4",
    messages=[
        {"role": "user", "content": "Check the uptime on server1"}
    ],
    tools=tools,
    tool_choice="auto"
)

# 处理函数调用
if response.choices[0].message.tool_calls:
    tool_call = response.choices[0].message.tool_calls[0]
    function_args = json.loads(tool_call.function.arguments)
    
    # 调用 MCP 工具
    # result = mcp_client.call_tool("runRemoteCommand", function_args)
```

### 使用 OpenAI Node.js SDK

```javascript
import OpenAI from 'openai';

const openai = new OpenAI();

const tools = [
  {
    type: "function",
    function: {
      name: "runRemoteCommand",
      description: "Executes a shell command on an SSH host",
      parameters: {
        type: "object",
        properties: {
          hostAlias: {
            type: "string",
            description: "Alias or hostname of the SSH host"
          },
          command: {
            type: "string",
            description: "The shell command to execute"
          }
        },
        required: ["hostAlias", "command"],
        additionalProperties: false  // 🔒 严格模式
      }
    }
  }
];

const response = await openai.chat.completions.create({
  model: "gpt-4",
  messages: [
    { role: "user", content: "Check the uptime on server1" }
  ],
  tools: tools,
  tool_choice: "auto"
});

// 处理函数调用
if (response.choices[0].message.tool_calls) {
  const toolCall = response.choices[0].message.tool_calls[0];
  const functionArgs = JSON.parse(toolCall.function.arguments);
  
  // 调用 MCP 工具
  // const result = await mcpClient.callTool("runRemoteCommand", functionArgs);
}
```

## Claude (MCP) 集成

### Claude Desktop 配置

在 `claude_desktop_config.json` 中:

```json
{
  "mcpServers": {
    "ssh-agent": {
      "command": "node",
      "args": [
        "/path/to/mcp-ssh/server-simple.mjs",
        "--silent"
      ],
      "env": {
        "SSH_CONFIG_PATH": "~/.ssh/config",
        "SSH_GROUPS_PATH": "~/.ssh/config.groups.json"
      }
    }
  }
}
```

### 使用示例

在 Claude Desktop 中直接使用:

```
请在 server1 上执行 uptime 命令
```

Claude 会自动调用 `runRemoteCommand` 工具。

## Gemini 集成示例

### 使用 Gemini Python SDK

```python
import google.generativeai as genai

# 配置 Gemini
genai.configure(api_key='YOUR_API_KEY')

# 定义工具
tools = [
    {
        "function_declarations": [
            {
                "name": "runRemoteCommand",
                "description": "Executes a shell command on an SSH host",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "hostAlias": {
                            "type": "string",
                            "description": "Alias or hostname of the SSH host"
                        },
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute"
                        }
                    },
                    "required": ["hostAlias", "command"],
                    "additionalProperties": False
                }
            }
        ]
    }
]

# 创建模型
model = genai.GenerativeModel(
    model_name='gemini-pro',
    tools=tools
)

# 发送请求
chat = model.start_chat()
response = chat.send_message("Check the uptime on server1")

# 处理函数调用
if response.candidates[0].content.parts[0].function_call:
    function_call = response.candidates[0].content.parts[0].function_call
    function_args = dict(function_call.args)
    
    # 调用 MCP 工具
    # result = mcp_client.call_tool(function_call.name, function_args)
```

## 关键差异对比

| 特性 | OpenAI | Claude (MCP) | Gemini |
|------|--------|--------------|--------|
| Schema 验证 | 🔴 最严格 | 🟡 中等 | 🟢 宽松 |
| `additionalProperties` | ✅ 必须 | ⚠️ 推荐 | ⚠️ 推荐 |
| 额外参数处理 | ❌ 拒绝 | ⚠️ 忽略 | ⚠️ 忽略 |
| 数组 `items` | ✅ 必须 | ✅ 必须 | ✅ 必须 |
| 默认值支持 | ❌ 无 | ✅ 有 | ✅ 有 |

## 最佳实践

### 1. 始终使用严格模式

```javascript
{
  type: "object",
  properties: { /* ... */ },
  required: [ /* ... */ ],
  additionalProperties: false  // 🔒 所有平台都兼容
}
```

### 2. 明确定义所有属性

```javascript
properties: {
  hostAlias: {
    type: "string",
    description: "Alias or hostname of the SSH host"  // 📝 清晰描述
  }
}
```

### 3. 可选参数说明默认值

```javascript
concurrency: {
  type: "number",
  description: "Max number of hosts to run in parallel (default: 5)"
}
```

### 4. 数组必须指定 items

```javascript
hosts: {
  type: "array",
  items: { type: "string" },  // ✅ 明确类型
  description: "List of SSH host aliases"
}
```

## 错误处理

### OpenAI 错误示例

```json
{
  "error": {
    "message": "Invalid schema for function 'runRemoteCommand': data must NOT have additional properties",
    "type": "invalid_request_error"
  }
}
```

**解决方案**: 确保 `additionalProperties: false`

### Claude 错误示例

```json
{
  "error": {
    "type": "invalid_request_error",
    "message": "Missing required parameter: hostAlias"
  }
}
```

**解决方案**: 检查 `required` 数组

### Gemini 错误示例

```json
{
  "error": {
    "code": 400,
    "message": "Invalid function declaration: missing required field 'type'"
  }
}
```

**解决方案**: 确保所有属性都有 `type` 字段

## 测试验证

运行测试脚本:

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

...

✅ All schemas are valid and compatible with OpenAI, Claude, and Gemini!
```

## 故障排除

### 问题: OpenAI 拒绝函数调用

**症状**: 
```
Invalid input: data must NOT have additional properties
```

**解决方案**:
1. 检查是否添加了 `additionalProperties: false`
2. 确保没有传递未定义的参数
3. 验证所有 `required` 字段都在 `properties` 中

### 问题: Claude 无法识别工具

**症状**:
```
Tool not found: runRemoteCommand
```

**解决方案**:
1. 检查 MCP 服务器是否正常运行
2. 验证 `claude_desktop_config.json` 配置
3. 重启 Claude Desktop

### 问题: Gemini 参数解析错误

**症状**:
```
Failed to parse function arguments
```

**解决方案**:
1. 确保所有属性都有 `type` 字段
2. 检查数组是否定义了 `items`
3. 验证 JSON Schema 格式正确

## 参考资料

- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Anthropic Claude Tools](https://docs.anthropic.com/claude/docs/tool-use)
- [Google Gemini Function Calling](https://ai.google.dev/docs/function_calling)
- [JSON Schema Specification](https://json-schema.org/specification.html)
