# Project implementation standards

Apply these standards to every future HTML, CSS, and UI-script change in this repository.

## Markup

- Keep equivalent pages structurally alike from their outermost shared shell inward.
- Use the most appropriate semantic tag for each region and prefer a unique purpose for every wrapper.
- Do not add a wrapper when its parent or child can perform the same job.
- Do not immediately nest two wrappers with the same tag name.
- Remove redundant tags such as unneeded `nav`, `fieldset`, or generic containers, then move necessary behavior to the remaining semantic element.
- Remove attributes that are unused, redundant, or merely restate native HTML behavior.
- Preserve all `data-*` attributes. Prefer `data-*` attributes for UI state that scripts or styles may change.
- Keep accessibility attributes when they provide a real name, relationship, state, or behavior.
- Name button IDs as `<association>-<visible-action>-button`; omit the association only when no context is needed to distinguish the control.
- Remove unused IDs, classes, and hidden elements; retain hidden markup only when scripts reveal it or it provides an active accessibility relationship.

## CSS cascade

- Write mobile presentation as the unqualified default.
- Use one viewport stage at `min-width: 721px` for both tablet and desktop presentation; do not add `max-width` rules or additional width breakpoints.
- Write every shared rule once, at the broadest correct level, and override it only when a different result is intentionally required.
- Initialize the common typography and text properties on `body`.
- Let descendants inherit typography, text, and color values by default.
- Put common element foundations in the appropriate shared foundation stylesheet; keep buttons, controls, and links in `base.css`.
- Keep all foundational table rules in `ui/styles/table.css`; page and component styles may add only table-specific differences.
- Use translucent cyan for a hovered or keyboard-focused table row.
- Represent `tr[data-is-selected="true"]` with solid cyan text only; selection must not add a background.
- Component and page selectors should add only their visual differences; they must not repeat or reset an existing foundation.
- When a component genuinely needs a different value from a shared foundation, expose that value as a CSS custom property in the foundation and override only the custom property at component scope.
- Group elements that intentionally share the same presentation instead of repeating declarations in separate rules.
- Avoid font shorthand in component rules when it would reset inherited font properties. Set only the necessary font longhands.
- Do not assign neutralizing declarations such as zero padding merely to undo a shared rule. Change the shared foundation or expose an intentional component value instead.
- Before adding a declaration, search the cascade and reuse or extend the existing rule when its meaning is shared.

## UI scripts

- Keep selectors synchronized with the current markup; delete references to removed elements.
- Use `Home` for the root directory/creation page and `Room` for the active play page; use `Room` for the internal domain model as well.
- Prefer named functions and class methods over arrow functions in application source.
- Keep function parameters explicit. Do not use a default `options = {}` bag; introduce a small configuration class when an operation genuinely needs grouped options.
- Prefer existing `data-*` state hooks over adding presentation-only classes or attributes.
- Reuse shared timing and configuration constants instead of duplicating values.
- Clear transient dialog content when its owning state ends, and open transition dialogs only when entering that state.
- When a local player exists, rotate displayed player sequences to start with that player while preserving circle order.

## Verification

- When shared markup or CSS changes, verify both `index.html` and `room.html`.
- Confirm that inheritance produces the intended computed styles and that component rules contain only necessary differences.
- Add or update focused tests when markup structure or UI behavior changes.
