import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { normalizeInsideRoot } from "./filesystem.js";

const MAX_LOG_BYTES = 200 * 1024;

export function getWordPressRoot(pluginRoot) {
  return path.resolve(pluginRoot, "..", "..");
}

export function tailDebugLog(logPath, lines = 120) {
  if (!fs.existsSync(logPath)) {
    return {
      exists: false,
      path: logPath,
      content: "",
      message: "Debug log does not exist.",
    };
  }

  const stat = fs.statSync(logPath);
  const start = Math.max(0, stat.size - MAX_LOG_BYTES);
  const file = fs.openSync(logPath, "r");
  const buffer = Buffer.alloc(stat.size - start);

  try {
    fs.readSync(file, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(file);
  }

  const content = buffer
    .toString("utf8")
    .split(/\r?\n/)
    .slice(-Math.max(1, lines))
    .join("\n");

  return {
    exists: true,
    path: logPath,
    bytes: stat.size,
    lines,
    content,
  };
}

export function lintPhpFile(pluginRoot, targetPath) {
  const { resolved, relative } = normalizeInsideRoot(pluginRoot, targetPath);

  if (!resolved.endsWith(".php")) {
    return Promise.resolve({
      ok: false,
      path: relative,
      message: "Only PHP files can be linted with php -l.",
    });
  }

  return runCommand("php", ["-l", resolved]).then((result) => ({
    ok: result.ok,
    path: relative,
    message: result.output,
  }));
}

export function wpCliPluginList(pluginRoot) {
  const wpRoot = getWordPressRoot(pluginRoot);

  return runCommand("wp", [
    `--path=${wpRoot}`,
    "plugin",
    "list",
    "--fields=name,status,version",
    "--format=json",
  ]).then((result) => {
    if (!result.ok) {
      return {
        ok: false,
        wordpressRoot: wpRoot,
        message: result.output,
      };
    }

    try {
      return {
        ok: true,
        wordpressRoot: wpRoot,
        plugins: JSON.parse(result.output),
      };
    } catch (error) {
      return {
        ok: false,
        wordpressRoot: wpRoot,
        message: `WP-CLI returned invalid JSON: ${error.message}\n${result.output}`,
      };
    }
  });
}

export function getWordPressSiteSummary(config) {
  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    if (!function_exists('get_plugins')) {
      require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    $theme = wp_get_theme();
    $plugins = get_plugins();
    $active_plugins = (array) get_option('active_plugins', array());
    $active_lookup = array_fill_keys($active_plugins, true);
    $plugin_rows = array();
    foreach ($plugins as $file => $plugin) {
      $plugin_rows[] = array(
        'file' => $file,
        'name' => $plugin['Name'] ?? $file,
        'version' => $plugin['Version'] ?? '',
        'active' => isset($active_lookup[$file]),
      );
    }
    usort($plugin_rows, function($a, $b) {
      return strcasecmp($a['name'], $b['name']);
    });
    $post_types = array('post', 'page');
    $counts = array();
    foreach ($post_types as $type) {
      $count = wp_count_posts($type);
      $counts[$type] = array(
        'publish' => (int) ($count->publish ?? 0),
        'draft' => (int) ($count->draft ?? 0),
        'pending' => (int) ($count->pending ?? 0),
        'private' => (int) ($count->private ?? 0),
        'trash' => (int) ($count->trash ?? 0),
      );
    }
    $users = count_users();
    echo wp_json_encode(array(
      'site' => array(
        'name' => get_bloginfo('name'),
        'url' => home_url('/'),
        'admin_email' => get_bloginfo('admin_email'),
        'wordpress_version' => get_bloginfo('version'),
      ),
      'theme' => array(
        'name' => $theme->get('Name'),
        'version' => $theme->get('Version'),
        'stylesheet' => get_stylesheet(),
        'template' => get_template(),
      ),
      'plugins' => array(
        'total' => count($plugin_rows),
        'active' => count($active_plugins),
        'inactive' => max(0, count($plugin_rows) - count($active_plugins)),
        'items' => $plugin_rows,
      ),
      'content' => $counts,
      'users' => array(
        'total' => (int) ($users['total_users'] ?? 0),
        'roles' => $users['avail_roles'] ?? array(),
      ),
    ));
  `;

  return runCommand(config.phpBinary || "php", ["-r", $trimPhp(phpCode)]).then((result) => {
    if (!result.ok) {
      return {
        ok: false,
        wordpressRoot: wpRoot,
        message: result.output,
      };
    }

    try {
      return {
        ok: true,
        wordpressRoot: wpRoot,
        summary: JSON.parse(result.output),
      };
    } catch (error) {
      return {
        ok: false,
        wordpressRoot: wpRoot,
        message: `WordPress summary returned invalid JSON: ${error.message}\n${result.output}`,
      };
    }
  });
}

export function changePluginStatus(config, pluginFile, action) {
  if (!["activate", "deactivate"].includes(action)) {
    return Promise.resolve({ ok: false, message: `Unsupported plugin action: ${action}` });
  }

  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    if (!function_exists('get_plugins')) {
      require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    $plugin_file = ${JSON.stringify(pluginFile)};
    $plugins = get_plugins();
    if (!isset($plugins[$plugin_file])) {
      echo wp_json_encode(array('ok' => false, 'message' => 'Plugin not found: ' . $plugin_file));
      exit;
    }
    if (${JSON.stringify(action)} === 'activate') {
      $result = activate_plugin($plugin_file);
      if (is_wp_error($result)) {
        echo wp_json_encode(array('ok' => false, 'message' => $result->get_error_message()));
        exit;
      }
    } else {
      deactivate_plugins($plugin_file);
    }
    echo wp_json_encode(array(
      'ok' => true,
      'action' => ${JSON.stringify(action)},
      'plugin' => $plugin_file,
      'active' => is_plugin_active($plugin_file),
    ));
  `;

  return runWordPressJson(config, wpRoot, phpCode);
}

export function changeAllPluginsStatus(config, action) {
  if (!["activate", "deactivate"].includes(action)) {
    return Promise.resolve({ ok: false, message: `Unsupported all-plugins action: ${action}` });
  }

  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    if (!function_exists('get_plugins')) {
      require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    $action = ${JSON.stringify(action)};
    $plugins = get_plugins();
    $active_before = (array) get_option('active_plugins', array());
    $active_lookup = array_fill_keys($active_before, true);
    $changed = array();
    $errors = array();
    if ($action === 'activate') {
      foreach (array_keys($plugins) as $plugin_file) {
        if (isset($active_lookup[$plugin_file])) {
          continue;
        }
        ob_start();
        $result = activate_plugin($plugin_file);
        ob_end_clean();
        if (is_wp_error($result)) {
          $errors[] = array('plugin' => $plugin_file, 'message' => $result->get_error_message());
          continue;
        }
        if (is_plugin_active($plugin_file)) {
          $changed[] = $plugin_file;
        }
      }
    } else {
      if (!empty($active_before)) {
        deactivate_plugins($active_before);
        $changed = array_values($active_before);
      }
    }
    $active_after = (array) get_option('active_plugins', array());
    echo wp_json_encode(array(
      'ok' => true,
      'action' => $action . '_all_plugins',
      'count' => count($changed),
      'plugins' => array_values($changed),
      'errors' => $errors,
      'active_after' => count($active_after),
    ));
  `;

  return runWordPressJson(config, wpRoot, phpCode);
}

export function installWordPressOrgPlugin(config, query, options = {}) {
  const pluginQuery = String(query || "").trim();
  if (!pluginQuery) {
    return Promise.resolve({ ok: false, message: "Plugin name or slug is required." });
  }

  const activate = options.activate !== false;
  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    require_once ABSPATH . 'wp-admin/includes/plugin-install.php';
    require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/misc.php';

    $query = ${JSON.stringify(pluginQuery)};
    $activate = ${activate ? "true" : "false"};
    $slug = sanitize_title($query);
    $info = plugins_api('plugin_information', array(
      'slug' => $slug,
      'fields' => array(
        'sections' => false,
        'description' => false,
        'ratings' => false,
        'reviews' => false,
      ),
    ));

    if (is_wp_error($info)) {
      $search = plugins_api('query_plugins', array(
        'search' => $query,
        'per_page' => 5,
        'fields' => array(
          'sections' => false,
          'description' => false,
          'ratings' => false,
          'reviews' => false,
        ),
      ));

      if (is_wp_error($search) || empty($search->plugins)) {
        $message = is_wp_error($search) ? $search->get_error_message() : 'No WordPress.org plugin matched: ' . $query;
        echo wp_json_encode(array('ok' => false, 'message' => $message));
        exit;
      }

      $selected = $search->plugins[0];
      foreach ($search->plugins as $candidate) {
        if (isset($candidate['slug']) && strtolower($candidate['slug']) === strtolower($slug)) {
          $selected = $candidate;
          break;
        }
        if (isset($candidate['name']) && strtolower($candidate['name']) === strtolower($query)) {
          $selected = $candidate;
          break;
        }
      }
      $slug = $selected['slug'];
      $info = plugins_api('plugin_information', array(
        'slug' => $slug,
        'fields' => array(
          'sections' => false,
          'description' => false,
          'ratings' => false,
          'reviews' => false,
        ),
      ));
    }

    if (is_wp_error($info)) {
      echo wp_json_encode(array('ok' => false, 'message' => $info->get_error_message()));
      exit;
    }

    $plugins_before = get_plugins();
    $plugin_file = fluent_ai_find_plugin_file($slug, $plugins_before);
    $installed = (bool) $plugin_file;
    $install_output = '';

    if (!$installed) {
      if (empty($info->download_link)) {
        echo wp_json_encode(array('ok' => false, 'message' => 'No download link found for plugin: ' . $slug));
        exit;
      }

      $skin = new Automatic_Upgrader_Skin();
      $upgrader = new Plugin_Upgrader($skin);
      ob_start();
      $install_result = $upgrader->install($info->download_link);
      $install_output = trim(ob_get_clean());

      if (is_wp_error($install_result)) {
        echo wp_json_encode(array('ok' => false, 'message' => $install_result->get_error_message(), 'output' => $install_output));
        exit;
      }

      if (!$install_result) {
        $message = method_exists($skin, 'get_errors') && is_wp_error($skin->get_errors()) && $skin->get_errors()->has_errors()
          ? $skin->get_errors()->get_error_message()
          : 'Plugin install failed.';
        echo wp_json_encode(array('ok' => false, 'message' => $message, 'output' => $install_output));
        exit;
      }

      wp_cache_flush();
      $plugin_file = fluent_ai_find_plugin_file($slug, get_plugins());
    }

    if (!$plugin_file) {
      echo wp_json_encode(array('ok' => false, 'message' => 'Plugin installed but main file could not be detected for: ' . $slug));
      exit;
    }

    $active = is_plugin_active($plugin_file);
    if ($activate && !$active) {
      ob_start();
      $activate_result = activate_plugin($plugin_file);
      ob_end_clean();
      if (is_wp_error($activate_result)) {
        echo wp_json_encode(array('ok' => false, 'message' => $activate_result->get_error_message(), 'plugin' => $plugin_file));
        exit;
      }
      $active = is_plugin_active($plugin_file);
    }

    echo wp_json_encode(array(
      'ok' => true,
      'action' => 'install_plugin',
      'query' => $query,
      'slug' => $slug,
      'name' => $info->name ?? $slug,
      'version' => $info->version ?? '',
      'plugin' => $plugin_file,
      'installed' => true,
      'already_installed' => $installed,
      'activated' => $activate,
      'active' => $active,
    ));

    function fluent_ai_find_plugin_file($slug, $plugins) {
      $fallback = '';
      foreach ($plugins as $file => $plugin) {
        $folder = dirname($file);
        if ($folder === $slug) {
          if (!$fallback) {
            $fallback = $file;
          }
          if (basename($file, '.php') === $slug) {
            return $file;
          }
        }
      }
      return $fallback;
    }
  `;

  return runWordPressJson(config, wpRoot, phpCode, { timeout: 120000 });
}

export function updateWordPressDebugLog(config, enabled) {
  const wpRoot = getWordPressRoot(config.pluginRoot);
  const configPath = path.join(wpRoot, "wp-config.php");

  if (!fs.existsSync(configPath)) {
    return Promise.resolve({
      ok: false,
      message: `wp-config.php not found at ${configPath}`,
      wordpressRoot: wpRoot,
    });
  }

  const original = fs.readFileSync(configPath, "utf8");
  const next = setWpConfigDefine(
    enabled ? setWpConfigDefine(original, "WP_DEBUG", "true") : original,
    "WP_DEBUG_LOG",
    enabled ? "true" : "false"
  );

  if (next !== original) {
    fs.writeFileSync(configPath, next);
  }

  return Promise.resolve({
    ok: true,
    action: enabled ? "enable_debug_log" : "disable_debug_log",
    configPath,
    changed: next !== original,
    wpDebug: enabled ? true : readWpConfigBoolean(next, "WP_DEBUG"),
    wpDebugLog: enabled,
    wpDebugDisplay: readWpConfigBoolean(next, "WP_DEBUG_DISPLAY"),
  });
}

export function activateTheme(config, stylesheet) {
  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    $stylesheet = ${JSON.stringify(stylesheet)};
    $theme = wp_get_theme($stylesheet);
    if (!$theme->exists()) {
      echo wp_json_encode(array('ok' => false, 'message' => 'Theme not found: ' . $stylesheet));
      exit;
    }
    switch_theme($stylesheet);
    $active = wp_get_theme();
    echo wp_json_encode(array(
      'ok' => true,
      'theme' => $active->get('Name'),
      'stylesheet' => get_stylesheet(),
      'template' => get_template(),
    ));
  `;

  return runWordPressJson(config, wpRoot, phpCode);
}

export function listThemes(config) {
  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    $themes = wp_get_themes();
    $rows = array();
    foreach ($themes as $stylesheet => $theme) {
      $rows[] = array(
        'stylesheet' => $stylesheet,
        'name' => $theme->get('Name'),
        'version' => $theme->get('Version'),
        'active' => $stylesheet === get_stylesheet(),
      );
    }
    usort($rows, function($a, $b) {
      return strcasecmp($a['name'], $b['name']);
    });
    echo wp_json_encode(array('ok' => true, 'themes' => $rows));
  `;

  return runWordPressJson(config, wpRoot, phpCode);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: options.timeout || 15000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join("\n").trim();

        resolve({
          ok: !error,
          output: output || (error ? error.message : ""),
        });
      }
    );
  });
}

function $trimPhp(code) {
  return code.replace(/^\s+|\s+$/g, "");
}

function setWpConfigDefine(content, name, value) {
  const definePattern = new RegExp(`define\\(\\s*['"]${name}['"]\\s*,\\s*(?:true|false|['"][^'"]*['"]|[^)]+)\\s*\\);`);
  const defineLine = `define( '${name}', ${value} );`;

  if (definePattern.test(content)) {
    return content.replace(definePattern, defineLine);
  }

  const marker = "/* That's all, stop editing!";
  if (content.includes(marker)) {
    return content.replace(marker, `${defineLine}\n${marker}`);
  }

  return `${content.trimEnd()}\n${defineLine}\n`;
}

function readWpConfigBoolean(content, name) {
  const match = content.match(new RegExp(`define\\(\\s*['"]${name}['"]\\s*,\\s*(true|false)\\s*\\);`, "i"));
  return match ? match[1].toLowerCase() === "true" : null;
}

function runWordPressJson(config, wpRoot, phpCode, options = {}) {
  return runCommand(config.phpBinary || "php", ["-r", $trimPhp(phpCode)], options).then((result) => {
    if (!result.ok) {
      return {
        ok: false,
        wordpressRoot: wpRoot,
        message: result.output,
      };
    }

    try {
      return {
        wordpressRoot: wpRoot,
        ...JSON.parse(result.output),
      };
    } catch (error) {
      return {
        ok: false,
        wordpressRoot: wpRoot,
        message: `WordPress action returned invalid JSON: ${error.message}\n${result.output}`,
      };
    }
  });
}
