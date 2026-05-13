import fs from "fs";
import os from "os";
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
        summary: parseJsonFromOutput(result.output),
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
    $warning = '';
    if (${JSON.stringify(action)} === 'activate') {
      ob_start();
      $result = activate_plugin($plugin_file);
      $activation_output = trim(ob_get_clean());
      if (is_wp_error($result)) {
        if (!is_plugin_active($plugin_file)) {
          echo wp_json_encode(array('ok' => false, 'message' => $result->get_error_message(), 'output' => $activation_output));
          exit;
        }
        $warning = $result->get_error_message();
      }
    } else {
      deactivate_plugins($plugin_file);
    }
    echo wp_json_encode(array(
      'ok' => true,
      'action' => ${JSON.stringify(action)},
      'plugin' => $plugin_file,
      'active' => is_plugin_active($plugin_file),
      'warning' => $warning,
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

export function createWordPressContent(config, options = {}) {
  const postType = String(options.postType || "").trim();
  const title = String(options.title || "").trim();
  const content = String(options.content || "").trim();
  const status = String(options.status || "publish").trim();

  if (!["page", "post"].includes(postType)) {
    return Promise.resolve({ ok: false, message: "Content type must be page or post." });
  }

  if (!title) {
    return Promise.resolve({ ok: false, message: "Title is required." });
  }

  if (!content) {
    return Promise.resolve({ ok: false, message: "Content is required." });
  }

  if (!["publish", "draft", "pending", "private"].includes(status)) {
    return Promise.resolve({ ok: false, message: `Unsupported post status: ${status}` });
  }

  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    $post_type = ${JSON.stringify(postType)};
    $title = ${JSON.stringify(title)};
    $content = ${JSON.stringify(content)};
    $status = ${JSON.stringify(status)};

    if (!post_type_exists($post_type)) {
      echo wp_json_encode(array('ok' => false, 'message' => 'Post type not found: ' . $post_type));
      exit;
    }

    $post_id = wp_insert_post(array(
      'post_type' => $post_type,
      'post_title' => sanitize_text_field($title),
      'post_content' => wp_kses_post($content),
      'post_status' => $status,
    ), true);

    if (is_wp_error($post_id)) {
      echo wp_json_encode(array('ok' => false, 'message' => $post_id->get_error_message()));
      exit;
    }

    echo wp_json_encode(array(
      'ok' => true,
      'action' => 'create_content',
      'postType' => $post_type,
      'id' => (int) $post_id,
      'title' => get_the_title($post_id),
      'status' => get_post_status($post_id),
      'permalink' => get_permalink($post_id),
      'editUrl' => get_edit_post_link($post_id, 'raw'),
    ));
  `;

  return runWordPressJson(config, wpRoot, phpCode);
}

export function createFluentSupportTicket(config, options = {}) {
  const customerName = String(options.customerName || "").trim();
  const customerEmail = String(options.customerEmail || "").trim();
  const subject = String(options.subject || "").trim();
  const content = String(options.content || "").trim();
  const priority = String(options.priority || "normal").trim().toLowerCase();
  const mailbox = String(options.mailbox || "").trim();

  if (!customerEmail) {
    return Promise.resolve({ ok: false, message: "Customer email is required." });
  }

  if (!subject) {
    return Promise.resolve({ ok: false, message: "Ticket subject is required." });
  }

  if (!content) {
    return Promise.resolve({ ok: false, message: "Ticket message is required." });
  }

  if (!["low", "normal", "medium", "high", "critical"].includes(priority)) {
    return Promise.resolve({ ok: false, message: `Unsupported ticket priority: ${priority}` });
  }

  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};

    if (!defined('FLUENT_SUPPORT_VERSION') && !class_exists('FluentSupport\\\\App\\\\Models\\\\Ticket')) {
      echo wp_json_encode(array('ok' => false, 'message' => 'Fluent Support is not active or not loaded.'));
      exit;
    }

    if (${JSON.stringify(config.wpAdminUser || "")}) {
      $user = get_user_by('login', ${JSON.stringify(config.wpAdminUser || "")});
      if (!$user && is_email(${JSON.stringify(config.wpAdminUser || "")})) {
        $user = get_user_by('email', ${JSON.stringify(config.wpAdminUser || "")});
      }
      if ($user) {
        wp_set_current_user($user->ID);
      }
    }

    $customer_name = sanitize_text_field(${JSON.stringify(customerName)});
    $customer_email = sanitize_email(${JSON.stringify(customerEmail)});
    $subject = sanitize_text_field(${JSON.stringify(subject)});
    $content = wp_kses_post(${JSON.stringify(content)});
    $priority = sanitize_text_field(${JSON.stringify(priority)});
    $mailbox_query = sanitize_text_field(${JSON.stringify(mailbox)});

    if (!$customer_email || !is_email($customer_email)) {
      echo wp_json_encode(array('ok' => false, 'message' => 'A valid customer email is required.'));
      exit;
    }

    if (!$subject || !$content) {
      echo wp_json_encode(array('ok' => false, 'message' => 'Ticket subject and message are required.'));
      exit;
    }

    $name_parts = preg_split('/\\s+/', trim($customer_name), 2);
    $customer_data = array(
      'email' => $customer_email,
      'first_name' => $name_parts[0] ?? '',
      'last_name' => $name_parts[1] ?? '',
    );

    try {
      $customer = \\FluentSupport\\App\\Models\\Customer::maybeCreateCustomer($customer_data);
      if (!$customer) {
        echo wp_json_encode(array('ok' => false, 'message' => 'Customer could not be created.'));
        exit;
      }

      $ticket_data = array(
        'customer_id' => $customer->id,
        'title' => $subject,
        'content' => $content,
        'priority' => $priority === 'medium' ? 'normal' : $priority,
        'client_priority' => $priority === 'medium' ? 'normal' : $priority,
        'status' => 'new',
        'source' => 'local_ai_agent',
      );

      if ($mailbox_query) {
        $mailbox = null;
        if (is_numeric($mailbox_query)) {
          $mailbox = \\FluentSupport\\App\\Models\\MailBox::find($mailbox_query);
        }
        if (!$mailbox) {
          $mailbox = \\FluentSupport\\App\\Models\\MailBox::where('name', 'LIKE', '%' . $mailbox_query . '%')
            ->orWhere('email', 'LIKE', '%' . $mailbox_query . '%')
            ->orWhere('slug', 'LIKE', '%' . sanitize_title($mailbox_query) . '%')
            ->first();
        }
        if (!$mailbox) {
          echo wp_json_encode(array('ok' => false, 'message' => 'Mailbox not found: ' . $mailbox_query));
          exit;
        }
        $ticket_data['mailbox_id'] = $mailbox->id;
      }

      add_filter('fluent_support/should_send_notification', '__return_false', 999);
      $ticket = (new \\FluentSupport\\App\\Services\\Tickets\\TicketService())->storeTicket($ticket_data, $customer);

      $admin_url = admin_url('admin.php?page=fluent-support#/tickets/' . $ticket->id . '/view');
      echo wp_json_encode(array(
        'ok' => true,
        'action' => 'create_fluent_support_ticket',
        'id' => (int) $ticket->id,
        'title' => $ticket->title,
        'status' => $ticket->status,
        'priority' => $ticket->priority,
        'customer' => array(
          'id' => (int) $customer->id,
          'name' => trim($customer->first_name . ' ' . $customer->last_name),
          'email' => $customer->email,
        ),
        'ticketUrl' => $admin_url,
        'notificationsSuppressed' => true,
      ));
    } catch (\\Throwable $e) {
      echo wp_json_encode(array('ok' => false, 'message' => $e->getMessage()));
    }
  `;

  return runWordPressJson(config, wpRoot, phpCode);
}

export async function installWordPressOrgPlugin(config, query, options = {}) {
  const pluginQuery = String(query || "").trim();
  if (!pluginQuery) {
    return { ok: false, message: "Plugin name or slug is required." };
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
        $active = is_plugin_active($plugin_file);
        if (!$active) {
          echo wp_json_encode(array('ok' => false, 'message' => $activate_result->get_error_message(), 'plugin' => $plugin_file));
          exit;
        }
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

  const result = await runWordPressJson(config, wpRoot, phpCode, { timeout: 120000 });
  if (result.ok || result.message !== "Plugin install failed.") {
    return result;
  }

  return installWordPressOrgPluginFromZip(config, pluginQuery, { activate, wpRoot });
}

async function installWordPressOrgPluginFromZip(config, query, options) {
  const wpRoot = options.wpRoot || getWordPressRoot(config.pluginRoot);
  const info = await resolveWordPressOrgPlugin(query);
  if (!info.ok) {
    return info;
  }

  const pluginFileBefore = await findInstalledPluginFile(config, info.slug);
  if (!pluginFileBefore.ok) {
    return pluginFileBefore;
  }

  let pluginFile = pluginFileBefore.plugin;
  let alreadyInstalled = Boolean(pluginFile);

  if (!alreadyInstalled) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fluent-ai-plugin-"));
    const zipPath = path.join(tempDir, `${info.slug}.zip`);

    try {
      const download = await fetch(info.downloadLink);
      if (!download.ok) {
        return {
          ok: false,
          message: `Plugin download failed (${download.status}): ${info.downloadLink}`,
        };
      }

      fs.writeFileSync(zipPath, Buffer.from(await download.arrayBuffer()));
      const unzip = await runCommand("unzip", ["-q", "-o", zipPath, "-d", config.pluginRoot], { timeout: 120000 });
      if (!unzip.ok) {
        return {
          ok: false,
          message: `Plugin unzip failed: ${unzip.output}`,
        };
      }
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }

    const pluginFileAfter = await findInstalledPluginFile(config, info.slug);
    if (!pluginFileAfter.ok) {
      return pluginFileAfter;
    }
    pluginFile = pluginFileAfter.plugin;
  }

  if (!pluginFile) {
    return {
      ok: false,
      message: `Plugin installed but main file could not be detected for: ${info.slug}`,
    };
  }

  let active = false;
  if (options.activate !== false) {
    const activation = await changePluginStatus(config, pluginFile, "activate");
    if (!activation.ok) {
      const summary = await getWordPressSiteSummary(config);
      const maybeActive = summary.ok ? summary.summary.plugins.items.some((plugin) => plugin.file === pluginFile && plugin.active) : false;
      if (!maybeActive) {
        return activation;
      }
      active = true;
    } else {
      active = activation.active;
    }
  } else {
    const summary = await getWordPressSiteSummary(config);
    active = summary.ok ? summary.summary.plugins.items.some((plugin) => plugin.file === pluginFile && plugin.active) : false;
  }

  return {
    ok: true,
    action: "install_plugin",
    query,
    slug: info.slug,
    name: info.name,
    version: info.version,
    plugin: pluginFile,
    installed: true,
    already_installed: alreadyInstalled,
    activated: options.activate !== false,
    active,
    installer: "zip_fallback",
    wordpressRoot: wpRoot,
  };
}

async function resolveWordPressOrgPlugin(query) {
  const slug = slugify(query);
  const exact = await fetchWordPressPluginInfo(slug);
  if (exact.ok) {
    return exact;
  }

  const searchUrl = new URL("https://api.wordpress.org/plugins/info/1.2/");
  searchUrl.searchParams.set("action", "query_plugins");
  searchUrl.searchParams.set("request[search]", query);
  searchUrl.searchParams.set("request[per_page]", "5");
  searchUrl.searchParams.set("request[fields][sections]", "0");
  searchUrl.searchParams.set("request[fields][description]", "0");

  const response = await fetch(searchUrl);
  if (!response.ok) {
    return {
      ok: false,
      message: `WordPress.org plugin search failed (${response.status}).`,
    };
  }

  const data = await response.json();
  const plugins = Array.isArray(data.plugins) ? data.plugins : [];
  if (!plugins.length) {
    return {
      ok: false,
      message: `No WordPress.org plugin matched: ${query}`,
    };
  }

  const normalizedQuery = normalizeLookup(query);
  const selected =
    plugins.find((plugin) => normalizeLookup(plugin.slug) === normalizeLookup(slug)) ||
    plugins.find((plugin) => normalizeLookup(plugin.name) === normalizedQuery) ||
    plugins[0];

  return {
    ok: true,
    slug: selected.slug,
    name: selected.name || selected.slug,
    version: selected.version || "",
    downloadLink: selected.download_link,
  };
}

async function fetchWordPressPluginInfo(slug) {
  const url = new URL("https://api.wordpress.org/plugins/info/1.2/");
  url.searchParams.set("action", "plugin_information");
  url.searchParams.set("request[slug]", slug);
  url.searchParams.set("request[fields][sections]", "0");
  url.searchParams.set("request[fields][description]", "0");

  const response = await fetch(url);
  if (!response.ok) {
    return {
      ok: false,
      message: `WordPress.org plugin lookup failed (${response.status}).`,
    };
  }

  const data = await response.json();
  if (!data || data.error) {
    return {
      ok: false,
      message: data?.error || `No WordPress.org plugin matched slug: ${slug}`,
    };
  }

  return {
    ok: true,
    slug: data.slug,
    name: data.name || data.slug,
    version: data.version || "",
    downloadLink: data.download_link,
  };
}

async function findInstalledPluginFile(config, slug) {
  const wpRoot = getWordPressRoot(config.pluginRoot);
  const phpCode = `
    require ${JSON.stringify(path.join(wpRoot, "wp-load.php"))};
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $slug = ${JSON.stringify(slug)};
    $plugins = get_plugins();
    $plugin_file = '';
    foreach ($plugins as $file => $plugin) {
      $folder = dirname($file);
      if ($folder === $slug) {
        if (!$plugin_file) {
          $plugin_file = $file;
        }
        if (basename($file, '.php') === $slug) {
          $plugin_file = $file;
          break;
        }
      }
    }
    echo wp_json_encode(array('ok' => true, 'plugin' => $plugin_file));
  `;

  return runWordPressJson(config, wpRoot, phpCode);
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
          stdout,
          stderr,
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

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLookup(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
        ...parseJsonFromOutput(result.output),
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

function parseJsonFromOutput(output) {
  try {
    return JSON.parse(output);
  } catch (_error) {
    const text = String(output || "");
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) {
      throw _error;
    }

    return JSON.parse(text.slice(first, last + 1));
  }
}
