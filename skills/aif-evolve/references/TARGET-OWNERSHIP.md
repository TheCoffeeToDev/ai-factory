# Resolve Evolve Targets

Read in Step 0.1, before reading target instructions or proposing changes. Skill
names, including the `aif-` prefix, are not ownership evidence. Scope and ownership
are separate: `--global` selects a location, not permission to edit managed skills.

## Arguments and Search Roots

1. Tokenize `$ARGUMENTS`. Extract the exact `--global` flag independently of its
   position; `all --global` and `--global all` mean the same thing. The remaining
   zero or one token is the selector (default `all`). Reject unknown flags, repeated
   `--global`, extra selectors, traversal, and path separators after removing one
   leading invocation `/`. Require a simple skill identifier (letters, digits,
   `_`, `-`, `.`; no `..`). Do not treat `--global` as part of a skill name.
2. Default scope is **project**. Search the active runtime's project skill root
   (`{{skills_dir}}`, resolved from the current project) and use `skills/` only as
   a development fallback for a missing installed target. Do not union installed
   and development copies. Never search user-global roots in default scope.
3. With `--global`, select **only existing user-global skills** for the active
   runtime, not project skills. Discover roots from the runtime's actual skill
   catalog/configuration. Do not assume its project-relative directory is also
   its global directory. If the global root is unknown, ask for its absolute path
   before continuing; do not scan the home directory or install anything.
4. Expand a leading `~/` using the actual home directory from the runtime/environment
   (`os.homedir()` when using Node). Resolve paths to absolute canonical paths,
   following symlinks with a filesystem tool or `realpath`. Never send a literal
   `~` to Read, Glob, Write, or Edit. If canonicalization is unavailable, stop and
   name the missing capability instead of guessing scope. Use properly quoted
   literal path operands with `realpath`; never interpolate selectors as shell code.
5. Check canonical containment using path components, not a string prefix. In
   project scope, both roots and targets must remain inside the canonical project
   root. A project link into a global directory is outside project scope, even if its
   lexical path is local. An escape outside the selected roots is not authorized
   by `--global`. Deduplicate aliases of the same physical file. If distinct files
   match the same name in the selected scope, ask which exact path to use.
6. Prefer an exact skill-name match. Only when absent, try `aif-<selector>` as a
   short alias for a **verified AI Factory built-in**. An exact custom `plan`
   must not be shadowed by `aif-plan`. Locate the runtime's actual skill entrypoint;
   flat workflow installations need not contain `<name>/SKILL.md`.

On failure, report the selector, selected scope, and absolute roots/entrypoints
actually searched (or why a root could not be resolved). Do not silently fall back
to another scope. In `all` mode, report skipped entries and reasons; in named mode,
an unresolved or unsafe target stops before analysis or writes.

## Ownership and Write Destination

For each physical target, inspect available installation provenance, not just its
name or frontmatter. For project installations, read `.ai-factory.json` for the
matching runtime/root and registered `.ai-factory/extensions/**/extension.json`
manifests. Extension `skills` paths install under their basename unless `replaces`
maps that source path to a built-in name; account for runtime filename transforms.
`extensions[].replacedSkills` is also managed ownership evidence. Extension claims
take precedence over built-in names, including a replacement named `aif-plan`.
Missing registered manifests or conflicting records leave ownership unresolved.

| Owner | Required evidence | Permitted destination |
|-------|-------------------|-----------------------|
| AI Factory built-in | Matching AI Factory installation record for this physical runtime/root and bundled skill, with extension claims excluded; or verified AI Factory package source inventory | Project scope: `.ai-factory/skill-context/<name>/SKILL.md` only. Global scope: skip with a warning; no global override contract exists |
| Extension-managed | Matching extension source/installation manifest or replacement record | Warn that updates overwrite edits; skip with no writes to the installed copy or extension source, and no synthetic built-in skill-context |
| User-owned | Verified project/user skill source outside managed inventories, or explicit user confirmation of ownership when provenance is absent | Exact resolved entrypoint (or explicitly proposed existing nested file), in the selected scope only |
| Unknown / conflicting | Insufficient or conflicting provenance | No writes; explain the missing evidence and ask for clarification in named mode, or skip in `all` mode |

An absent manager record alone does not prove user ownership. A custom skill called
`aifhub-custom-skill` or `aif-team-helper` is not built-in merely because of its name.
Do not offer direct managed-file editing as an approval option. Changing an extension
or package source is a separate maintenance task, outside this evolve run.

Freeze a target record for every eligible skill:

```
name | scope | canonical base entrypoint | owner + evidence | exact write destination
```

Show these records and any skips before generating candidates. Use them throughout
Steps 2–7, including stale cleanup, candidate cards, approval, and logs. Do not
reconstruct a destination from a name later. Project context may inform global
user-owned candidates, but those edits affect every project using that global skill;
state that reach and the exact absolute output path in the approval request.
Logs and the patch cursor remain in the current project's configured evolution
directory in either scope; `--global` does not relocate AI Factory artifacts.

Before every write or stale-rule deletion, recheck canonical containment, ownership
evidence, and the recorded instruction baseline. For a new context file, canonicalize
its nearest existing parent and verify it remains inside the project. A symlink swap,
ownership change, or baseline drift invalidates the proposal: stop that target,
resolve it again, and revalidate/reapprove any changed destination or content.
Skill-context overrides cannot relax these ownership or scope boundaries.
