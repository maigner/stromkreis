# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**Stromkreis** is a non-profit, open-source (AGPL-3.0) multi-tenant platform for Austrian energy communities (EEGs), to be hosted at **stromkreis.net**. Scope: EEG-Faktura energy-data import + dashboards/forecast, and generalized intelligent battery management (IBM). Explicitly out of scope: billing, finance, member onboarding. See `docs/vision.md`, `docs/architektur.md`, `docs/roadmap.md`.

The reference implementation and porting source is the ISCHLSTROM monorepo at `~/Workspace/Energiegemeinschaft`. ISCHLSTROM stays on its own infrastructure for now (a later move to the platform is an option, not a prerequisite); the first tenant is the dummy EEG **Salzkammerstrom** (test data only).

## Structure

- `platform/` — SvelteKit 5 + Tailwind 4 app (JS with jsdoc, adapter-node): multi-tenant web UI + IBM API. Commands (from `platform/`): `npm run dev`, `npm run build`, `npm run check`, `npm run preview`.
- `pipeline/` — Python data pipeline: EEG-Faktura import, Open-Meteo weather import, forecast runs. One scheduled pipeline looping over tenants.
- `gateway/` — per-inverter-profile packages installed at members' homes (hardware list, setup guide, control logic). Gateways poll the platform outbound via HTTPS with per-site tokens; no inbound access to home networks.
- `docs/` — vision, architecture, roadmap (German).

## Conventions

- **Every query is tenant-scoped.** All domain tables carry `tenant_id`; never write a code path without a tenant filter.
- Schema authority lives in the platform (single authority, unlike the ISCHLSTROM Django/SvelteKit split). The pipeline consumes the schema as a documented contract: migrations are plain SQL via dbmate in `platform/db/migrations/`; the generated `platform/db/schema.sql` is committed and is that contract. Cross-table references use composite FKs over `(tenant_id, id)` so cross-tenant references fail at the DB level.
- Forecast runs are versioned and never overwritten (enables forecast-vs-actual comparison).
- User-facing text is German. Never use em/en dashes ('—'/'–'); write percentages tight (42%, not 42 %).
- Timezone is Europe/Vienna throughout; be careful with date handling.
- IBM safety rules are launch requirements: fail-safe defaults when the API is unreachable, auto-revert, documented residual-risk disclosure per site.
- Never run git; the user performs all git operations manually.

## Domain semantics (from ISCHLSTROM, keep identical)

- `Anteil gemeinschaftliche Erzeugung` = total community generation; `Eigendeckung` = the share members actually consumed.
- Partial EEG-Faktura deliveries exist (rows present, most points all-zero); detect via minimum reporting share before trusting a day.
