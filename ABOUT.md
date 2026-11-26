# About EuroID

*Schengen for your apps: one passport, no border checks.*

EuroID is an Identity Governance and Administration (IGA) platform. It takes people from HR sources (CSV exports, JSON HR APIs), keeps one golden record per person, decides their access with a policy engine, and provisions and deprovisions accounts in target systems (Entra ID, Active Directory, Okta, SCIM applications, ServiceNow, GitHub, Google Sheets and others) through durable Temporal workflows. Around that core it covers joiners, movers and leavers, access requests and reviews, segregation of duties, reconciliation and orphan accounts, privileged admin accounts, non-human identities, risk scoring, an audit trail with tamper evidence, and GDPR erasure and export.

Stack: NestJS, Temporal, MongoDB, React with Ant Design, TypeScript throughout.

## Status

- **Working software, not a released product.** The backend has about 5,500 unit and integration tests, the Temporal workflows about 330 end-to-end tests, and the frontend about 1,050 tests; all pass on this snapshot.
- **Not yet tested against live systems.** The connectors are tested against mocks and recorded API behaviour, not against a live Entra ID, Active Directory, Okta or SCIM tenant.
- **Deployment model:** one installation per customer ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), "Supported Deployment Model"). The code isolates tenants, but hosting several customers in one installation is not supported yet ([docs/architecture/future/FUTURE_SHARED_HOSTING.md](docs/architecture/future/FUTURE_SHARED_HOSTING.md)).
- Designs for features that are not built, or built in part, are in [docs/architecture/future/](docs/architecture/future/README.md).

## This repository

This is a snapshot of a private development repository, published without its history. Internal planning files and development tooling configuration are left out.

## Where to start

- Run it: [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)
- How it fits together: [docs/architecture/core/DATAFLOWS.md](docs/architecture/core/DATAFLOWS.md) and [docs/architecture/core/SYSTEM_ARCHITECTURE.md](docs/architecture/core/SYSTEM_ARCHITECTURE.md)
- What a user does, step by step: [docs/USER_FLOWS.md](docs/USER_FLOWS.md)
- Deploying: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## Licence

All rights reserved (see [LICENSE](LICENSE)). The code is published to be read. Using, copying, modifying or distributing it needs written permission from the copyright holder.
