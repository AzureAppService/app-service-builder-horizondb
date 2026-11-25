# Fieldnotes: HorizonDB guide finder

Fieldnotes compares keyword and hybrid retrieval over fictional field-support guides. It is a Node.js sample for Azure HorizonDB and App Service Builder, not a production troubleshooting service. Use synthetic data and queries only.

> **Preview status:** On a dedicated test cluster, a Builder-hosted app signed in to HorizonDB with its user-assigned managed identity and returned real keyword (`fulltext`) matches. A disabled database login and a missing app identity both produced explicit errors. Managed models are ready in `postgres`; a scoped-role test there returned `vector+fulltext` hybrid matches, including a guide independently returned by both retrieval modes. The hosted app still uses the separate `fieldnotes` database, so hosted hybrid remains unverified until its configuration and AppVersion are updated.

## What it does

- Searches the same guide collection with `ai.search(..., search_type => 'fulltext')` and `ai.search(..., search_type => 'hybrid')`.
- Shows each returned guide's actual `match_type`, score, summary, and troubleshooting steps. Scores are meaningful within a result list, not across the two modes.
- Checks for a valid BM25 index on `search_text` and a cosine DiskANN index on `embedding`. A successful hybrid call by itself does not prove that both retrieval methods contributed; the interface reports what the returned matches show.
- Uses the `default-embedding` managed model for hybrid search. Reranking is off. Keyword search without reranking does not make an embedding-model call.
- Makes no database changes at application startup. The separate bootstrap is for an empty, dedicated test database.

The public sample has no visitor sign-in. Its in-process request and concurrency limits are only basic demo safeguards; they are not a distributed rate limiter or a production access-control system. Do not expose it to sensitive data or production traffic.

## Prerequisites

1. Node.js 24 and npm.
2. A dedicated synthetic-data Azure HorizonDB cluster with Microsoft Entra authentication and an available compute pool. Follow the [cluster quickstart](https://learn.microsoft.com/azure/horizondb/configure-maintain/quickstart-create-cluster) and [Entra configuration guidance](https://learn.microsoft.com/azure/horizondb/security/security-microsoft-entra-how-to-configure).
3. For hybrid setup, enable [AI Model Management](https://learn.microsoft.com/azure/horizondb/ai/ai-model-management) and wait for `default-embedding`, `default-chat`, and `default-reranker` to become available. While the feature is in preview, review and accept the [Supplemental Terms of Use for Microsoft Azure Previews](https://azure.microsoft.com/support/legal/preview-supplemental-terms/) when prompted in the cluster's AI model manager. The feature provisions managed models, and model usage is billed. On the tested preview cluster, the managed aliases registered in `postgres`, not the separate `fieldnotes` database; this sample uses its own `guide_finder` schema in `postgres` on that dedicated cluster. Verify model registration in the database you use, as preview behavior may change. The keyword-only bootstrap makes no model calls and does not change model access.
4. A dedicated pool parameter group that allows `vector`, `pg_diskann`, `pg_textsearch`, and `azure_ai`, and preloads `pg_textsearch` in `shared_preload_libraries`. Preserve any existing required values, apply the group, and restart when required. See [allow extensions](https://learn.microsoft.com/azure/horizondb/extensions/how-to-allow-extensions) and [full-text search](https://learn.microsoft.com/azure/horizondb/ai/full-text-search).
5. An `azure_ai` version that provides `ai.search()` and the documented `ai.embed()` interface; the current [AI search documentation](https://learn.microsoft.com/azure/horizondb/ai/ai-search) targets the newer `ai` schema. Confirm the installed function signatures and model access on the actual database.
6. A user-assigned managed identity attached **to the app**, plus a matching non-administrator database login created by a HorizonDB Entra administrator. An identity attached to the HorizonDB cluster for another service feature is not the app's identity. The runtime principal must not be a database administrator.

Builder Connections does not currently configure HorizonDB for this sample. Configure the following non-secret app settings manually; attaching the identity and granting its database permissions are separate actions.

| Setting | Meaning |
| --- | --- |
| `HORIZONDB_HOST` | HorizonDB read endpoint hostname, ending in `.horizondb.azure.com` |
| `HORIZONDB_DATABASE` | Database containing the sample schema and managed model aliases; `postgres` on the tested dedicated cluster |
| `HORIZONDB_USER` | Exact database login mapped to the app's managed identity |
| `AZURE_CLIENT_ID` | Client ID of the user-assigned identity attached to the app |
| `HORIZONDB_TOKEN_SCOPE` | Verified HorizonDB Entra resource scope ending in `/.default` |

The tested HorizonDB Connect page prescribes `az account get-access-token --resource-type oss-rdbms`, resolving in AzureCloud to `https://ossrdbms-aad.database.windows.net`. Set the corresponding scope to `https://ossrdbms-aad.database.windows.net/.default` after checking your cluster's current guidance. On the tested cluster, `pgaadauth` 1.12 exposes `pgaadauth_create_principal_with_oid(rolename text, objectid text, objecttype text, isadmin boolean, ismfa boolean, tenantid text, skipvalidation boolean)`. An administrator created the application login in `postgres` using its verified managed-identity **principal/object ID**, type `service`, both privilege flags false, the verified tenant ID and `skipvalidation=false`. The Builder-hosted app subsequently used that identity for keyword search in `fieldnotes`. Inspect the installed signature before applying it elsewhere; never disable directory validation to hide an error. The runtime intentionally has no guessed default scope, password fallback or developer-credential fallback.

## Bootstrap the dedicated cluster

Run bootstrap as a separately authorized HorizonDB Entra administrator from an approved network location, such as an Azure-hosted administration environment permitted by the cluster's firewall. For hybrid setup, verify the three managed aliases with `model_registry.model_list_all()` in the target database. On the tested cluster, the Entra administrator also needed membership in `model_registry_manager` to restrict the managed models, even though it was an `azure_pg_admin` member. An authorized administrator can grant it as documented:

```sql
GRANT model_registry_manager TO "<Entra administrator database login>";
```

PostgreSQL role membership applies across the cluster and persists after bootstrap. Do not grant this role to the app identity. Install dependencies with `npm ci`, sign in to Azure CLI as the administrator, and set the variables above plus:

```sh
export HORIZONDB_ADMIN_USER="<Entra administrator database login>"
export HORIZONDB_RUNTIME_ROLE="$HORIZONDB_USER"
export HORIZONDB_CONFIRM_DATABASE="$HORIZONDB_DATABASE"
npm run db:bootstrap
```

Alternatively, stage setup while model terms are pending:

```sh
npm run db:bootstrap:keyword
# After the user accepts model terms and the managed models are ready:
npm run db:bootstrap:embeddings
```

The keyword stage creates the schema, 14 synthetic text guides, a BM25 index and search permissions. Embeddings remain SQL NULL; it creates no DiskANN index, calls no models and changes no model user lists. Hybrid search explicitly reports its missing vector index. Embedding completion requires the exact unchanged, entirely unembedded synthetic collection; it refuses modified or partial data, generates real vectors, enforces non-null embeddings and creates DiskANN. It does not overwrite or reseed existing text. Hybrid bootstrap checks model registration and applies the model user lists before embedding calls. Each stage is transactional, though an aborted embedding transaction may still incur inference charges.

On the test cluster with managed models disabled, `DEMO-104` and `requests wait for a free session` both ranked the synthetic pool-wait guide first with `match_type=fulltext`; a nonexistent term returned no guides. The mapped role could select but had no insert, update, delete, schema-create or database-create permissions. Hybrid correctly reported its missing DiskANN index.

The same checks passed through the Builder-hosted app using its managed identity. When an administrator set the runtime login to `NOLOGIN`, search returned HTTP 503 with `identity_or_permission`. With no identity attached to the app, it returned HTTP 503 with the generic `unavailable` code; token-acquisition failures are not yet distinguished from other outages. These checks do not establish semantic retrieval quality.

The runtime login must already exist and must not have administrator, role-creation, database-creation, superuser, or replication privileges. Bootstrap refuses to overwrite an existing `guide_finder` schema. It creates extensions when allowed, inserts 14 synthetic guides and their embeddings, creates BM25 and DiskANN indexes, and grants the runtime principal schema usage and guide `SELECT`. In `postgres` it requires existing connection, `ai` schema, and search/embedding function privileges and will not grant them; for a separate database it grants those permissions. It changes managed-model user lists for the database: the embedding model is limited to the administrator and runtime login, while the managed chat and reranking models are limited to the administrator. Other users lose access to those models. **Do not run it against a shared cluster or database.** Review existing model access and service-side effects first.

On the tested cluster, PostgreSQL's existing `PUBLIC` privileges also let the runtime login read service-owned `ai` pipeline and graph tables, an `_duroxide` worker table, and BM25 metadata views outside `guide_finder`. No non-system table write or schema-create privileges were observed, and the chat model rejected the runtime login. These inherited grants are not changed by the sample, so strict schema-only read isolation is not established. Use a dedicated synthetic-data cluster and assess its effective privileges.

Bootstrap uses an Azure CLI credential only for this one-time administrator operation. The application uses `ManagedIdentityCredential` for the specified user-assigned identity and requests a usable token for each new physical PostgreSQL connection. Existing pooled sessions are not reauthenticated for every query. PostgreSQL TLS certificate and hostname verification remain enabled.

After bootstrap, verify using the actual runtime identity:

1. The identity can connect and `SELECT` the guides, but cannot insert, update, delete, create objects, or administer roles.
2. A different or unattached identity cannot sign in or read the guides.
3. Both index definitions are present and valid. Search an exact example such as `DEMO-104`, then a paraphrase such as `requests wait for a free session`.
4. Inspect the returned `match_type` values and compare the actual results. Do not treat HTTP success or the mere existence of both indexes as proof that both paths contributed.

## Local development and Builder

```sh
npm ci
npm test
npm start
```

The app listens on `PORT` (default `8080`) and `HOST` (default `0.0.0.0`). Set `HOST=127.0.0.1` for a local-only preview. `/health` is a liveness check and deliberately does not claim database readiness. Missing configuration, identity failures, missing indexes, and model failures are reported explicitly in the search UI. The unit tests use controlled substitutes and do not prove live HorizonDB behavior.

The root `builder.yaml` declares one Node.js 24 web component. Its custom build runs `npm ci --omit=dev` and `npm run package`, which stages the runtime, public assets, dependencies, and package metadata under Builder's `DESTINATION_DIR`. It starts `node server/index.js` and probes `/health`.

Use the native Builder source workflow selected by the user. For local files, inspect the exact prepared archive and complete the native review, Azure identity, target, and deployment confirmations; never upload `.env` files or credentials. Availability of local ZIP source can differ by Builder environment; if the native path is unavailable, do not bypass its controls. GitHub publication is a separate choice and approval. A deployed app still needs its user-assigned identity attached and the settings above configured separately. Each deployment snapshots the app's configuration. After you change settings, deploy a new version. After you change the identity, redeploy so the running process does not reuse cached tokens.

The search API accepts `POST /api/search` with JSON `{ "query": "DEMO-104" }`. It returns `keyword` and `hybrid` result objects; HTTP 200 means both succeeded, 207 means one failed, and 503 means neither succeeded. Search input is limited to 180 characters, requests are bounded, and query values are passed as SQL parameters.

## Network, cost, and cleanup

The test topology may use the HorizonDB Azure-services firewall rule `0.0.0.0` to `0.0.0.0` only when explicitly approved. This is **not restricted to your subscription**: it permits network connections from Azure services and assets in other customers' subscriptions as well. Database authentication and permissions still apply. Use it only with the dedicated synthetic-data cluster; prefer narrower networking for real workloads.

HorizonDB compute, storage and backups, Builder hosting, any administration compute, and model inference can incur ongoing charges. Enabling managed models can create associated service resources. Stop or remove only resources that are confirmed to belong exclusively to this sample, and only after separate deletion approval. Review the dedicated resource group and any managed resources before deletion; do not unregister subscription-wide providers or remove unrelated identities, rules, or resources as part of cleanup.

## Repository publication

Changes go through a pull request against `main`. The repository requires the `build-and-test` check, code-owner and last-push review, and resolved conversations before merging. See `CONTRIBUTING.md` for contribution guidance.
