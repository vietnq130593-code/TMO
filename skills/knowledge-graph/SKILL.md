---
name: Knowledge Graph
description: Query the Neo4j Knowledge Graph for entity relationships and graph traversal.
---

# Knowledge Graph

## Description
Query the Neo4j Knowledge Graph for entity relationships and graph traversal.

## When to Use
- When the user asks about relationships between entities
- When you need to find paths between concepts
- When exploring connected knowledge

## How to Use
1. Call `knowledge_graph` with a Cypher query or entity name
2. For exploration: provide an entity name
3. For path finding: provide source and target entity names
4. Review and present the graph structure

## Rules
- Only use MATCH queries (read-only)
- Limit results to 50 nodes
- Explain relationships in natural language