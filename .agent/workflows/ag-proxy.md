---
description: Delegate requests to the Antigravity Proxy
---

## Instructions

When calling `/ag-proxy`, you must:

1. **Gather context** from the current conversation:
   - Brief description of the current task (1-2 sentences)
   - Relevant code or information discussed earlier
   - Key decisions or constraints

2. **Format the message** as follows:
   ```
   ## Context
   [Brief task description and relevant information]

   ## Question
   [User's request]
   ```

3. **Call Antigravity Proxy** via MCP:

```javascript
const response = await mcp_antigravity-proxy_chat_completion({
    model: ${input:model?}, // Optional, uses default model from configuration
    messages: [
        { role: 'user', content: `## Context\n${context}\n\n## Question\n${input:query}` }
    ]
});
return response.content;
```

4. **Return the response** to the user, integrating it into the conversation.

## Usage Examples

- `/ag-proxy model:gpt-5 Explain this code` — sends request with context
- `/ag-proxy How to optimize this function?` — uses default model
