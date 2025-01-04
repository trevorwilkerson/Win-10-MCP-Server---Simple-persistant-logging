# Win-10-MCP-Server---Simple-persistant-logging
Although MCP Inspector shows all communications for MCP Servers, I want a log to persist on the HDD.
Specifically, because I modified the "write-file" case in the index.js inside "server-filesystem/dist"

## Problem:  Claude has gotten extremely lazy and may not write the whole file it is working on. 

  For example, it may write the headers and then say
  [ rest of the code stays the same ... ]

I did 2 things:
1.  Every time the write_file tool is called, I make a copy of the target file ( if exists ) with a date time stamp.
2.  Log the name of the file and send it back ( return statement ) to Claude Desktop App so the user will see the backup file name.

Then manually, I use a diff tool to verify what has changed....  Fixing Claudes mistakes later

Excellent use case for an Agent here..... hint, hint..

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


### ADD the index.js
I Changed my index.js
It can be found in this directory ( Win10 ):
C:\Users\TrevorW\AppData\Roaming\npm\node_modules\@modelcontextprotocol\server-filesystem\dist

### 3. Implementing the `write_file` Case

modify the `write_file` operation, ensuring that it handles file writing with backup creation and logs all pertinent information.

```javascript
// index.js

// ...imports and schema definitions...

/**
 * Validates the provided file path to prevent unauthorized access.
 *
 * @param {string} filePath - The file path to validate.
 * @returns {Promise<string>} - The validated and normalized file path.
 * @throws Will throw an error if the path is invalid.
 */
async function validatePath(filePath) {
    // Normalize the path to prevent directory traversal
    const normalizedPath = path.normalize(filePath);

    // Define allowed base directories
    const allowedBase = path.resolve(process.cwd(), "Control_Charts");

    // Ensure the normalized path starts with the allowed base directory
    if (!normalizedPath.startsWith(allowedBase)) {
        throw new Error("Invalid file path. Access denied.");
    }

    // Additional validations can be added here (e.g., file extension checks)

    return normalizedPath;
}

/**
 * Handles various operations based on the provided operation name and arguments.
 *
 * @param {string} operation - The name of the operation to perform.
 * @param {object} args - The arguments required for the operation.
 * @returns {Promise<object>} - The response object to send back.
 */
async function handleOperation(operation, args) {
    switch (operation) {
        case "write_file": {
            try {
                // 1. Parse incoming arguments
                const parsed = WriteFileArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(`Invalid arguments for write_file: ${parsed.error}`);
                }

                // 2. Validate the path
                const validPath = await validatePath(parsed.data.path);

                let backupName = null; // Initialize backupName to track if a backup is created

                // 3. Backup existing file if it exists
                try {
                    await fs.access(validPath); // Throws if file doesn't exist

                    // Build date/time string in MMDDYY_HH_MM format
                    const now = new Date();
                    const mm = String(now.getMonth() + 1).padStart(2, '0');
                    const dd = String(now.getDate()).padStart(2, '0');
                    const yy = String(now.getFullYear()).slice(-2);
                    const hh = String(now.getHours()).padStart(2, '0');
                    const mn = String(now.getMinutes()).padStart(2, '0');
                    const dateString = `${mm}${dd}${yy}_${hh}_${mn}`;

                    // Build backup file path
                    const dirName = path.dirname(validPath);
                    const baseName = path.basename(validPath);
                    backupName = `${baseName}.${dateString}__CLDBak`; // Assign to backupName
                    const backupPath = path.join(dirName, backupName);

                    // Rename original file to create backup
                    await fs.rename(validPath, backupPath);

                    // Log the backup creation
                    await logToFile("INFO", `Backup created at ${backupPath}`);
                } catch (err) {
                    if (err.code !== 'ENOENT') { // ENOENT: File does not exist
                        // Log unexpected errors during backup
                        await logToFile("ERROR", `Error accessing or backing up file: ${err.message}`);
                        throw err; // Re-throw unexpected errors
                    }
                    // File doesn't exist; proceed without backup
                    await logToFile("INFO", `No existing file at ${validPath}. No backup created.`);
                }

                // 4. Write the new content
                await fs.writeFile(validPath, parsed.data.content, "utf-8");
                await logToFile("INFO", `Successfully wrote to ${validPath}`);

                // 5. Prepare the response
                let responseText = `Successfully wrote to ${parsed.data.path}`;
                if (backupName) {
                    responseText += `\nKAN: Backup saved to ${backupName}`;
                }

                //  THIS IS THE KEY TO MAKE CLAUDE DESKTOP HAPPY
                //  The response HAS TO BE in JSON, or will bitch at you
                const response = {
                    content: [{
                        type: "text",
                        text: responseText,
                    }],
                };

                // 6. Return the response without any additional logging
                return response;
            } catch (error) {
                // Log the error details
                await logToFile("ERROR", `write_file operation failed: ${error.message}`);
                throw error; // Ensure the error is propagated appropriately
            }
        }

        // ... handle other cases ...      //  Example of the lazyness I am dealing with here ....

        default:
            throw new Error(`Unknown operation: ${operation}`);
    }
}


##  IF you have gotten this far, you may say, hey Trevor, why don't you use an IDE like cursor to add this functionality.
my answer:  Will we have cursor in 3 months ?  I might learn something now before Windows 10 is totally voice mode....
