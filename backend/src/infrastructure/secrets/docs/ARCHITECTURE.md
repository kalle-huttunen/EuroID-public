# Secrets Management

> **Module:** Infrastructure / Secrets
> **Used by:** [Connectors](../../../modules/connectors/docs/ARCHITECTURE.md) | [Blueprints](../../../modules/blueprints/docs/ARCHITECTURE.md) | Temporal client and worker ([Temporal Payloads](#temporal-payloads))

> **Built:** AES-256-GCM encryption at rest, with the key from the environment or unwrapped by AWS KMS or Azure Key Vault (`KMS_PROVIDER`)  
> **Not built:** HashiCorp Vault Transit

---

## Overview

Connector credentials and blueprint configs containing secrets are encrypted at rest using AES-256-GCM. The encryption key is loaded from environment variables, never hardcoded, and the application fails fast at startup if no key is configured. Every payload the API and the worker send to Temporal is encrypted too, with a key derived from the same settings ([Temporal Payloads](#temporal-payloads)).

---

## Environment Variables

### ENCRYPTION_KEY (preferred for production)

- **Format:** Base64-encoded 32-byte key
- **Use:** Production deployments where you can generate and store a strong key securely

Generate a key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Example output: `dGhpcyBpcyBhIDMyIGJ5dGUga2V5IGZvciBBRVMyNTY=`

### ENCRYPTION_KEY_PASSPHRASE (convenience for dev)

- **Format:** Plain text passphrase
- **Use:** Local development; not recommended for production

When set, the key is derived via PBKDF2-SHA256 with 100,000 iterations.

### ENCRYPTION_KEY_SALT (required with a passphrase)

- **Format:** Base64-encoded salt (16 random bytes: `node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"`)
- **Use:** Only with `ENCRYPTION_KEY_PASSPHRASE`; makes the derived key differ per environment

There is no default salt: with `ENCRYPTION_KEY_PASSPHRASE` set and `ENCRYPTION_KEY_SALT` unset, the API and the worker refuse to start (`EncryptionService.ensureKeyFromEnv`). Use a unique salt per environment.

### KMS_PROVIDER (envelope encryption: `aws` or `azure`)

- **Use:** the data key is kept wrapped by a cloud KMS. When `KMS_PROVIDER` is set, it takes precedence over `ENCRYPTION_KEY` and the passphrase (`EncryptionService.ensureKey`).
- **`aws`** (`aws-kms.provider.ts`): `AWS_KMS_KEY_ARN` (required), `AWS_REGION` (default `eu-west-1`), `AWS_KMS_WRAPPED_DEK` (the wrapped data key, base64).
- **`azure`** (`azure-keyvault.provider.ts`): `AZURE_KEYVAULT_URL` (required), `AZURE_KEYVAULT_KEY_NAME` (default `euroid-encryption-key`), `AZURE_KEYVAULT_WRAPPED_DEK`; credentials from `DefaultAzureCredential`, RSA-OAEP key wrap.
- **Startup:** the provider unwraps the 32-byte data key once and the service keeps it in memory under `ENCRYPTION_KEY_ID`. With no wrapped data key set, the provider generates one and prints the wrapped value to stderr, to be set for the next run: until it is set, every start gets a new key and cannot read what the previous one encrypted.
- **One key:** KMS mode loads no `ENCRYPTION_KEY_PREVIOUS`, so the Key Rotation steps below apply to `ENCRYPTION_KEY` only.

---

## Startup Validation

The application validates at startup (`config/encryption.config.ts`) that `ENCRYPTION_KEY`, `ENCRYPTION_KEY_PASSPHRASE` or `KMS_PROVIDER` is set, and that a `KMS_PROVIDER` has its required variable (`AWS_KMS_KEY_ARN` or `AZURE_KEYVAULT_URL`). If none is configured, the backend logs an error and exits. There is no fallback to a default key.

---

## Key Rotation

Every ciphertext names the key that encrypted it: `euroid:v2:<keyId>:<base64(iv + authTag + ciphertext)>` (`EncryptionService.encrypt`). New secrets are encrypted under `ENCRYPTION_KEY` with the id `ENCRYPTION_KEY_ID`; a deployment that never set `ENCRYPTION_KEY_ID` writes the id `default`, and its secrets keep decrypting as long as `ENCRYPTION_KEY` stays the same. Legacy `euroid:v1:` values carry no id and decrypt with the `default` key.

| Variable | During a rotation | Otherwise |
|----------|-------------------|-----------|
| `ENCRYPTION_KEY` | The new key | The key |
| `ENCRYPTION_KEY_ID` | Required: the new key's id, not `default` and not `ENCRYPTION_KEY_PREVIOUS_ID`. Keep it after the rotation | Optional (`default`) |
| `ENCRYPTION_KEY_PREVIOUS` | The key the stored secrets were encrypted with (32 bytes, base64). It also takes the id `default`; a `default` secret it does not open is tried with `ENCRYPTION_KEY` (recovery below) | Unset |
| `ENCRYPTION_KEY_PREVIOUS_ID` | The `ENCRYPTION_KEY_ID` the previous key had; unset when it had none (default `previous`) | Unset |

A process with `ENCRYPTION_KEY_PREVIOUS` set and `ENCRYPTION_KEY_ID` unset (or `default`, or equal to `ENCRYPTION_KEY_PREVIOUS_ID`) refuses to start, and so does the rotation script: the new key would share an id with the previous one, so new secrets would be written under the previous key and lost when it is removed. A previous key that does not decode to 32 bytes and a key id that contains `:` are refused too. The error names the setting to change.

**Steps** (`backend/src/scripts/rotate-encryption-key.ts`; `--generate` prints them with a new key and key id):

1. `npx ts-node -r tsconfig-paths/register src/scripts/rotate-encryption-key.ts --generate` (from `backend/`) prints a new `ENCRYPTION_KEY` and `ENCRYPTION_KEY_ID`. It reads no database.
2. Set `ENCRYPTION_KEY_PREVIOUS` to the current `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS_ID` to the current `ENCRYPTION_KEY_ID` (leave it unset if there was none), then `ENCRYPTION_KEY` and `ENCRYPTION_KEY_ID` to the generated values. Restart the API and the worker with these settings: from then on they write new secrets under the new key and read both. At this start the worker also rewrites each of its Temporal schedules (`upsertSchedule`), so their stored action args are encoded under the new key; check that the worker log names every schedule `updated` (or `created`).
3. Run the script with `--dry-run`, then without it, with the same settings and `MONGO_URI`.
4. When the script reports every stored secret under the new key id, the worker logged every schedule `updated` at the step 2 restart, and no Temporal workflow started before step 2 is still running, remove `ENCRYPTION_KEY_PREVIOUS` and `ENCRYPTION_KEY_PREVIOUS_ID`, keep `ENCRYPTION_KEY_ID`, and restart the API and the worker. The script does not see Temporal: a running workflow's history holds payloads under the previous key ([Temporal Payloads](#temporal-payloads), Rotation).

What the script does (`infrastructure/secrets/key-rotation.ts`, `rotateStoredSecrets`):

- **Where:** every ciphertext, at any depth, in the collections `SECRET_COLLECTIONS` lists: `connector_configs` (`configEncrypted`), `blueprintnodes` (`config`), `canvasblueprints` (`nodes[].data.config`, `connectorConfigs`), `admin_users` (`mfaSecret`), `event_subscriptions` (`webhook.signingSecret`) and `rollback_snapshots` (`ciphertext`). A new store of `EncryptionService` ciphertext belongs on that list.
- **Refusal:** it first decrypts every stored secret. If one does not decrypt, it writes nothing, exits with code 1 and says per key id what to set: a key id the settings have no key for (for example `ENCRYPTION_KEY_PREVIOUS_ID` missing on a second rotation) or a key that does not decrypt it (a wrong `ENCRYPTION_KEY_PREVIOUS`). `--dry-run` reports the same and writes nothing.
- **Run:** each secret not under the current key id is decrypted and encrypted again with a fresh IV. A document is written only over the values the script read, so a concurrent change is kept and counted.
- **Check:** afterwards it scans again. It tells you to remove `ENCRYPTION_KEY_PREVIOUS` only when every stored secret is under the new key id; otherwise it exits with code 1 and asks for another run. A secret written meanwhile by a process that still ran with the old settings is caught here.

Proof: `key-rotation.integration.spec.ts` stores secrets under key A in every listed collection (as a deployment without `ENCRYPTION_KEY_ID`), follows the steps to key B, drops key A and decrypts every secret; then rotates again from B to C.

**Recovery: secrets under two keys that both carry the id `default`.** The rotation steps from before `ENCRYPTION_KEY_ID` was required left some deployments with secrets saved under `default` with the old key (while `ENCRYPTION_KEY_PREVIOUS` was set) and under `default` with the new key (after it was removed). No single setting reads both. To recover:

1. Put the old key back as `ENCRYPTION_KEY_PREVIOUS` (leave `ENCRYPTION_KEY_PREVIOUS_ID` unset), keep `ENCRYPTION_KEY`, and set `ENCRYPTION_KEY_ID` to a new id (for example the id `--generate` prints; its key is not needed). Without `ENCRYPTION_KEY_ID` the API, the worker and the script refuse to start, as above. Restart the API and the worker.
2. Run the script with `--dry-run`, then without it, and finish with step 4 of the steps above.

With `ENCRYPTION_KEY_PREVIOUS` set, `default` names the previous key. A secret under `default` (or a `euroid:v1:` value) that the previous key does not authenticate is tried once with `ENCRYPTION_KEY` (`EncryptionService.decrypt`). The first such secret is logged once per process as a warning naming the key that opened it (`ENCRYPTION_KEY` and its id), never a key, a ciphertext or a value. Other key ids get no second try, and a secret neither key opens fails as before. Proof: `encryption.service.spec.ts` ("recovery of secrets under two keys with the id default").

---

## Temporal Payloads

Temporal keeps every workflow's input, activity arguments and results, signals, queries, updates, memo and result in its history, and the Temporal UI shows them. Onboarding takes `targetEmail` and offboarding `userEmail`, activities pass profiles around (`getIdentityByEmail`, `evaluateUser`, `provisionUserTo*`) and reconciliation returns drift results with `email` and `hubState`, so the history would hold personal data in clear. The API's Temporal client (`TemporalClientProvider`) and the worker (`worker.ts`: every worker and every schedule client) therefore share one data converter, `temporalDataConverter` in `infrastructure/temporal/temporal-payload-codec.ts`, whose payload codec encrypts every payload before it leaves the process. Workflow code is unchanged: Temporal applies codecs in the client and the worker, outside the workflow sandbox, and `bundleWorkflowCode` (dev mode and `scripts/build-workflow-bundle.js`) needs nothing for them.

- **Format:** AES-256-GCM with a fresh 12-byte IV per payload. The encrypted payload's data is `iv + authTag + ciphertext` of the whole original payload (protobuf, its metadata included); its metadata is `encoding: binary/encrypted` and `encryption-key-id: <key id>`.
- **Keys:** no new secret and no new setting. `EncryptionService.deriveSubkeyRing('euroid:temporal-payload-codec:v1')` derives an HKDF-SHA256 subkey from every key the service holds (`ENCRYPTION_KEY`, `ENCRYPTION_KEY_PREVIOUS`, the passphrase-derived or the KMS key) under the same key ids. The codec never uses a key that encrypts secrets. The keys are derived on first use, after `EncryptionService.onModuleInit` has loaded them.
- **Rotation:** new payloads are encrypted under `ENCRYPTION_KEY_ID` (`default` when unset), and a payload decrypts with the key its `encryption-key-id` names, so during a rotation the API and the worker read payloads under both keys. Keep `ENCRYPTION_KEY_PREVIOUS` (Key Rotation, step 4) until no workflow started before the rotation is still running. Schedules are the exception that never finishes: the server keeps a schedule's action args as they were encoded when the schedule was last written, and every scheduled run starts with them. The worker therefore rewrites its schedules at each start (`backend/src/infrastructure/temporal/schedule-upsert.ts`), which needs the previous key once to read the old args; a schedule whose args no configured key decrypts (the previous key was removed before a worker restart) is deleted and created again. A worker that cannot decrypt a history fails that workflow's task and Temporal retries the task: the workflow waits, its state intact, until a worker with the key runs. Closed workflows keep their payloads under the old key until the namespace's retention period deletes them; once the previous key is removed, the API cannot read their results or memos (bulk provisioning status, the dev tools) and neither can the decode script below. In KMS mode the service holds one key and no previous key: changing the KMS key leaves the payloads under the old one unreadable, as it does the stored secrets.
- **Readable in the history:** search attribute values (`TenantId`), headers (tracing context; Temporal never runs codecs on them), workflow ids and types, task queues, activity types, timers, and failure messages and stack traces: Temporal's default failure converter writes those in clear (failure details are payloads and are encrypted). An activity whose error message names a person still puts the name in the history.
- **Compatibility:** decoding passes every payload without `encoding: binary/encrypted` through unchanged, so histories recorded before the codec, and the replay fixtures in `backend/test/fixtures/`, decode and replay.
- **Failure:** a payload with the codec's metadata that does not decrypt (no key under its id, another key under its id, changed data, no key id) throws `TemporalPayloadDecryptionError`. Its message names the key id and the settings to check; the payload is never passed on as plaintext.
- **Limit:** with random IVs one key should encrypt at most 2^32 payloads (NIST SP 800-38D); rotate `ENCRYPTION_KEY` well before that.
- **Reading a payload:** the Temporal UI and CLI show encrypted payloads as base64, and EuroID runs no codec server for the UI. An operator who must read one exports the history, `temporal workflow show --workflow-id <id> --namespace <ns> --output json > history.json`, and runs, from `backend/` with the worker's encryption settings, `npx ts-node -r tsconfig-paths/register src/scripts/decode-temporal-payloads.ts history.json`. It prints the history with every encrypted payload replaced by its value (`infrastructure/temporal/temporal-payload-json.ts`). The output holds personal data: read it, do not store or share it.
- **Proof:** `infrastructure/temporal/temporal-payload-codec.spec.ts` (round trip, tamper detection, unknown key id, wrong key, pass-through, rotation through `EncryptionService`), `backend/test/workflows/payload-codec.workflow.e2e-spec.ts` (an onboarding history as Temporal stores it holds neither the address nor the name; every replay fixture replays with the codec). The Temporal e2e harness runs every suite with the codec (`backend/test/helpers/test-payload-codec.ts`).

---

## What Gets Encrypted

- **Connector config:** The `config` object in `connector_configs` collection (tenantId, clientId, clientSecret, etc.) is encrypted as a JSON blob before storage.
- **Blueprint configs:** Node configs and `connectorConfigs` in the canvas blueprint are encrypted before persistence when they hold a field the connector's manifest declares `type: 'password'` (`PluginRegistryService.getSecretConfigKeys`, the same declaration that masks `GET /connectors`). The connector is the node's `data.type`, the `nodeType` of a node-config update, or the `connectorConfigs` key; a config that names no registered connector is encrypted whole. Key names decide nothing: Discord `webhookUrl` is encrypted, SCIM `oauth2TokenUrl` alone is not.
- **Dead-letter payloads (`GET /dead-letter`):** an entry whose `source` is a registered connector has its payload redacted by that connector's declared secrets. Other entries (domain events, workflow inputs, webhook deliveries) fall back to a key-name match (`clientSecret`, `password`, `apiKey`, `secret`, `token`, `serviceAccount`): no manifest describes their payloads, so a name is the only signal, and over-redacting is the safer error.

## What Responses Mask

Secrets never leave the server; no UI flow needs one in clear (`config-secret-mask.ts`).

- **`GET /connectors`:** declared secrets come back as `SECRET_PLACEHOLDER` (`••••••••`); an update that sends it (or `''`) back keeps the stored value.
- **Blueprints (`GET /blueprints/latest`, `GET /blueprints/:id`, `PATCH /blueprints/:id`), every role:** node configs and `connectorConfigs` entries come back with their secrets masked (`modules/blueprints/blueprint-secrets.ts`). A secret is a key the node's connector declares `type: 'password'`; for a config that names no registered connector (the default canvas's Entra node has no `data.type`) a key that any registered connector declares secret, or a credential-like name (`isSecretByName`), is masked, so that node's `clientSecret` is masked and its `tenantId` is not. On `POST /blueprints/save` and `PATCH /blueprints/:id`, a secret that holds the placeholder keeps the stored value of the same node id (or `connectorConfigs` key), an empty string or `null` removes it, and any other value replaces it; the placeholder itself is never stored. The Design studio sends node configs back as it loaded them, so editing one field keeps the secrets. Server-side readers (`getLatestBlueprint`, `getNodeConfig`, workers, health checks) still get decrypted values.
- **Connector health check (`POST /connectors/:name/health-check`):** a form value that is the placeholder for a declared secret is replaced by the stored connector config value before the check runs.
- **Dead-letter payloads:** redacted as above (`[REDACTED]`).

---

## Backward Compatibility

Existing unencrypted credentials in the database are migrated on first read:

1. When reading connector config, if `configEncrypted` is absent but `config` exists, the service encrypts the config and saves it to `configEncrypted`.
2. Subsequent reads use `configEncrypted`. The legacy `config` field may remain until a schema migration clears it.

---

## A Stored Connector Config This Process Cannot Decrypt

A read never changes a stored connector config it cannot decrypt (`ConnectorConfigService.resolveConfig`). The cause may lie in the reading process alone: an `ENCRYPTION_KEY` other than the one the config was saved with, a key id (`euroid:v2:<keyId>:`) its key ring lacks (`ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY_PREVIOUS`, `ENCRYPTION_KEY_PREVIOUS_ID`), or a read before `EncryptionService.onModuleInit` has loaded the keys. One misconfigured API or worker process therefore fails harmlessly instead of erasing what every other process can still read.

- **Error:** every read of that config throws `ConnectorConfigDecryptError` (`modules/connectors/connector-config.errors.ts`, HTTP 503). Its message names the connector and the key settings to check; the server log adds the tenant and the decrypt error's reason (a JSON parse error is not quoted: it would contain decrypted text). Neither ever holds a key, the ciphertext or a config value.
- **Callers:** an API request answers the 503 (`POST /connectors/:name/ingest` too, after recording the failed run; `POST /connectors/:name/discover` reads the config before taking the sync lock). An activity fails and Temporal retries it, because a worker that holds the right key can succeed; catch-alls that would turn the error into a fallback let it through (Okta's `OKTA_*` environment variables, reconciliation's "user missing", the onboarding health checks' "unhealthy", which would fail the run without retry). `GET /reconciliation/connector-health` reports that connector down with the message, and the hourly sync scheduler skips it with a warning in the log. The readiness probe (`GET /health/ready`, `listSyncStates`) decrypts nothing, so it is not affected.
- **Keys not loaded:** the error says so ("has not loaded its encryption keys", retry) and is never reported as a wrong key (`EncryptionKeysNotLoadedError`). It does not happen in the API or the worker: `SecretsModule` is global, Nest runs and awaits the init hooks of global modules first, no init hook reads a connector config, and neither the HTTP server nor `worker.ts` uses a service before every init hook has finished.
- **Recovery:** fix the key settings of the failing process; the stored config is as it was. Only when the key it was saved with is lost (rotated away without keeping it as the previous key) does an admin replace it: `POST /connectors/:name/install` with the full config overwrites it, or `DELETE /connectors/:name` removes it. `PATCH /connectors/:name` merges with the stored values, so it fails the same way.

---

## Security Notes

- **Never log decrypted values** — not even in debug mode. PII redaction might miss manually logged secrets.
- **IV per encryption** — each encryption uses a fresh 12-byte random IV (GCM requirement).
- **Auth tag** — GCM provides authenticity; tampered ciphertext fails decryption.
