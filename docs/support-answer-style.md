# Support Answer Style

This file is only a style guide. It is not product documentation and must not be cited as evidence for how any plugin feature works.

Use this style for customer-facing support answers.

## Priority

1. Answer directly first.
2. State the verified source briefly.
3. Give practical steps or a mapping table.
4. Mention limitations only when they change what the customer should do next.

## Tone

- Be clear, confident, and practical when code or docs verify the answer.
- Avoid vague phrasing such as "likely", "apparently", "usually", or "seems" when the inspected source is enough.
- Do not expose internal implementation details unless the user asks for developer details.

## CSV Import And Mapping Questions

When answering import/mapping questions:

- Search exact UI labels and internal field names.
- Check the base plugin and any Pro/add-on plugin.
- Return a mapping table when fields are listed.
- If a UI field is missing, explain the workaround or say a feature update/post-import script is needed.
- If values need a specific format, provide an example CSV value.

Example structure:

| CSV field | Map to | Notes |
| --- | --- | --- |
| price | Variation Price | Simple products use the default variation price. |
| parent + child category | Categories | Format as `Parent Category > Child Category`. |
| slug | Not available in importer | Slug is generated automatically unless a custom importer/post-import script is added. |

End with a concise recommendation the customer can act on.
