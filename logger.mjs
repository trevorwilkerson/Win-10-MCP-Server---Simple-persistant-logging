// logger.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define logs directory relative to the logger.mjs file
const LOG_DIR = path.join(__dirname, "logs");

// Ensure the logs directory exists
async function ensureLogDir() {
    try {
        await fs.mkdir(LOG_DIR, { recursive: true });
    } catch (err) {
        console.error("Failed to create logs directory:", err);
    }
}

ensureLogDir();

// Define log file path
const LOG_FILE = path.join(LOG_DIR, "KAN_server.log");

export async function logToFile(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${level.toUpperCase()}] ${timestamp} - ${message}\n`;

    try {
        await fs.appendFile(LOG_FILE, line);
    } catch (err) {
        console.error("Failed to write to log file:", err);
    }
}

// Temporary verification
//  console.log("Logging to:", LOG_FILE);	//  Don't use, Claude Desktop app intercepts this and says it is not valid JSON
