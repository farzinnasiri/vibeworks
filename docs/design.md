# Design principles

VibeWorks is built for agents to do mechanical work and people to review and direct it. Manual tools remain
useful, but the interface should help a reviewer understand the design and choose the next action.

## Start with the whole journey

A person should know where they are, what is selected, who owns it, what an action changes and how to return.
A component's source and its placement are different objects. Source editing must explain its shared effect
and preserve the return path to the originating assembly.

The model explorer holds navigable objects. The viewport shows spatial relationships and selection. Details
holds the selected object's properties or the active task. Avoid duplicating the same list in several panels.
Use the [glossary](glossary.md) rather than inventing competing names.

## Show the decision first

Prefer visual choices for geometry, materials, views and scenes. Disclose topology identifiers, advanced
settings and raw diagnostics when they are needed. Choose a source before placement; preview before Apply;
keep Cancel and the commit action reachable.

Preserve drafts, camera, selection and location when panels change or a person returns from another mode.
View-only actions must not quietly edit the saved design. A source edit, a placement override and a Studio
look should communicate their different scope.

## Make evidence legible

History describes committed changes. Activity describes participants, intent and observed operations.
Analysis distinguishes current, pending, stale and unknown results. Do not use a render, connection indicator
or self-reported agent status as proof that a design is valid or a job is finished.

Explain failures in terms of the task and offer the next valid action. Detailed diagnostics remain available,
but implementation metadata should not dominate ordinary modeling or review.

## Keep the interface coherent

Reuse the existing spacing, type, color, control and motion patterns. Motion should explain a state change,
preserve readable content and handle reversal without jumps. Respect reduced motion and immediate keyboard
feedback. Avoid animating the modeling canvas as a substitute for solving panel layout.

Check complete interactions with long names, enlarged text, keyboard access, light/dark/system appearance
and narrow layouts. Use meaningful accessible names, visible focus and reachable actions. Touch targets
should be at least 44 pixels. A successful build is not evidence that a person can complete a journey.
