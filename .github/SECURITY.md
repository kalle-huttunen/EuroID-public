# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| main    | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in EuroID, please report it responsibly:

1. **DO NOT** open a public GitHub issue
2. Email: security@euroid.io
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Affected module(s)
   - Potential impact assessment

## Response Timeline

| Severity | Initial Response | Fix Target |
|----------|-----------------|------------|
| Critical | 24 hours        | 72 hours   |
| High     | 48 hours        | 1 week     |
| Medium   | 1 week          | 2 weeks    |
| Low      | 2 weeks         | Next release |

## Security Controls

EuroID implements the following security controls:

- **Input Validation**: Zod schemas at all API boundaries
- **Authentication**: JWT + OIDC with configurable providers
- **Authorization**: ABAC policy engine with SoD enforcement
- **Encryption**: AES-256-GCM envelope encryption for secrets (KMS-backed)
- **SSRF Protection**: URL validation with IP blocklist and DNS resolution checks
- **Dependency Scanning**: `npm audit` in CI + Trivy container scanning
- **Security Rules**: 19 curated rules from [CoSAI Project CodeGuard](https://github.com/cosai-oasis/project-codeguard) v1.3.0

## Scope

In-scope:
- Backend API (NestJS)
- Frontend application (React)
- Temporal workflows
- Connector integrations (Entra ID, AD, SCIM)
- Authentication & authorization flows
- Data encryption & secrets management

Out-of-scope:
- Third-party dependencies (report upstream)
- Infrastructure not managed by EuroID (MongoDB, Temporal Server)
