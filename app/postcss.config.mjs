/**
 * PostCSS pipeline for the app.
 *
 * Tailwind is the only styling mechanism (FLINT_BUILD_CONTEXT.md Section 9).
 * TODO-DESIGN: any future design-tooling plugin (or a stylesheet preprocessor)
 * is configured here, never inside components.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
