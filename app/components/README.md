# Flint components

Intentionally empty.

Section 10 of the build context places the app's components here, but Phase 0
ships no components: the only screen is a boot check, and its structure lives
directly in `app/app/page.tsx`. Components arrive with the flows that need them
(Phase 3, human flow), built against the UX standard in Section 9:

- semantic HTML — real `<button>` and `<label>`, not styled `<div>`s;
- no hardcoded colour, font or spacing — those come from the tokens in
  `app/app/globals.css`;
- `{/* TODO-DESIGN: ... */}` markers wherever the design pass will touch;
- visible loading, success and error states for every async action.
