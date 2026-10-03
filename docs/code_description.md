# Module code description

This document describes the current DiGiCo OSC Companion module structure and the ordinary command path. Macro, Preset, and Snapshot commands are being handled separately and are not included in the current command CSV.

## Command table

`digico_osc.csv` is the source for ordinary actions and value feedbacks. Its columns are:

| Column | Use |
| --- | --- |
| `osc_path` | OSC address template. Each `*` is a path parameter. |
| `data_type` | OSC value type. Blank means a message with no arguments. |
| `osc_min`, `osc_max` | Numeric option bounds in the units shown to the user. |
| `rw` | `R` enables value feedback and Learn; `W` enables an action. Blank skips both. |
| `description` | Action and feedback description shown in Companion. |
| `units` | Appended to numeric value labels, and used to choose dB cross-fade behavior. |
| `Scale` | UI-to-wire scale. UI values are sent divided by this number; received values are multiplied by it. |

`digico_osc_old.csv` is the previous table retained as a reference. The active table leaves out Macro, Preset, and Snapshot rows.

## Parsing and derived names

`src/commandTable.ts` reads CSV columns by header, parses numeric bounds and scale, and creates `CommandRow` values. Action and feedback names are derived from the OSC path: the first path segment becomes the bracketed category, remaining segments become the command name, and `_` or `-` are rendered as spaces with initial capitalization. Wildcard segments are omitted from the displayed name.

The parser has a small quoted-field reader because descriptions may contain commas. Path helpers count and label wildcards, substitute selected indexes into a path, and match an incoming path against a wildcard template.

## Selector discovery

`src/selectorProviders.ts` derives selector sources from CSV paths that contain a wildcard and end in `/name`. For each name path, it derives the section from the first OSC path segment, the count query as `/Console/{section}`, and uses 512 as the maximum index. The selector options use cached names when available and otherwise display the section label and index. A nested `Aux_Send`, `Group_Send`, or `Matrix_Send` selector resolves to the corresponding output section by replacing the `_Send` suffix with `_Outputs`.

At startup, `src/main.ts` queries `/Console/Channels`, then queries each derived section count and the names for its items. If a count is unavailable, it checks name paths in order until the console stops replying. The resulting counts and names feed selector options and module variables. New name values cause action and feedback definitions to refresh.

## Actions and value feedbacks

`src/actions.ts` has one generic builder for writable CSV rows. `src/feedbacks.ts` has one generic builder for readable rows. Rows with blank `rw` are skipped. Option types, bounds, descriptions, units, value transforms, and path parameters all come from the row or are derived from its OSC path.

Each wildcard creates a multi-select action option with an `All` choice. Selected indexes are expanded into concrete OSC paths. Value inputs use a text field for `String`, no value field for blank `data_type`, and a numeric field or enum dropdown for other types. `BInt` and `BFloat` use the underlying `Int` and `Float` OSC types and the shared Off/On/Toggle mapping. Feedbacks use a dropdown for a single path parameter; array-valued `/modes` feedbacks use a multi-select and return the selected values as an array.

`src/value-mappings.json` stores labels for enums. Shared enum labels are stored once and used for both actions and feedbacks. Boolean action and feedback values stay separate because only the action offers Toggle. Mapping keys are derived from the final OSC path segment, with numbered parameter suffixes handled by the mapping lookup. Mode feedback selector paths are found by matching the section to its `/name` path in the CSV.

Numeric action and feedback values apply `Scale` generically. For example, a millisecond value with `Scale` 1000 is sent as seconds and received values are displayed in milliseconds. Relative changes are linear. Cross-fades interpolate in dB amplitude space for `dB` units and linearly for other numeric units.

## OSC runtime

`src/main.ts` owns the Companion instance, command rows, latest OSC values, selector discovery, and feedback subscriptions. A feedback reads a cached value and queries the console on a cache miss. Incoming values update the cache and refresh feedbacks watching that path. Incoming floating-point values are truncated to six decimal places.

`src/mixers.ts` manages the console UDP socket, outgoing message queue, and request timeouts. Queries use DiGiCo's `/?` suffix. `src/osc.ts` encodes and decodes OSC packets, including bundles, strings, numeric values, blobs, boolean-like tags, and meter payloads.

`src/ipadRelay.ts` optionally forwards UDP packets between the console and an iPad. Forwarded packets remain unchanged; decoding is used for logging and filename-query suppression.

## Recording, variables, and upgrades

`src/actionRecorder.ts` matches incoming messages to writable CSV paths and records matching actions with their wildcard indexes and argument value. Repeated identical values are suppressed.

`src/variables.ts` defines the module's selector-count and session-filename variables. `src/upgrades.ts` contains migrations for previously saved Companion configurations; it is separate from the ordinary action and feedback builders.
