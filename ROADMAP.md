# Roadmap

## 0.1 (the first release)

One shared set of markdown pages per project that every agent can read and write.

- MCP server with OAuth sign-in, usable from Claude, ChatGPT, Claude Code, Codex and any MCP client
- Projects with a standard page layout, versioned writes and a record of which agent changed what
- Read, write, append, delete and full-text search tools
- A web app to read, edit, search and restore pages, with history and line diffs
- A local mirror of a project in a git-ignored `.anywhere/` folder, with `anywr pull` and `anywr push`
- A skill that teaches agents what to store and how to stay organised
- Self-hosting with Docker and Postgres, and export of everything as markdown

## Later

Planned, deliberately not in 0.1. Order is not decided.

- **Teams and sharing.** Share a project with other people; roles; a shared client workspace.
- **Automatic capture.** Offer to save what matters at the end of a conversation without being asked.
- **Semantic retrieval.** Embeddings so agents find context by meaning, not only by words.
- **More sign-in options.** Magic links, Google and GitHub.
- **End-to-end encryption** for people who want the server unable to read their pages.
- **Attachments.** Images and files alongside pages.
- **More agents.** First-class setup guides and skill packaging for Cursor, Gemini and others.
