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
  if (action !== "deactivate") {
    return Promise.resolve({ ok: false, message: `Unsupported all-plugins action: ${action}` });
  }

  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    if (!function_exists('deactivate_plugins')) {
      require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    $active_plugins = (array) get_option('active_plugins', array());
    if (!empty($active_plugins)) {
      deactivate_plugins($active_plugins);
    }
    $active_after = (array) get_option('active_plugins', array());
    echo wp_json_encode(array(
      'ok' => true,
      'action' => 'deactivate_all_plugins',
      'count' => count($active_plugins),
      'plugins' => array_values($active_plugins),
      'active_after' => count($active_after),
    ));
  `;

  return runWordPressJson(config, wpRoot, phpCode);
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

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: 15000,
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

function runWordPressJson(config, wpRoot, phpCode) {
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
