# OpenAI Codex SDK

`OPENAI_CODEX` runs commit-message and code-review requests through `@openai/codex-sdk`, which launches the local Codex CLI.

Authentication uses the configured API key when `OPENAI_CODEX.key` is set. Otherwise, the provider uses the existing Codex CLI login session:

```bash
codex login
aic2 config set OPENAI_CODEX.model=gpt-5-codex
```

An API key can be configured instead:

```bash
aic2 config set OPENAI_CODEX.key=YOUR_API_KEY
aic2 config set OPENAI_CODEX.model=gpt-5-codex
```

The provider starts Codex in read-only mode with approvals, network access, and web search disabled. `temperature`, `topP`, and `maxTokens` are not passed because the Codex SDK does not expose chat-completion equivalents.
