import fs from "fs";
import path from "path";
import { emitActivity } from "../activity.js";
import { listQaRecipes, runPluginQaSmoke, runQaSteps } from "./qaRunner.js";
import { getWordPressSiteSummary } from "./wordpress.js";

const QA_SCRIPTS_ROOT = path.resolve(process.cwd(), "memory", "qa-scripts");
const RECIPES_ROOT = path.resolve(process.cwd(), "tests", "recipes");

export async function listQaScripts(config) {
  const siteSummary = await getWordPressSiteSummary(config);
  if (!siteSummary.ok) {
    throw new Error(siteSummary.message);
  }

  fs.mkdirSync(QA_SCRIPTS_ROOT, { recursive: true });
  const recipes = listQaRecipes();

  return {
    scriptsRoot: QA_SCRIPTS_ROOT,
    plugins: siteSummary.summary.plugins.items.map((plugin) => {
      const script = readScriptByPluginFile(plugin.file);
      const promoted = recipes.find((recipe) => recipe.product === plugin.name || recipe.id.includes(safeSlug(plugin.name)));
      return summarizeScriptStatus(plugin, script, promoted);
    }),
  };
}

export async function generateQaScript(config, { plugin = "", activity = null } = {}) {
  emitActivity(activity, "test", `Generating QA script for ${plugin}`);
  const siteSummary = await getWordPressSiteSummary(config);
  if (!siteSummary.ok) {
    throw new Error(siteSummary.message);
  }

  const matchedPlugin = matchPlugin(siteSummary.summary.plugins.items, plugin);
  if (!matchedPlugin) {
    throw new Error(`Could not find an installed plugin matching "${plugin}".`);
  }

  emitActivity(activity, "docs", `Finding documentation links for ${matchedPlugin.name}`);
  const docSources = findDocSources(config, matchedPlugin);

  emitActivity(activity, "test", `Discovering admin UI for ${matchedPlugin.name}`);
  const smoke = await runPluginQaSmoke(config, {
    plugin: matchedPlugin.name,
    maxLinks: 5,
    activity,
  });

  const now = new Date().toISOString();
  const existing = readScriptByPluginFile(matchedPlugin.file);
  const script = {
    schemaVersion: 1,
    id: existing?.id || `qa-script-${safeSlug(matchedPlugin.name)}`,
    status: "draft",
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    plugin: {
      name: matchedPlugin.name,
      file: matchedPlugin.file,
      version: matchedPlugin.version || "",
      active: matchedPlugin.active === true,
    },
    sources: {
      docs: docSources,
      adminDiscovery: {
        reportPath: smoke.reportPath,
        selectedAdminPage: smoke.selectedAdminPage,
        exploredLinks: (smoke.exploredLinks || []).map((link) => ({
          text: link.text,
          href: link.href,
          title: link.title,
        })),
      },
    },
    testCases: buildTestCases(matchedPlugin, smoke, docSources),
    runState: {
      nextIndex: 0,
      completed: [],
      lastRun: existing?.runState?.lastRun || null,
    },
  };

  writeScript(script);
  return {
    script,
    summary: summarizeScriptStatus(matchedPlugin, script, null),
  };
}

export async function runNextQaScriptStep(config, { plugin = "", testId = "", activity = null } = {}) {
  const script = plugin ? readRequiredScript(config, plugin) : readMostRecentScript();
  if (!script) {
    throw new Error(plugin ? `No QA script is ready for "${plugin}". Generate it first.` : "No QA script is ready yet.");
  }

  const testCase = testId
    ? script.testCases.find((item) => item.id === testId)
    : script.testCases[script.runState?.nextIndex || 0];

  if (!testCase) {
    throw new Error(`No pending QA test found for ${script.plugin.name}.`);
  }

  if ((testCase.risk || "low") !== "low") {
    return {
      blocked: true,
      reason: `This test is ${testCase.risk} risk and requires confirmation before implementation supports it.`,
      script,
      testCase,
    };
  }

  emitActivity(activity, "test", `Running QA test: ${testCase.title}`);
  const report = await runQaSteps(config, {
    recipe: {
      id: `${script.id}/${testCase.id}`,
      name: testCase.title,
      product: script.plugin.name,
      area: testCase.area || "generated",
      risk: testCase.risk || "low",
      path: script.path || "",
    },
    steps: testCase.steps,
    reportSlug: `${script.id}-${testCase.id}`,
    activity,
  });

  const now = new Date().toISOString();
  const completedItem = {
    testId: testCase.id,
    title: testCase.title,
    status: report.status,
    failure: report.failure || "",
    reportPath: report.reportPath,
    reportHtmlPath: report.reportHtmlPath,
    screenshots: report.screenshots || [],
    ranAt: now,
  };

  const testIndex = script.testCases.findIndex((item) => item.id === testCase.id);
  const completed = (script.runState?.completed || []).filter((item) => item.testId !== testCase.id);
  completed.push(completedItem);
  script.runState = {
    nextIndex: Math.min(testIndex + 1, script.testCases.length),
    completed,
    lastRun: completedItem,
  };
  script.updatedAt = now;
  writeScript(script);

  return {
    script,
    testCase,
    report,
    nextTest: script.testCases[script.runState.nextIndex] || null,
  };
}

export function promoteQaScript(config, { plugin = "" } = {}) {
  const script = readRequiredScript(config, plugin);
  const recipeDir = path.join(RECIPES_ROOT, "generated");
  fs.mkdirSync(recipeDir, { recursive: true });

  const recipePath = path.join(recipeDir, `${safeSlug(script.plugin.name)}.json`);
  const steps = script.testCases.flatMap((testCase) => testCase.steps);
  const recipe = {
    name: `${script.plugin.name} Generated QA`,
    product: script.plugin.name,
    area: "generated",
    risk: "low",
    description: `Generated from local docs/admin discovery for ${script.plugin.name}.`,
    steps,
  };

  fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
  script.status = "promoted";
  script.promotedRecipePath = path.relative(process.cwd(), recipePath);
  script.updatedAt = new Date().toISOString();
  writeScript(script);

  return {
    script,
    recipePath,
    recipeId: `generated/${safeSlug(script.plugin.name)}`,
  };
}

function buildTestCases(plugin, smoke, docSources) {
  const selectedUrl = smoke.selectedAdminPage?.href || "";
  const selectedText = smoke.selectedAdminPage?.text || plugin.name;
  const docTitle = docSources[0]?.title || `${plugin.name} documentation`;
  const isPluginsFallback = selectedText === "Plugins screen fallback";
  const relatedPages = collectRelatedAdminPages(smoke);
  const testCases = [];

  if (isPluginsFallback) {
    testCases.push({
      id: "plugin-entry-loads",
      title: `Open ${plugin.name} plugin entry`,
      area: "wordpress-admin",
      risk: "low",
      source: "plugin metadata",
      expectedResult: "The WordPress Plugins screen opens for this plugin because no matching plugin admin menu was detected.",
      screenshotRequired: true,
      steps: [
        { action: "login_admin" },
        { action: "go_to", path: selectedUrl },
        { action: "screenshot", name: `${plugin.name} plugin entry` },
      ],
    });
  } else {
    testCases.push({
      id: "admin-area-sweep",
      title: `Sweep ${plugin.name} admin area`,
      area: "admin-navigation",
      risk: "low",
      source: "admin discovery",
      expectedResult: "The main plugin admin page and safe related plugin pages load without fatal, console, page, or network errors.",
      screenshotRequired: true,
      steps: [
        { action: "login_admin" },
        { action: "go_to", path: selectedUrl },
        { action: "screenshot", name: `${plugin.name} admin dashboard` },
        ...relatedPages.flatMap((page) => [
          { action: "go_to", path: page.href },
          { action: "screenshot", name: `${plugin.name} ${page.text}` },
        ]),
      ],
    });
  }

  testCases.push({
      id: "plugin-status-visible",
      title: `Verify ${plugin.name} is visible on Plugins screen`,
      area: "wordpress-admin",
      risk: "low",
      source: "installed plugin metadata",
      expectedResult: "The plugin appears on the WordPress Plugins screen with its current status.",
      screenshotRequired: true,
      steps: [
        { action: "login_admin" },
        { action: "go_to", path: `plugins.php?s=${encodeURIComponent(plugin.name)}` },
        { action: "wait_for_text", text: plugin.name, timeout: 12000 },
        { action: "screenshot", name: `${plugin.name} plugin status` },
      ],
  });

  if (!isPluginsFallback && selectedUrl) {
    testCases.push({
      id: "docs-guided-admin-check",
      title: `Docs-guided ${selectedText} check`,
      area: "docs-guided",
      risk: "low",
      source: docTitle,
      expectedResult: "The main admin area related to the docs source is reachable for further manual/deeper testing.",
      screenshotRequired: true,
      steps: [
        { action: "login_admin" },
        { action: "go_to", path: selectedUrl },
        { action: "screenshot", name: `${plugin.name} docs guided check` },
      ],
    });
  }

  return testCases.filter((testCase) => testCase.steps.every((step) => step.action !== "go_to" || step.path));
}

function collectRelatedAdminPages(smoke) {
  const selectedUrl = smoke.selectedAdminPage?.href || "";
  const seen = new Set([selectedUrl]);
  const pages = [];

  for (const link of smoke.exploredLinks || []) {
    const href = link.finalUrl || link.href || "";
    if (!href || seen.has(href)) continue;
    seen.add(href);
    pages.push({
      text: link.text || link.title || "related page",
      href,
    });
  }

  return pages.slice(0, 5);
}

function findDocSources(config, plugin) {
  const root = path.resolve(config.docsRoot, "doc-links");
  if (!fs.existsSync(root)) return [];

  const pluginWords = [...new Set(normalizeWords(`${plugin.name} ${plugin.file}`))];
  const expectedSlugs = [
    safeSlug(plugin.name),
    safeSlug(String(plugin.file || "").split("/")[0] || ""),
  ].filter(Boolean).map((slug) => slug.replace(/^fluent-?/, ""));
  const results = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(root, entry.name);
    const content = fs.readFileSync(filePath, "utf8");
    const product = content.match(/^Product:\s*(.+)$/m)?.[1]?.trim() || entry.name.replace(/\.md$/, "");
    const productWords = [...new Set(normalizeWords(`${product} ${entry.name}`))];
    const score = pluginWords.reduce((sum, word) => sum + (productWords.some((item) => item.includes(word) || word.includes(item)) ? 1 : 0), 0);
    const productSlug = safeSlug(product).replace(/^fluent-?/, "");
    const fileSlug = safeSlug(entry.name.replace(/\.md$/, "")).replace(/^fluent-?/, "");
    const strongProductMatch = expectedSlugs.some((slug) => slug === productSlug || slug === fileSlug || slug.includes(productSlug) || productSlug.includes(slug));
    const distinctiveMatch = score >= Math.min(2, Math.max(pluginWords.length, 1));
    if (!strongProductMatch && !distinctiveMatch) continue;

    for (const section of content.split(/\n## /).slice(1, 5)) {
      const title = section.split(/\r?\n/)[0]?.replace(/^#+\s*/, "").trim();
      const url = section.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
      if (title && url) {
        results.push({
          product,
          title,
          url,
          sourcePath: path.relative(config.docsRoot, filePath),
        });
      }
    }
  }

  return results.slice(0, 8);
}

function summarizeScriptStatus(plugin, script, promoted) {
  const lastRun = script?.runState?.lastRun || null;
  return {
    plugin,
    status: script?.status === "promoted" || promoted ? "Promoted recipe" : script ? "Draft ready" : "Not ready",
    scriptId: script?.id || "",
    testCount: script?.testCases?.length || 0,
    nextIndex: script?.runState?.nextIndex || 0,
    nextTest: script?.testCases?.[script?.runState?.nextIndex || 0]?.title || "",
    lastRun,
    promotedRecipePath: script?.promotedRecipePath || promoted?.path || "",
  };
}

function readRequiredScript(config, pluginQuery) {
  const scripts = readAllScripts();
  const matched = scripts.find((script) => matchPlugin([script.plugin], pluginQuery));
  if (!matched) {
    throw new Error(`No QA script is ready for "${pluginQuery}".`);
  }
  return matched;
}

function readMostRecentScript() {
  return readAllScripts().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || null;
}

function readScriptByPluginFile(pluginFile) {
  return readAllScripts().find((script) => script.plugin?.file === pluginFile) || null;
}

function readAllScripts() {
  fs.mkdirSync(QA_SCRIPTS_ROOT, { recursive: true });
  return fs.readdirSync(QA_SCRIPTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      try {
        const script = JSON.parse(fs.readFileSync(path.join(QA_SCRIPTS_ROOT, entry.name), "utf8"));
        script.path = path.relative(process.cwd(), path.join(QA_SCRIPTS_ROOT, entry.name));
        return script;
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}

function writeScript(script) {
  fs.mkdirSync(QA_SCRIPTS_ROOT, { recursive: true });
  const scriptPath = path.join(QA_SCRIPTS_ROOT, `${safeSlug(script.plugin.name)}.json`);
  script.path = path.relative(process.cwd(), scriptPath);
  fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
}

function matchPlugin(plugins, query) {
  const terms = normalizeWords(query);
  if (!terms.length) return null;

  const scored = plugins.map((plugin) => {
    const haystack = normalizeWords(`${plugin.name} ${plugin.file}`);
    const score = terms.reduce((sum, term) => sum + (haystack.some((word) => word.includes(term) || term.includes(word)) ? 3 : 0), 0);
    return { plugin, score };
  }).sort((a, b) => b.score - a.score || a.plugin.name.localeCompare(b.plugin.name));

  return scored[0]?.score > 0 ? scored[0].plugin : null;
}

function safeSlug(value) {
  return String(value || "plugin").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function normalizeWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .filter((word) => !["plugin", "plugins", "addon", "free", "pro", "fluent"].includes(word));
}
