---
name: Knowledge Search
description: Search the local Knowledge Base using semantic search and graph expansion.
---

# Knowledge Search

## Description
Search the local Knowledge Base using semantic search and graph expansion.

## When to Use
- When the user asks about any topic that might be in the Knowledge Base
- When you need factual information from indexed documents
- Before answering any question, always search the KB first

## How to Use
1. Call the `knowledge_search` tool with the user's query
2. Review the results: chunks, entities, relationships
3. Synthesize an answer based on the data
4. Cite sources from the results

## Rules
- ALWAYS search the KB before answering
- If no results found, say so clearly
- Never fabricate information not in the KB
- Cite document sources when available