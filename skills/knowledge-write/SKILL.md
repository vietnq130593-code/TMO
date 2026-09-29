---
name: Knowledge Write
description: Write new entities and relationships to the Knowledge Base.
---

# Knowledge Write

## Description
Write new entities and relationships to the Knowledge Base.

## When to Use
- When you discover new information not in the KB
- When the user explicitly asks you to save information
- After a successful correction

## How to Use
1. Call `knowledge_write` with entity or relationship data
2. For entities: provide name, type, description, domain
3. For relationships: provide source, target, type, description
4. Data will be buffered in SQLite and synced to Neo4j

## Rules
- ALWAYS ask the user before writing new data
- Never delete existing data without explicit permission
- Provide clear descriptions for all entities
- Use consistent entity types (Algorithm, Concept, Tool, etc.)