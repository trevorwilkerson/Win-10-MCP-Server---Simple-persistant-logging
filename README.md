# Win-10-MCP-Server---Simple-persistant-logging
Although the MCP Inspector will show all communications for MCP Servers, I wanted a simple log to persist on the HDD.
Specifically, I modified the "write-file" case in the index.js.
Problem:  Claude has gotten extremely lazy and may not write the whole file it is working on.
  For example, it may write the headers and then say
  [ rest of the code stays the same ... ]
I did 2 things:
1.  Every time the write_file tool is called, I make a copy of the target file ( if exists ) with a date time stamp.
2.  Log the name of the file and send it back ( return statement ) to Claude Desktop App so the user will see the backup file name.

### 1. Create `logger.mjs`

Create a new file named `logger.mjs` in your project root:

```javascript
// logger.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Determine the directory of the current module
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

/**
 * Logs a message to the log file with the specified level.
 *
 * @param {string} level - The severity level of the log (e.g., INFO, ERROR).
 * @param {string} message - The message to log.
 */
export async function logToFile(level, message) {
    const timestamp = new Date().toISOString();
    const line = `[${level.toUpperCase()}] ${timestamp} - ${message}\n`;

    try {
        await fs.appendFile(LOG_FILE, line);
    } catch (err) {
        // If writing fails, log to console.error without disrupting the main flow
        console.error("Failed to write to log file:", err);
    }
}

// Temporary verification (commented out to prevent interference)
// console.log("Logging to:", LOG_FILE); // Do not use, as it can interfere with JSON responses
```
