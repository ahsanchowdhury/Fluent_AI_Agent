import fs from "fs";
import http from "http";
import https from "https";
import { execFile } from "child_process";

export function pathExists(targetPath) {
  return fs.existsSync(targetPath);
}

export function commandVersion(command, args = ["--version"]) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          command,
          message: stderr.trim() || error.message,
        });
        return;
      }

      resolve({
        ok: true,
        command,
        message: stdout.trim() || stderr.trim(),
      });
    });
  });
}

export function checkUrl(url) {
  return new Promise((resolve) => {
    let parsed;

    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({ ok: false, message: `Invalid URL: ${error.message}` });
      return;
    }

    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(
      parsed,
      { method: "HEAD", timeout: 5000 },
      (response) => {
        response.resume();
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 500,
          statusCode: response.statusCode,
          message: `HTTP ${response.statusCode}`,
        });
      }
    );

    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false, message: "Request timed out" });
    });

    request.on("error", (error) => {
      resolve({ ok: false, message: error.message });
    });

    request.end();
  });
}

export function getNodeMajorVersion() {
  const match = process.version.match(/^v(\d+)/);
  return match ? Number(match[1]) : 0;
}
