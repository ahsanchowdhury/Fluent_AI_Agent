import { getConfig, loadEnv } from "../src/env.js";
import { activateTheme, listThemes } from "../src/tools/wordpress.js";

loadEnv();
const config = getConfig();
const [action, stylesheet, approval] = process.argv.slice(2);

if (action === "list") {
  const result = await listThemes(config);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} else if (action === "activate" && stylesheet) {
  if (approval !== "--yes") {
    console.error("Refusing to change theme without --yes.");
    process.exit(1);
  }
  const result = await activateTheme(config, stylesheet);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} else {
  console.error("Usage: npm run wp:theme -- list OR npm run wp:theme -- activate <stylesheet> --yes");
  process.exit(1);
}
