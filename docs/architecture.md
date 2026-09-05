# Frontend architecture

```text
src/
  app/                 # Providers, routing, app shell
  assets/              # Static assets
  components/ui/       # Reusable design-system primitives
  components/layout/   # Sidebar and top navigation
  config/              # App configuration
  features/            # Product domains: dashboard, conversations, agents,
                         customers, knowledge-base, analytics, automations,
                         integrations, and settings
  hooks/               # Cross-feature hooks
  i18n/locales/        # English and Arabic translations
  lib/                 # Generic helpers and integrations
  mocks/               # Development-only sample data and handlers
  pages/               # Thin route-level composition
  services/            # API clients, DTOs, mappers, repositories
  stores/              # Shared client state
  styles/              # Global tokens and themes
  types/               # Shared types
```

- Keep pages thin and compose features there.
- Keep all visible strings in locale dictionaries.
- Keep mock data/API access out of UI components.
- Put domain-specific components inside their feature, not `components/ui`.
