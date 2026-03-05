# Telemetry Events

This file tracks planned launcher telemetry events in rollout order.

## Event rollout

1. `launcher.session.started` (implemented)
   - Description: emitted once after Datadog RUM initializes for a renderer session.
   - Safe fields:
     - `app_env` (`prod-v2`, `staging`, etc.)
     - `app_version` (build/version tag used by RUM)
     - `is_packaged` (boolean)
     - `telemetry_effective_enabled` (boolean)
2. `launcher.view.opened` (implemented)
3. `launcher.install.flow.opened`
4. `launcher.install.method.selected`
5. `launcher.install.guardrail.blocked`
6. `launcher.action.invoked`
7. `launcher.action.result`
8. `launcher.settings.changed`
9. `launcher.install.variant.selected`
10. `launcher.install.disk_warning.response`
11. `launcher.update.cta`
12. `launcher.track_existing.saved`
13. `launcher.snapshot.flow`
14. `launcher.model_download.result`

## Guardrails

- Do not emit high-frequency action events for progress ticks.
- Do not send PII/high-cardinality data (paths, names, raw IDs, raw errors).
- Use stable enum-like values in context fields.
