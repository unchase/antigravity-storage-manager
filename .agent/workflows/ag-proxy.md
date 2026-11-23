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

- `/ag-proxy model:gemini-4-neon-high Explain this code` — sends request with context using Gemini 4 Neon
- `/ag-proxy model:claude-opus-5-5-medium Review this diff` — sends request with context using Claude Opus 5.5
- `/ag-proxy model:gpt-5 Explain this architecture` — sends request with context using GPT-5
- `/ag-proxy How to optimize this function?` — uses default model
