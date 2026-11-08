import type { GeneratorConfig } from "./tools/generator/config.js";

/**
 * Point `manual` at your own manual, list the protocols your tools use, and
 * run `npm run generate`.
 *
 * It ships pointed at a fixture the generator's tests use, so the command
 * works in a fresh copy of this template and you can read its output in
 * `src/tools/` before replacing it.
 */
const config: GeneratorConfig = {
	manual: "./tests/generator/fixtures/weather.json",
	protocols: ["http", "sse"],
};

export default config;
