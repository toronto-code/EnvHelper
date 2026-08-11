# Provider Guidance

Provider metadata supports the guided `envhelper setup` flow. It is not exposed as a separate command surface.

## Resolution order

1. Exact environment-variable match, such as `STRIPE_SECRET_KEY`.
2. Provider prefix or regex match for credential-shaped names.
3. Package-name hint for generic names such as `API_KEY`.
4. A clearly labelled Google search link when no provider can be identified.

## Source policy

Every built-in entry must point to official documentation or an official dashboard. The provider audit enforces:

- valid HTTPS URLs,
- no duplicate exact environment mappings,
- no generic exact mappings such as `DATABASE_URL`,
- valid environment names and regex patterns,
- source URLs that are not search-result pages.

Run:

```bash
npm run providers:audit
```

## Validation

Validation is optional and invoked only from setup after consent or an explicit `--validate` flag.

- `url` and `format` validation stay local.
- `http` validation sends the value directly to the declared provider endpoint.
- HTTP validators must be scoped to exact variables through `validation.env`.

Provider validation must never route through an EnvHelper service.
