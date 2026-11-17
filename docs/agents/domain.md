# Domain docs

Lionscope uses a single shared domain documentation context across its packages.

## Before exploring

- Read `GLOSSARY.md` at the repository root.
- Read relevant decisions under the root `docs/adr/` directory.

If these files do not exist, proceed silently. The domain-modeling skill
creates them lazily when terms or decisions are resolved.

## Layout

- `GLOSSARY.md`: shared domain vocabulary.
- `docs/adr/NNNN-descriptive-title.md`: architecture decision records.

## Use the glossary's vocabulary

Use defined domain terms in issue titles, proposals, hypotheses, and test names.
Follow any glossary guidance about synonyms.

When a needed concept is absent, reconsider whether it belongs to the domain.
Record real vocabulary gaps for domain-modeling.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify the ADR and explain why
the decision should be reopened.
