# Support Answer Style

This file is only a style guide. It is not product documentation and must not be cited as evidence for how any plugin feature works.

Use this style for customer-facing support answers.

## Priority

1. Answer directly first.
2. Search `docs/golden-answers/` for a matching saved reply before drafting from scratch.
3. State the verified source briefly when useful.
4. Give practical steps or a mapping table.
5. Mention limitations only when they change what the customer should do next.

## Golden Answers

- Golden answers are saved reply templates.
- Use a golden answer only when the customer's question clearly matches the "When To Use" section.
- Adapt the reply to the customer's exact wording and remove irrelevant parts.
- Preserve important links, placeholders such as `{{customer.first_name}}`, policy details, and step order.
- If multiple golden answers overlap, combine only the relevant parts and avoid repeating the same instruction twice.
- If no golden answer matches, answer from product docs/code instead.

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
