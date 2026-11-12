# Pick 2 — Software Documentation Register

| Document ID | Revision | Software baseline |
| --- | --- | --- |
| P2-DOC | 2.0 | 2026-11-12; package version 1.0.0, working tree |

## 1. Purpose and scope

This register defines the controlled documentation set for the Pick 2 browser game.
The documents use IEEE/ISO/IEC software-documentation conventions: identified
information items, numbered sections, explicit requirements, design viewpoints,
interface contracts, and verification traceability. They are tailored project
specifications, not an assertion of clause-by-clause standards conformance.

## 2. Document register and reading order

| ID | Information item | Authoritative subject | Primary reader |
| --- | --- | --- | --- |
| P2-SRS | [Software requirements specification](software-requirements-specification.md) | Required behavior, rules, quality attributes, and limits of scope | Owner, developer, tester |
| P2-SDD | [Software design description](software-design-description.md) | Architecture, UML, data ownership, runtime sequences, and design decisions | Developer, maintainer |
| P2-ICD | [Interface control document](interface-control-document.md) | WebSocket contracts, public snapshots, browser interfaces, and transport limits | Integrator, operator |
| P2-VVP | [Verification and validation plan](verification-and-validation-plan.md) | Test strategy, requirement traceability, acceptance procedures, and evidence | Tester, reviewer |
| P2-OM | [Operations and maintenance guide](operations-and-maintenance.md) | Installation, hosting, configuration, development, and static preview | Operator, maintainer |
| P2-UM | [User manual](user-manual.md) | Everyday Local/Live workflows and recovery | Player, viewer |

Read P2-SRS before P2-SDD or P2-ICD. Use P2-UM to play, P2-OM to run or change the
software, and P2-VVP to assess a change. The repository README remains the quick start.

## 3. Documentation conventions and authority

### 3.1 Normative language

**Shall** states a requirement; **shall not** states a prohibition. **Should** states
an advisory practice, and **may** states permission. Normative product requirements
have stable `P2-FR-`, `P2-NFR-`, or `P2-DC-` identifiers in P2-SRS. P2-ICD defines the
corresponding field-level contracts. Examples illustrate those contracts without
adding requirements. Section numbers are local to each document.

### 3.2 Baseline and change control

The baseline identifies the inspected working tree, not a released or formally
approved build. Git records authorship, review, and subsequent revisions. Change
public behavior in the implementation, P2-SRS, affected design/interface sections,
user-facing FAQ, and verification mapping together. A discovered mismatch is an
issue to resolve; documentation shall not silently redefine implemented behavior.

### 3.3 Single ownership and consolidation

Requirements appear in P2-SRS; implementation rationale appears in P2-SDD; field
schemas and deployment-limit tables appear in P2-ICD. Other documents reference
those owners. Test commands and acceptance criteria belong to P2-VVP; fixture
implementation details remain in `test/README.md`. P2-OM owns setup and coding
conventions; P2-UM owns user procedures.

The former `pick-2.md`, `requirements.md`, `architecture.md`, `data-model.md`,
`application-flow.md`, `rest-api.md`, `connection-protection.md`, `testing.md`,
`development.md`, `ui-preview.md`, and `user-guide.md` are superseded by this set.
Their unique rules, diagrams, card interaction contracts, and preview controls are
integrated below the appropriate information item rather than retained as duplicates.

## 4. Terms and abbreviations

| Term | Meaning |
| --- | --- |
| Home / Connection / Room | Browser directory, connection recovery, and play/view pages |
| Direct / Local | Browser-owned Host; custom open seats fill with bots |
| Hosted / Live | Shared Node Host; WebSocket session admission, commands, and push |
| Player / viewer / bot | Seated participant / unseated observer / automated Player |
| Match / Knockout | One deal and result / series with elimination and a two-player final |
| Collection / penalty | Card storage / sum of the remaining card ranks |
| Host / RoomService | Membership and command authority / serialized game workflows |
| Snapshot / envelope | Recipient-specific state / `{ view, message, data }` delivery object |
| SRS / SDD / ICD / VVP | Requirements / design / interfaces / verification and validation |

## 5. References

The public catalogue descriptions establish the scope of these references; their
full normative texts have not been used to certify this document set. Reference
numbers are shared across the documents. All online references were accessed
November 11, 2026.

[1] ISO/IEC/IEEE, *Systems and software engineering — Life cycle processes —
Requirements engineering*, ISO/IEC/IEEE 29148:2018. [Online]. Available:
[ISO catalogue](https://www.iso.org/standard/72089.html).

[2] IEEE, *IEEE Standard for Information Technology—Systems Design—Software Design
Descriptions*, IEEE Std 1016-2009. Historical SDD organizational guidance;
IEEE lists this edition as inactive-reserved. [Online]. Available:
[IEEE catalogue](https://standards.ieee.org/ieee/1016/4502/).

[3] ISO/IEC/IEEE, *Software, systems and enterprise — Architecture description*,
ISO/IEC/IEEE 42010:2022. Architecture stakeholders, concerns, and viewpoints.
[Online]. Available: [ISO catalogue](https://www.iso.org/standard/74393.html).

[4] ISO/IEC/IEEE, *Software and systems engineering — Software testing — Part 3:
Test documentation*, ISO/IEC/IEEE 29119-3:2021. [Online]. Available:
[ISO catalogue](https://www.iso.org/standard/79429.html).

[5] ISO/IEC/IEEE, *Systems and software engineering — Design and development of
information for users*, ISO/IEC/IEEE 26514:2022. [Online]. Available:
[ISO catalogue](https://www.iso.org/standard/77451.html).
