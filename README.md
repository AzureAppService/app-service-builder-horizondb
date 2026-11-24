# Fieldnotes: HorizonDB guide finder

Fieldnotes compares keyword and hybrid retrieval over fictional field-support guides. It is a Node.js sample for Azure HorizonDB and App Service Builder, not a production troubleshooting service. Use synthetic data and queries only.

> **Preview status:** The target HorizonDB portal's `oss-rdbms` token resource, administrator TLS login and non-admin managed-identity principal mapping are verified on a dedicated test cluster. Live keyword queries under the mapped role return real `fulltext` matches; wrong-identity login is rejected. This role-level check is not a hosted managed-identity login. Hosted identity and hybrid retrieval remain unverified pending native Builder confirmations and user acceptance of managed-model terms. Verify the current service contract on your own cluster; PostgreSQL compatibility alone does not establish it.

## What it does

- Searches the same guide collection with `ai.search(..., search_type => 'fulltext')` and `ai.search(..., search_type => 'hybrid')`.
- Shows each returned guide's actual `match_type`, score, summary, and troubleshooting steps. Scores are meaningful within a result list, not across the two modes.
- Checks for a valid BM25 index on `search_text` and a cosine DiskANN index on `embedding`. A successful hybrid call by itself does not prove that both retrieval methods contributed; the interface reports what the returned matches show.
- Uses the `default-embedding` managed model for hybrid search. Reranking is off. Keyword search without reranking does not make an embedding-model call.
- Makes no database changes at application startup. The separate bootstrap is for an empty, dedicated test database.

The public sample has no visitor sign-in. Its in-process request and concurrency limits are only basic demo safeguards; they are not a distributed rate limiter or a production access-control system. Do not expose it to sensitive data or production traffic.

## Prerequisites

1. Node.js 24 and npm.
2. A dedicated Azure HorizonDB cluster and database with Microsoft Entra authentication and an available compute pool. Follow the [cluster quickstart](https://learn.microsoft.com/azure/horizondb/configure-maintain/quickstart-create-cluster) and [Entra configuration guidance](https://learn.microsoft.com/azure/horizondb/security/security-microsoft-entra-how-to-configure).
3. For hybrid setup, [AI Model Management](https://learn.microsoft.com/azure/horizondb/ai/ai-model-management) enabled, with its terms accepted by the user as required, and `default-embedding`, `default-chat`, and `default-reranker` available. The feature is in preview and provisions managed models. Model usage is billed. The keyword-only bootstrap makes no model calls and does not change model access.
4. A dedicated pool parameter group that allows `vector`, `pg_diskann`, `pg_textsearch`, and `azure_ai`, and preloads `pg_textsearch` in `shared_preload_libraries`. Preserve any existing required values, apply the group, and restart when required. See [allow extensions](https://learn.microsoft.com/azure/horizondb/extensions/how-to-allow-extensions) and [full-text search](https://learn.microsoft.com/azure/horizondb/ai/full-text-search).
5. An `azure_ai` version that provides `ai.search()` and the documented `ai.embed()` interface; the current [AI search documentation](https://learn.microsoft.com/azure/horizondb/ai/ai-search) targets the newer `ai` schema. Confirm the installed function signatures and model access on the actual database.
6. A user-assigned managed identity attached **to the app**, plus a matching non-administrator database login created by a HorizonDB Entra administrator. An identity attached to the HorizonDB cluster for another service feature is not the app's identity. The runtime principal must not be a database administrator.

Builder Connections does not currently configure HorizonDB for this sample. Configure the following non-secret app settings manually; attaching the identity and granting its database permissions are separate actions.

| Setting | Meaning |
| --- | --- |
| `HORIZONDB_HOST` | HorizonDB read endpoint hostname, ending in `.horizondb.azure.com` |
| `HORIZONDB_DATABASE` | Dedicated database containing the sample schema |
| `HORIZONDB_USER` | Exact database login mapped to the app's managed identity |
| `AZURE_CLIENT_ID` | Client ID of the user-assigned identity attached to the app |
| `HORIZONDB_TOKEN_SCOPE` | Verified HorizonDB Entra resource scope ending in `/.default` |

The tested HorizonDB Connect page prescribes `az account get-access-token --resource-type oss-rdbms`, resolving in AzureCloud to `https://ossrdbms-aad.database.windows.net`. Set the corresponding scope to `https://ossrdbms-aad.database.windows.net/.default` after checking your cluster's current guidance. On the tested cluster, `pgaadauth` 1.12 exposes `pgaadauth_create_principal_with_oid(rolename text, objectid text, objecttype text, isadmin boolean, ismfa boolean, tenantid text, skipvalidation boolean)`. An administrator created the application login in `postgres` using its verified managed-identity **principal/object ID**, type `service`, both privilege flags false, the verified tenant ID and `skipvalidation=false`, then verified the returned mapping and role privileges. This does not yet prove an actual managed-identity login. Inspect the installed signature before applying it elsewhere; never disable directory validation to hide an error. The runtime intentionally has no guessed default scope, password fallback or developer-credential fallback.

## Bootstrap the dedicated database

Run bootstrap as a separately authorized HorizonDB Entra administrator from an approved network location, such as an Azure-hosted administration environment permitted by the cluster's firewall. Install dependencies with `npm ci`, sign in to Azure CLI as that administrator, and set the variables above plus:

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

The keyword stage creates the schema, 14 synthetic text guides, a BM25 index and search permissions. Embeddings remain SQL NULL; it creates no DiskANN index, calls no models and changes no model user lists. Hybrid search explicitly reports its missing vector index. Embedding completion requires the exact unchanged, entirely unembedded synthetic collection; it refuses modified or partial data, generates real vectors, enforces non-null embeddings and creates DiskANN before applying model permissions. It does not overwrite or reseed existing text. Each stage is transactional, though an aborted embedding transaction may still incur inference charges.

On the test cluster with managed models disabled, `DEMO-104` and `requests wait for a free session` both ranked the synthetic pool-wait guide first with `match_type=fulltext`; a nonexistent term returned no guides. The mapped role could select but had no insert, update, delete, schema-create or database-create permissions. Hybrid correctly reported its missing DiskANN index. These checks do not establish hosted identity or semantic retrieval quality.

The runtime login must already exist and must not have administrator, role-creation, database-creation, superuser, or replication privileges. Bootstrap refuses to overwrite an existing `guide_finder` schema. It creates extensions when allowed, inserts 14 synthetic guides and their embeddings, creates BM25 and DiskANN indexes, and grants the runtime principal schema usage, guide `SELECT`, and the documented search/embedding function access. It changes managed-model user lists: the embedding model is limited to the administrator and runtime login, while the managed chat and reranking models are limited to the administrator. **Do not run it against a shared cluster or database.** Review existing model access and service-side effects first.

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

Use the native Builder source workflow selected by the user. For local files, inspect the exact prepared archive and complete the native review, Azure identity, target, and deployment confirmations; never upload `.env` files or credentials. Availability of local ZIP source can differ by Builder environment; if the native path is unavailable, do not bypass its controls. GitHub publication is a separate choice and approval. A deployed app still needs its user-assigned identity attached and the settings above configured separately.

The search API accepts `POST /api/search` with JSON `{ "query": "DEMO-104" }`. It returns `keyword` and `hybrid` result objects; HTTP 200 means both succeeded, 207 means one failed, and 503 means neither succeeded. Search input is limited to 180 characters, requests are bounded, and query values are passed as SQL parameters.

## Network, cost, and cleanup

The test topology may use the HorizonDB Azure-services firewall rule `0.0.0.0` to `0.0.0.0` only when explicitly approved. This is **not restricted to your subscription**: it permits network connections from Azure services and assets in other customers' subscriptions as well. Database authentication and permissions still apply. Use it only with the dedicated synthetic-data cluster; prefer narrower networking for real workloads.

HorizonDB compute, storage and backups, Builder hosting, any administration compute, and model inference can incur ongoing charges. Enabling managed models can create associated service resources. Stop or remove only resources that are confirmed to belong exclusively to this sample, and only after separate deletion approval. Review the dedicated resource group and any managed resources before deletion; do not unregister subscription-wide providers or remove unrelated identities, rules, or resources as part of cleanup.

## Repository publication

Changes go through a pull request against `main`. The repository requires the `build-and-test` check, code-owner and last-push review, and resolved conversations before merging. See `CONTRIBUTING.md` for contribution guidance.
