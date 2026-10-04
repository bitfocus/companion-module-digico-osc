# Module code description

This document describes the current DiGiCo OSC Companion module structure and its CSV-driven command handling.

## Command table

`digico_osc.csv` contains ordinary OSC commands. `digico_entities.csv` contains Snapshot, Preset, and Macro commands; it uses the same command columns and adds a few optional behavior fields. Both files are parsed into the same `CommandRow` list and use the same action and feedback builders.

The shared command columns are:

| Column | Use |
| --- | --- |
| `osc_path` | OSC address template. Each `*` is a path parameter. |
| `data_type` | OSC value type. Blank means a message with no arguments. |
| `osc_min`, `osc_max` | Numeric option bounds in the units shown to the user. |
| `rw` | `R` enables value feedback and Learn; `W` enables an action. Blank skips both. |
| `description` | Action and feedback description shown in Companion. |
| `units` | Appended to numeric value labels, and used to choose dB cross-fade behavior. |
| `Scale` | UI-to-wire scale. UI values are sent divided by this number; received values are multiplied by it. |

`digico_entities.csv` adds optional `action_schema`, `feedback_schema`, `refresh_entity`, `value_selector_label`, and `learn_schema` columns. These are blank unless a command needs an entity-specific option or reply layout, changes a list, or learns a value from an entity record. The schema names select generic behavior inside the shared builders; they do not select separate Macro, Preset, or Snapshot builders. `src/entity-schemas.json` stores the positional fields for named entity replies and the fixed FX target count. `digico_osc_old.csv` is retained as a reference.

## Parsing and derived names

`src/commandTable.ts` reads CSV columns by header, parses numeric bounds and scale, and creates `CommandRow` values. Action and feedback names are derived from the OSC path: the first path segment becomes the bracketed category, remaining segments become the command name, and `_` or `-` are rendered as spaces with initial capitalization. Wildcard segments are omitted from the displayed name.

The parser has a small quoted-field reader because descriptions may contain commas. Path helpers count and label wildcards, substitute selected indexes into a path, and match an incoming path against a wildcard template.

## Selector discovery

`src/selectorProviders.ts` derives ordinary selector sources from CSV paths that contain a wildcard and end in `/name`. For each name path, it derives the section from the first OSC path segment, the count query as `/Console/{section}`, and uses 512 as the maximum index. The selector options use cached names when available and otherwise display the section label and index. A nested `Aux_Send`, `Group_Send`, or `Matrix_Send` selector resolves to the corresponding output section by replacing the `_Send` suffix with `_Outputs`.

At startup, `src/main.ts` queries `/Console/Channels`, then queries each derived section count and the names for its items. If a count is unavailable, it checks name paths in order until the console stops replying. The resulting counts and names feed selector options and module variables. Entity list paths and counts are derived from the entity record schema roots. Each entity uses its count and `/names` query; individual `/name` replies are parsed using the positional field names in `src/entity-schemas.json`. New name values cause action and feedback definitions to refresh. Runtime value reads use the OSC cache first; a cache miss sends one query per path/index, stores the reply in the cache, and returns it to the caller. Feedbacks, action learn, and relative or cross-fade actions all use this read path.

## Actions and value feedbacks

`src/actions.ts` has one generic builder for writable CSV rows. `src/feedbacks.ts` has one generic builder for readable rows. Rows with blank `rw` are skipped. Option types, bounds, descriptions, units, value transforms, and path parameters all come from the row or are derived from its OSC path.

Ordinary wildcards create multi-select action options with an `All` choice. Entity wildcards use a single dropdown backed by the loaded entity list. Selected indexes are expanded into concrete OSC paths. Value inputs use a text field for `String`, no value field for blank `data_type`, and a numeric field or enum dropdown for other types. `BInt` and `BFloat` use the underlying `Int` and `Float` OSC types and the shared Off/On/Toggle mapping. Feedbacks use a dropdown for a single path parameter; array-valued `/modes` feedbacks use a multi-select and return the selected values as an array. Entity info feedbacks return the parsed JSON record.

Preset action rows use `action_schema` to describe the few composite operations. They share the generic action definition path, show a Section option, and build section-filtered item, group, and target choices from the loaded preset records and ordinary selector data. Recall scope choices come from `src/value-mappings.json`; recall sends that scope through `/Presets/Recall_Scope` before sending the selected preset and target. New preset creation waits for the console's creation message to trigger a list refresh, then sends the name using the discovered index. The console may omit a locked preset from its refreshed `/Presets/names` list; when that happens, the preset disappears from the module's preset choices, and an existing action selection for that index can become invalid. This reflects the list returned by the console. Unsolicited console messages matching a CSV row with `refresh_entity` trigger the corresponding count and list refresh; query replies are cached but do not trigger list refreshes, and actions do not trigger refreshes themselves. Recall rows leave `refresh_entity` blank.

`src/value-mappings.json` stores labels for enums. Shared enum labels are stored once and used for both actions and feedbacks. Boolean action and feedback values stay separate because only the action offers Toggle. Mapping keys are derived from the final OSC path segment, with numbered parameter suffixes handled by the mapping lookup. Mode feedback selector paths are found by matching the section to its `/name` path in the CSV.

Numeric action and feedback values apply `Scale` generically. For example, a millisecond value with `Scale` 1000 is sent as seconds and received values are displayed in milliseconds. Relative changes are linear. Cross-fades interpolate in dB amplitude space for `dB` units and linearly for other numeric units.

## OSC runtime

`src/main.ts` owns the Companion instance, command rows, latest OSC values, selector discovery, and feedback subscriptions. A feedback reads a cached value and queries the console on a cache miss. Incoming values update the cache and refresh feedbacks watching that path. Incoming floating-point values are truncated to six decimal places.

`src/mixers.ts` manages the console UDP socket, outgoing message queue, and request timeouts. Queries use DiGiCo's `/?` suffix. `src/osc.ts` encodes and decodes OSC packets, including bundles, strings, numeric values, blobs, boolean-like tags, and meter payloads.

`src/ipadRelay.ts` optionally forwards UDP packets between the console and an iPad. Forwarded packets remain unchanged; decoding is used for logging and filename-query suppression.

## Recording, variables, and upgrades

`src/actionRecorder.ts` matches incoming messages to writable CSV paths and records matching actions with their wildcard indexes and argument value. Repeated identical values are suppressed.

`src/variables.ts` defines the module's selector-count and session-filename variables. `src/upgrades.ts` contains migrations for previously saved Companion configurations; it is separate from the ordinary action and feedback builders.
