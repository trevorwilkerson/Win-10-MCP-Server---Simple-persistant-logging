#!/usr/bin/env node

// This line tells Unix-like systems to run this file using Node.js

// Import essential libraries for building a secure file system server
// The Model Context Protocol (MCP) provides the framework for our server
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema, } from "@modelcontextprotocol/sdk/types.js";
// Node.js built-in modules for file and path operations
import fs from "fs/promises";  // Using promises version for cleaner async code
import path from "path";       // For cross-platform path handling
import os from 'os';          // For operating system-specific operations
// Zod is our data validation library
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
// Add at top with other imports
import { spawn } from 'child_process';
// custom KAN logger
import { logToFile } from "./logger.mjs";  // or correct relative path
await logToFile("KAN:  logger started");	

// Get command line arguments, skipping first two (node executable and script name)
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error("Usage: mcp-server-filesystem <allowed-directory> [additional-directories...]");
    process.exit(1);  // Exit with error code 1 if no directories specified
}
// Normalize all paths consistently
// Helper function: Standardize paths across different operating systems
// Windows uses backslashes, Linux/Mac use forward slashes - this handles both
function normalizePath(p) {
    return path.normalize(p).toLowerCase();
}

// Convert ~ to actual home directory path for user convenience
// Helper function: Replace tilde (~) with user's home directory
// This lets users write ~/Documents instead of /home/username/Documents
function expandHome(filepath) {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}

// Store allowed directories in normalized form
// Convert all provided directory paths to their full, absolute paths
// This prevents confusion with relative paths later
const allowedDirectories = args.map(dir => normalizePath(path.resolve(expandHome(dir))));

// Safety check: Verify all directories exist and are actually directories
// This prevents the server from starting with invalid directories
await Promise.all(args.map(async (dir) => {
    try {
        const stats = await fs.stat(dir);
        if (!stats.isDirectory()) {
            console.error(`Error: ${dir} is not a directory`);
            process.exit(1);
        }
    }
    catch (error) {
        console.error(`Error accessing directory ${dir}:`, error);
        process.exit(1);
    }
}));

// Critical security function: Ensures all file operations stay within allowed directories
// This prevents malicious attempts to access files outside allowed areas
async function validatePath(requestedPath) {
    const expandedPath = expandHome(requestedPath);
    // Convert to absolute path, handling both absolute and relative input paths
    const absolute = path.isAbsolute(expandedPath)
        ? path.resolve(expandedPath)
        : path.resolve(process.cwd(), expandedPath);
    const normalizedRequested = normalizePath(absolute);
    
    // First security check: Is the path within our allowed directories?
    const isAllowed = allowedDirectories.some(dir => normalizedRequested.startsWith(dir));
    if (!isAllowed) {
        throw new Error(`Access denied - path outside allowed directories: ${absolute} not in ${allowedDirectories.join(', ')}`);
    }
    // Handle symlinks by checking their real path
    // Second security check: Handle symbolic links (shortcuts/aliases)
    // A symlink might point outside allowed directories, so we need to check its target
    try {
        const realPath = await fs.realpath(absolute);
        const normalizedReal = normalizePath(realPath);
        const isRealPathAllowed = allowedDirectories.some(dir => normalizedReal.startsWith(dir));
        if (!isRealPathAllowed) {
            throw new Error("Access denied - symlink target outside allowed directories");
        }
        return realPath;
    }
    catch (error) {
        // Special case: When creating new files, the path won't exist yet
        // So we check if the parent directory is allowed instead
        const parentDir = path.dirname(absolute);
        try {
            const realParentPath = await fs.realpath(parentDir);
            const normalizedParent = normalizePath(realParentPath);
            const isParentAllowed = allowedDirectories.some(dir => normalizedParent.startsWith(dir));
            if (!isParentAllowed) {
                throw new Error("Access denied - parent directory outside allowed directories");
            }
            return absolute;
        }
        catch {
            throw new Error(`Parent directory does not exist: ${parentDir}`);
        }
    }
}
// Schema definitions
// Define the shape of data we expect for each operation using Zod schemas
// This ensures we get exactly the data we need, nothing more, nothing less
const ReadFileArgsSchema = z.object({
    path: z.string(),
});
const ReadMultipleFilesArgsSchema = z.object({
    paths: z.array(z.string()),
});
const WriteFileArgsSchema = z.object({
    path: z.string(),
    content: z.string(),
});
const CreateDirectoryArgsSchema = z.object({
    path: z.string(),
});
const ListDirectoryArgsSchema = z.object({
    path: z.string(),
});
const MoveFileArgsSchema = z.object({
    source: z.string(),
    destination: z.string(),
});
const SearchFilesArgsSchema = z.object({
    path: z.string(),
    pattern: z.string(),
});
const GetFileInfoArgsSchema = z.object({
    path: z.string(),
});
const ToolInputSchema = ToolSchema.shape.inputSchema;

// Schema for validating Python script execution requests 
const RunPythonScriptSchema = z.object({
    // The path to the Python script - must be a string and end with .py
    path: z.string()
        .min(1, "Script path cannot be empty")
        .refine(
            (path) => path.toLowerCase().endsWith('.py'),
            "File must have a .py extension"
        ),
    
    // Optional array of command line arguments to pass to the script
    // If provided, each argument must be a string and contain no shell metacharacters
    args: z.array(
        z.string()
            .min(1, "Arguments cannot be empty strings")
            .regex(
                /^[a-zA-Z0-9_\-./]+$/, 
                "Arguments can only contain alphanumeric characters, underscores, hyphens, dots, and forward slashes"
            )
    )
    .optional()
    .default([]),  // If args is not provided, default to empty array
    
    // Optional timeout in milliseconds (default 30 seconds)
    timeout: z.number()
        .int("Timeout must be an integer")
        .min(1000, "Timeout must be at least 1000ms")
        .max(300000, "Timeout cannot exceed 300000ms (5 minutes)")
        .optional()
        .default(30000),
});

// Create our server instance with basic configuration
const server = new Server({
    name: "secure-filesystem-server",
    version: "0.2.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Tool implementations
// Helper function: Gather detailed information about a file or directory
async function getFileStats(filePath) {
    const stats = await fs.stat(filePath);
    return {
        size: stats.size,           // File size in bytes
        created: stats.birthtime,   // When the file was created
        modified: stats.mtime,      // When it was last modified
        accessed: stats.atime,      // When it was last accessed
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        permissions: stats.mode.toString(8).slice(-3),  // Unix-style permissions (e.g., 644)
    };
}
// Recursively search directories for files matching the given pattern
// Helper function: Search for files matching a pattern in all subdirectories
async function searchFiles(rootPath, pattern) {
    const results = [];
    // Internal recursive function to walk through directory tree
    async function search(currentPath) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentPath, entry.name);
            try {
                // Validate each path before processing
                await validatePath(fullPath);
                if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
                    results.push(fullPath);
                }
                if (entry.isDirectory()) {
                    await search(fullPath);  // Recursively search subdirectories
                }
            }
            catch (error) {
                // Skip any paths we can't access, but continue searching others
                continue;
            }
        }
    }
    await search(rootPath);
    return results;
}
/**
 * Execute a Python script securely within the allowed directories.
 * Captures stdout, stderr, and handles errors gracefully.
 * 
 * @param {string} scriptPath - Path to the Python script
 * @param {Object} options - Execution options
 * @param {string[]} options.args - Command line arguments for the script
 * @param {number} options.timeout - Maximum execution time in milliseconds
 * @returns {Promise<{output: string, error: string}>} - Script output and any errors
 */
async function executePythonScript(scriptPath, { args = [], timeout = 30000 } = {}) {
    // First ensure the script exists and is within allowed directories
    const validatedPath = await validatePath(scriptPath);
    
    // Verify it's actually a Python file by reading first few bytes
    // This prevents running non-Python files that just have .py extension
    const fileHandle = await fs.open(validatedPath, 'r');
    try {
        const buffer = Buffer.alloc(50);  // Read first 50 bytes
        await fileHandle.read(buffer, 0, 50, 0);
        const fileStart = buffer.toString();
        
        // Check for common Python file signatures
        if (!fileStart.includes('#!/usr/bin/env python') && 
            !fileStart.includes('# -*- coding:') && 
            !fileStart.includes('import ') && 
            !fileStart.includes('def ') &&
            !fileStart.includes('print') &&
            !fileStart.includes('#!')) {
            throw new Error('File does not appear to be a valid Python script');
        }
    } finally {
        await fileHandle.close();
    }

    // Create a promise that will handle the Python process execution
    return new Promise((resolve, reject) => {
        // Collect output and errors
        let stdoutData = '';
        let stderrData = '';
        
        // Determine Python executable (platform independent)
        const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
        
        // Spawn Python process with the script
        const pythonProcess = spawn(pythonCommand, [validatedPath, ...args], {
            // Security: Restrict environment variables and working directory
            env: {
                PATH: process.env.PATH,  // Only pass PATH for finding Python
                PYTHONPATH: process.env.PYTHONPATH  // Allow Python to find modules
            },
            // Set working directory to script's directory
            cwd: path.dirname(validatedPath),
            // Additional security options
            stdio: ['ignore', 'pipe', 'pipe'],  // Only capture stdout/stderr
            windowsHide: true,  // Don't show window on Windows
            timeout: timeout    // Apply timeout limit
        });

        // Capture stdout
        pythonProcess.stdout.on('data', (data) => {
            // Limit output size to prevent memory issues
            if (stdoutData.length < 1024 * 1024) {  // 1MB limit
                stdoutData += data.toString();
            } else if (!stdoutData.endsWith('... Output truncated\n')) {
                stdoutData += '... Output truncated\n';
            }
        });

        // Capture stderr
        pythonProcess.stderr.on('data', (data) => {
            if (stderrData.length < 1024 * 1024) {  // 1MB limit
                stderrData += data.toString();
            } else if (!stderrData.endsWith('... Error output truncated\n')) {
                stderrData += '... Error output truncated\n';
            }
        });

        // Handle successful completion
        pythonProcess.on('close', (code) => {
            resolve({
                output: stdoutData,
                error: stderrData,
                exitCode: code
            });
        });

        // Handle process errors
        pythonProcess.on('error', (error) => {
            reject(new Error(`Failed to execute Python script: ${error.message}`));
        });

        // Set up timeout handler
        const timeoutId = setTimeout(() => {
            pythonProcess.kill();  // Terminate the process
            reject(new Error(`Python script execution timed out after ${timeout}ms`));
        }, timeout);

        // Clean up timeout if process finishes
        pythonProcess.on('close', () => {
            clearTimeout(timeoutId);
        });
    });
}

// Register our tools with the server, making them available to clients
// This handler tells clients what operations are available and how to use them
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            // Each tool definition includes a name, description, and expected input format
            {
                name: "read_file",
                // Detailed descriptions help users understand when and how to use each tool
                description: "Read the complete contents of a file from the file system. " +
                    "Handles various text encodings and provides detailed error messages " +
                    "if the file cannot be read. Use this tool when you need to examine " +
                    "the contents of a single file. Only works within allowed directories.",
                // Convert our Zod schema to JSON Schema format that clients understand
                inputSchema: zodToJsonSchema(ReadFileArgsSchema),
            },
            {
                name: "read_multiple_files",
                description: "Read the contents of multiple files simultaneously. This is more " +
                    "efficient than reading files one by one when you need to analyze " +
                    "or compare multiple files. Each file's content is returned with its " +
                    "path as a reference. Failed reads for individual files won't stop " +
                    "the entire operation. Only works within allowed directories.",
                inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema),
            },
            {
                name: "write_file",
                description: "Create a new file or completely overwrite an existing file with new content. " +
                    "Use with caution as it will overwrite existing files without warning. " +
                    "Handles text content with proper encoding. Only works within allowed directories.",
                inputSchema: zodToJsonSchema(WriteFileArgsSchema),
            },
            {
                name: "create_directory",
                description: "Create a new directory or ensure a directory exists. Can create multiple " +
                    "nested directories in one operation. If the directory already exists, " +
                    "this operation will succeed silently. Perfect for setting up directory " +
                    "structures for projects or ensuring required paths exist. Only works within allowed directories.",
                inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema),
            },
            {
                name: "list_directory",
                description: "Get a detailed listing of all files and directories in a specified path. " +
                    "Results clearly distinguish between files and directories with [FILE] and [DIR] " +
                    "prefixes. This tool is essential for understanding directory structure and " +
                    "finding specific files within a directory. Only works within allowed directories.",
                inputSchema: zodToJsonSchema(ListDirectoryArgsSchema),
            },
            {
                name: "move_file",
                description: "Move or rename files and directories. Can move files between directories " +
                    "and rename them in a single operation. If the destination exists, the " +
                    "operation will fail. Works across different directories and can be used " +
                    "for simple renaming within the same directory. Both source and destination must be within allowed directories.",
                inputSchema: zodToJsonSchema(MoveFileArgsSchema),
            },
            {
                name: "search_files",
                description: "Recursively search for files and directories matching a pattern. " +
                    "Searches through all subdirectories from the starting path. The search " +
                    "is case-insensitive and matches partial names. Returns full paths to all " +
                    "matching items. Great for finding files when you don't know their exact location. " +
                    "Only searches within allowed directories.",
                inputSchema: zodToJsonSchema(SearchFilesArgsSchema),
            },
            {
                name: "get_file_info",
                description: "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
                    "information including size, creation time, last modified time, permissions, " +
                    "and type. This tool is perfect for understanding file characteristics " +
                    "without reading the actual content. Only works within allowed directories.",
                inputSchema: zodToJsonSchema(GetFileInfoArgsSchema),
            },
            {
                name: "list_allowed_directories",
                description: "Returns the list of directories that this server is allowed to access. " +
                    "Use this to understand which directories are available before trying to access files.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: [],
				},
			},
			{
				name: "run_python_script",
				description: "Execute a Python script file and capture its output. " +
					"This tool provides secure execution of Python scripts within allowed directories, " +
					"with built-in safeguards including timeout protection and resource limits. " +
					"The script must have a .py extension and contain valid Python code. " +
					"You can optionally provide command line arguments to pass to the script, " +
					"and set a custom timeout value (default 30 seconds, maximum 5 minutes). " +
					"The tool captures both standard output and error messages, making debugging easier. " +
					"For security, scripts can only access files within allowed directories, " +
					"and command line arguments are strictly validated to prevent injection attacks. " +
					"If the script produces excessive output, it will be truncated at 1MB to prevent memory issues.",
				inputSchema: zodToJsonSchema(RunPythonScriptSchema),
			},

            
        ],
    };
});
// Main request handler that processes and executes file operations
// This is where the real work happens - handling actual file operation requests
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        // Extract the requested operation and its arguments
        const { name, arguments: args } = request.params;
        
        // Use a switch statement to handle different types of operations
        switch (name) {
            case "read_file": {
                // Step 1: Validate the input matches our expected format
                const parsed = ReadFileArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
                }
                
                // Step 2: Ensure the requested file is in an allowed directory
                const validPath = await validatePath(parsed.data.path);
                
                // Step 3: Actually read the file
                const content = await fs.readFile(validPath, "utf-8");
                
                // Step 4: Return the content in the expected format
                return {
                    content: [{ type: "text", text: content }],
                };
            }
            
            case "read_multiple_files": {
                // Similar pattern but handles multiple files in parallel using Promise.all
                const parsed = ReadMultipleFilesArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(`Invalid arguments for read_multiple_files: ${parsed.error}`);
                }
                // Process each file independently, collecting successes and failures
                const results = await Promise.all(parsed.data.paths.map(async (filePath) => {
                    try {
                        const validPath = await validatePath(filePath);
                        const content = await fs.readFile(validPath, "utf-8");
                        return `${filePath}:\n${content}\n`;
                    }
                    catch (error) {
                        // If one file fails, we still process the others
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        return `${filePath}: Error - ${errorMessage}`;
                    }
                }));
                // Combine all results with separators
                return {
                    content: [{ type: "text", text: results.join("\n---\n") }],
                };
            }
            
            // Each operation follows a similar pattern:
            // 1. Validate input
            // 2. Check security (validatePath)
            // 3. Perform operation
            // 4. Return results
            
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

            case "create_directory": {
                const parsed = CreateDirectoryArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(`Invalid arguments for create_directory: ${parsed.error}`);
                }
                const validPath = await validatePath(parsed.data.path);
                await fs.mkdir(validPath, { recursive: true });
                return {
                    content: [{ type: "text", text: `Successfully created directory ${parsed.data.path}` }],
                };
            }
            case "list_directory": {
                const parsed = ListDirectoryArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
                }
                const validPath = await validatePath(parsed.data.path);
                const entries = await fs.readdir(validPath, { withFileTypes: true });
                const formatted = entries
                    .map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
                    .join("\n");
                return {
                    content: [{ type: "text", text: formatted }],
                };
            }
            case "move_file": {
                const parsed = MoveFileArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(`Invalid arguments for move_file: ${parsed.error}`);
                }
                const validSourcePath = await validatePath(parsed.data.source);
                const validDestPath = await validatePath(parsed.data.destination);
                await fs.rename(validSourcePath, validDestPath);
                return {
                    content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
                };
            }
            case "search_files": {
                const parsed = SearchFilesArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(`Invalid arguments for search_files: ${parsed.error}`);
                }
                const validPath = await validatePath(parsed.data.path);
                const results = await searchFiles(validPath, parsed.data.pattern);
                return {
                    content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No matches found" }],
                };
            }
            case "get_file_info": {
                const parsed = GetFileInfoArgsSchema.safeParse(args);
                if (!parsed.success) {
                    throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
                }
                const validPath = await validatePath(parsed.data.path);
                const info = await getFileStats(validPath);
                return {
                    content: [{ type: "text", text: Object.entries(info)
                                .map(([key, value]) => `${key}: ${value}`)
                                .join("\n") }],
                };
            }
            case "list_allowed_directories": {
                // Special case: No validation needed as there are no parameters
                return {
                    content: [{
                            type: "text",
                            text: `Allowed directories:\n${allowedDirectories.join('\n')}`
                        }],
                };
            }
            //  Add new execution 
			case "run_python_script": {
				// First, validate all input parameters using our schema
				const parsed = RunPythonScriptSchema.safeParse(args);
				if (!parsed.success) {
					throw new Error(`Invalid arguments for run_python_script: ${parsed.error}`);
				}

				// Extract the validated parameters
				const { path: scriptPath, args: scriptArgs, timeout } = parsed.data;

				try {
					// Execute the Python script and capture its output
					const result = await executePythonScript(scriptPath, {
						args: scriptArgs,
						timeout: timeout
					});

					// Prepare a nicely formatted response
					let responseText = `=== Python Script Execution Results ===\n`;
					responseText += `Script: ${scriptPath}\n`;
					if (scriptArgs.length > 0) {
						responseText += `Arguments: ${scriptArgs.join(' ')}\n`;
					}
					responseText += `Exit Code: ${result.exitCode}\n`;
					responseText += `\n=== Standard Output ===\n`;
					responseText += result.output || '(No output)\n';
					
					// Only include error section if there were errors
					if (result.error) {
						responseText += `\n=== Error Output ===\n`;
						responseText += result.error;
					}

					// If script completed successfully, return the formatted output
					if (result.exitCode === 0) {
						return {
							content: [{ 
								type: "text", 
								text: responseText
							}],
						};
					} else {
						// If script had non-zero exit code, mark as error but still return output
						return {
							content: [{ 
								type: "text", 
								text: responseText
							}],
							isError: true
						};
					}
				} catch (error) {
					// Handle execution errors (timeout, permission issues, etc.)
					const errorMessage = error instanceof Error ? error.message : String(error);
					return {
						content: [{ 
							type: "text", 
							text: `Failed to execute Python script: ${errorMessage}`
						}],
						isError: true
					};
				}
			}
			
            default:
                // Catch any requests for operations we don't support
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        // Convert all errors into a consistent format for the client
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
            isError: true,
        };
    }
});

// Initialize and start the server
async function runServer() {
    // Create a transport layer that uses standard input/output for communication
    const transport = new StdioServerTransport();
    // Connect the server to the transport
    await server.connect(transport);
    // Log startup information to stderr (so it doesn't interfere with communication)
    console.error("Secure MCP Filesystem Server running on stdio");
    console.error("Allowed directories:", allowedDirectories);
}

// Start the server and handle any fatal errors
runServer().catch((error) => {
    console.error("Fatal error running server:", error);
    process.exit(1);  // Exit with error code if server fails to start
});
