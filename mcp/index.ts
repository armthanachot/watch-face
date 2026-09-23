import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/*
 * Garmin Connect IQ / Monkey C Development MCP
 *
 * Expected project layout (works with the structure shown by the user):
 *
 *   project-root/
 *   ├─ assets/
 *   ├─ bin/
 *   ├─ mcp/                  <- this file can live here
 *   ├─ resources/
 *   ├─ source/
 *   ├─ developer_key         <- intentionally blocked from normal file reads
 *   ├─ manifest.xml
 *   └─ monkey.jungle
 *
 * Recommended env vars:
 *   MCP_PROJECT_ROOT=/absolute/path/to/project
 *   MCP_PORT=3003
 *   MCP_BASE_URL=http://localhost:3003
 *   GARMIN_DEVICE=venu3
 *   GARMIN_JUNGLE_FILE=monkey.jungle
 *   GARMIN_DEVELOPER_KEY=developer_key
 *   GARMIN_BUILD_OUTPUT=bin/watch_face.prg
 */

function resolveProjectRoot(value: string | undefined) {
    const fallback = path.resolve(import.meta.dir, "..");
    const raw = value?.trim();

    if (!raw) {
        return fallback;
    }

    return path.isAbsolute(raw)
        ? path.normalize(raw)
        : path.resolve(import.meta.dir, raw);
}

const PROJECT_ROOT = resolveProjectRoot(process.env.MCP_PROJECT_ROOT);
const port = Number(process.env.MCP_PORT ?? 3003);
const STATIC_ROUTE_PREFIX = "/files";
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024;
const MAX_BINARY_FILE_SIZE = 50 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_CHARS = 200_000;

const JUNGLE_FILE = process.env.GARMIN_JUNGLE_FILE?.trim() || "monkey.jungle";
const DEVELOPER_KEY = process.env.GARMIN_DEVELOPER_KEY?.trim() || "developer_key";
const BUILD_OUTPUT = process.env.GARMIN_BUILD_OUTPUT?.trim() || "bin/watch_face.prg";

function normalizeMcpBaseUrl(value: string | undefined) {
    const rawBaseUrl = value?.trim() || `http://localhost:${port}`;
    const baseUrl = new URL(rawBaseUrl);

    if (baseUrl.pathname.replace(/\/+$/, "") === "/mcp") {
        baseUrl.pathname = "/";
    }

    baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, "");
    baseUrl.search = "";
    baseUrl.hash = "";

    return baseUrl.toString().replace(/\/+$/, "");
}

const MCP_BASE_URL = normalizeMcpBaseUrl(process.env.MCP_BASE_URL);

const deniedDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    "coverage",
    ".codex_tmp",
    ".claude",
    ".cursor",
    ".idea",
    ".gradle",
    "DerivedData",
    ".DS_Store",
]);

const deniedFiles = new Set([
    ".env",
    ".env.local",
    ".env.development",
    ".env.production",
    ".npmrc",
    "developer_key",
    "developer_key.der",
    "developer_key.pem",
    "id_rsa",
    "id_ed25519",
]);

const textExts = new Set([
    // Monkey C / Connect IQ
    ".mc",
    ".jungle",
    ".mss",
    ".xml",

    // MCP / scripts
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".sh",
    ".bash",
    ".zsh",

    // Generic text/config/docs
    ".json",
    ".md",
    ".txt",
    ".yml",
    ".yaml",
    ".toml",
    ".properties",
    ".csv",
    ".svg",
]);

const allowedTextFileNames = new Set([
    "Makefile",
]);

const imageExts = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
]);

const servableExts = new Set([
    ".pdf",
    ".txt",
    ".json",
    ".xml",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".svg",
    ".prg",
    ".iq",
]);

const mimeTypes = new Map<string, string>([
    [".pdf", "application/pdf"],
    [".txt", "text/plain; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".xml", "application/xml; charset=utf-8"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".gif", "image/gif"],
    [".svg", "image/svg+xml"],
    [".prg", "application/octet-stream"],
    [".iq", "application/octet-stream"],
]);

function toProjectRelative(targetPath: string) {
    return path.relative(PROJECT_ROOT, targetPath).split(path.sep).join("/");
}

function normalizeRelativeForCheck(relativePath: string) {
    return relativePath.split(/[\\/]/).filter(Boolean);
}

function isDeniedRelativePath(relativePath: string) {
    if (!relativePath) {
        return false;
    }

    const parts = normalizeRelativeForCheck(relativePath);
    return parts.some((part) => deniedDirs.has(part));
}

function isSensitiveFileName(fileName: string) {
    const lower = fileName.toLowerCase();

    return (
        deniedFiles.has(fileName) ||
        lower.startsWith(".env") ||
        lower.endsWith(".pem") ||
        lower.endsWith(".p12") ||
        lower.endsWith(".pfx")
    );
}

function isAllowedTextFilePath(targetPath: string) {
    const ext = path.extname(targetPath).toLowerCase();
    const fileName = path.basename(targetPath);

    return textExts.has(ext) || allowedTextFileNames.has(fileName);
}

function resolveInsideProject(filePath: string, allowRoot = false) {
    const targetPath = path.resolve(PROJECT_ROOT, filePath);
    const relativePath = path.relative(PROJECT_ROOT, targetPath);

    if (
        (!allowRoot && !relativePath) ||
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error("Path must be inside project directory.");
    }

    if (relativePath) {
        if (isDeniedRelativePath(relativePath)) {
            throw new Error("Path is inside a denied directory.");
        }

        const fileName = path.basename(targetPath);
        if (isSensitiveFileName(fileName)) {
            throw new Error("Sensitive files are not allowed.");
        }
    }

    return { targetPath, relativePath };
}

function resolveBuildProjectPath(filePath: string) {
    const targetPath = path.resolve(PROJECT_ROOT, filePath);
    const relativePath = path.relative(PROJECT_ROOT, targetPath);

    if (
        !relativePath ||
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error("Build path must be inside project directory.");
    }

    if (isDeniedRelativePath(relativePath)) {
        throw new Error("Build path is inside a denied directory.");
    }

    return { targetPath, relativePath };
}

function resolveDeveloperKeyPath() {
    const raw = DEVELOPER_KEY;
    return path.isAbsolute(raw)
        ? path.normalize(raw)
        : path.resolve(PROJECT_ROOT, raw);
}

async function assertExistingRealPathInsideProject(targetPath: string) {
    const [realProjectRoot, realTargetPath] = await Promise.all([
        fs.realpath(PROJECT_ROOT),
        fs.realpath(targetPath),
    ]);

    const relativePath = path.relative(realProjectRoot, realTargetPath);

    if (
        relativePath.startsWith("..") ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error("Resolved path escapes project directory.");
    }

    if (relativePath && isDeniedRelativePath(relativePath)) {
        throw new Error("Resolved path is inside a denied directory.");
    }

    const fileName = path.basename(realTargetPath);
    if (isSensitiveFileName(fileName)) {
        throw new Error("Sensitive files are not allowed.");
    }

    return {
        realProjectRoot,
        realTargetPath,
        realRelativePath: relativePath,
    };
}

async function assertCreateTargetInsideProject(targetPath: string) {
    let current = path.dirname(targetPath);

    while (true) {
        try {
            const stat = await fs.lstat(current);

            if (stat.isSymbolicLink()) {
                throw new Error("Create target parent cannot be a symbolic link.");
            }

            const { realProjectRoot, realTargetPath } =
                await assertExistingRealPathInsideProject(current);
            const relativePath = path.relative(realProjectRoot, realTargetPath);

            if (
                relativePath.startsWith("..") ||
                path.isAbsolute(relativePath)
            ) {
                throw new Error("Create target resolves outside project directory.");
            }

            return;
        } catch (error: any) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }

        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error("Unable to resolve a safe parent directory.");
        }
        current = parent;
    }
}

async function resolveSafeTextPath(filePath: string) {
    const { targetPath, relativePath } = resolveInsideProject(filePath);

    if (!isAllowedTextFilePath(targetPath)) {
        const ext = path.extname(targetPath).toLowerCase();
        throw new Error(
            `File '${path.basename(targetPath)}' (${ext || "no extension"}) is not allowed for text access.`,
        );
    }

    await assertExistingRealPathInsideProject(targetPath);

    return {
        targetPath,
        relativePath,
        ext: path.extname(targetPath).toLowerCase(),
    };
}

async function resolveSafeCreatePath(filePath: string) {
    const { targetPath } = resolveInsideProject(filePath);
    await assertCreateTargetInsideProject(targetPath);
    return targetPath;
}

async function resolveSafeDeletePath(filePath: string) {
    const { targetPath } = resolveInsideProject(filePath);
    const stat = await fs.lstat(targetPath);

    if (stat.isSymbolicLink()) {
        throw new Error("Symbolic links cannot be deleted with file_delete.");
    }

    const [realProjectRoot, realTargetPath] = await Promise.all([
        fs.realpath(PROJECT_ROOT),
        fs.realpath(targetPath),
    ]);
    const realRelativePath = path.relative(realProjectRoot, realTargetPath);

    if (
        !realRelativePath ||
        realRelativePath.startsWith("..") ||
        path.isAbsolute(realRelativePath)
    ) {
        throw new Error(
            "Delete target must be inside project directory and cannot be the project root.",
        );
    }

    if (isDeniedRelativePath(realRelativePath)) {
        throw new Error("Delete target is inside a denied directory.");
    }

    const fileName = path.basename(realTargetPath);
    if (isSensitiveFileName(fileName)) {
        throw new Error("Sensitive files cannot be deleted.");
    }

    return {
        targetPath: realTargetPath,
        relativePath: realRelativePath,
        stat,
    };
}

async function assertDeleteTreeSafe(targetPath: string) {
    const stat = await fs.lstat(targetPath);
    if (!stat.isDirectory()) {
        return;
    }

    const entries = await fs.readdir(targetPath, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            throw new Error(
                `Directory contains a symbolic link and cannot be deleted: ${entry.name}`,
            );
        }

        if (deniedDirs.has(entry.name)) {
            throw new Error(
                `Directory contains a denied directory and cannot be deleted: ${entry.name}`,
            );
        }

        if (isSensitiveFileName(entry.name)) {
            throw new Error(
                `Directory contains a sensitive file and cannot be deleted: ${entry.name}`,
            );
        }

        if (entry.isDirectory()) {
            await assertDeleteTreeSafe(path.join(targetPath, entry.name));
        }
    }
}

async function resolveSafeServablePath(filePath: string) {
    const { targetPath, relativePath } = resolveInsideProject(filePath);
    const ext = path.extname(targetPath).toLowerCase();

    if (!servableExts.has(ext)) {
        throw new Error(`File extension '${ext || "(none)"}' is not supported.`);
    }

    await assertExistingRealPathInsideProject(targetPath);

    return { targetPath, relativePath, ext };
}

function buildStaticUrl(relativePath: string) {
    const encodedPath = relativePath
        .split(/[\\/]/)
        .map((segment) => encodeURIComponent(segment))
        .join("/");

    return `${MCP_BASE_URL}${STATIC_ROUTE_PREFIX}/${encodedPath}`;
}

function sha256(value: string | Uint8Array) {
    return createHash("sha256").update(value).digest("hex");
}

function replaceLineRange(params: {
    currentText: string;
    replacementContent: string;
    lineStart: number;
    lineEnd: number;
}) {
    const { currentText, replacementContent, lineStart, lineEnd } = params;
    const eol = currentText.includes("\r\n") ? "\r\n" : "\n";
    const hasFinalNewline = currentText.endsWith("\n");
    const lines = currentText.split(/\r?\n/);

    if (hasFinalNewline) {
        lines.pop();
    }

    if (lineStart > lines.length) {
        throw new Error(
            `lineStart ${lineStart} is greater than file line count ${lines.length}.`,
        );
    }

    if (lineEnd > lines.length) {
        throw new Error(
            `lineEnd ${lineEnd} is greater than file line count ${lines.length}.`,
        );
    }

    const replacementLines = replacementContent.split(/\r?\n/);
    if (replacementContent.endsWith("\n")) {
        replacementLines.pop();
    }

    const nextLines = [
        ...lines.slice(0, lineStart - 1),
        ...replacementLines,
        ...lines.slice(lineEnd),
    ];

    return nextLines.join(eol) + (hasFinalNewline ? eol : "");
}

async function readTextFile(targetPath: string) {
    const stat = await fs.stat(targetPath);

    if (!stat.isFile()) {
        throw new Error("Target path is not a file.");
    }

    if (stat.size > MAX_TEXT_FILE_SIZE) {
        throw new Error(
            `Text file exceeds maximum readable size of ${MAX_TEXT_FILE_SIZE} bytes.`,
        );
    }

    return fs.readFile(targetPath, "utf8");
}

async function pathExists(targetPath: string) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function walkFiles(params: {
    rootPath: string;
    maxDepth?: number;
    extensions?: Set<string>;
    textOnly?: boolean;
}) {
    const {
        rootPath,
        maxDepth = Number.POSITIVE_INFINITY,
        extensions,
        textOnly = false,
    } = params;

    const { targetPath: rootTarget } = resolveInsideProject(rootPath, true);
    const output: string[] = [];

    async function shouldIncludeFile(fullPath: string, fileName: string) {
        if (isSensitiveFileName(fileName)) {
            return false;
        }

        if (textOnly && !isAllowedTextFilePath(fullPath)) {
            return false;
        }

        if (extensions) {
            const ext = path.extname(fileName).toLowerCase();
            if (!extensions.has(ext)) {
                return false;
            }
        }

        return true;
    }

    async function visit(currentPath: string, depth: number) {
        if (depth > maxDepth) {
            return;
        }

        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name === ".DS_Store") {
                continue;
            }

            const fullPath = path.join(currentPath, entry.name);
            const relativePath = toProjectRelative(fullPath);

            if (entry.isSymbolicLink()) {
                continue;
            }

            if (entry.isDirectory()) {
                if (deniedDirs.has(entry.name)) {
                    continue;
                }

                await visit(fullPath, depth + 1);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            if (!await shouldIncludeFile(fullPath, entry.name)) {
                continue;
            }

            output.push(relativePath);
        }
    }

    const rootStat = await fs.stat(rootTarget);

    if (rootStat.isFile()) {
        if (!await shouldIncludeFile(rootTarget, path.basename(rootTarget))) {
            return [];
        }

        return [toProjectRelative(rootTarget)];
    }

    await visit(rootTarget, 0);
    return output.sort();
}

function normalizeExtensions(values?: string[]) {
    if (!values?.length) {
        return undefined;
    }

    return new Set(values.map((value) => {
        const normalized = value.trim().toLowerCase();
        return normalized.startsWith(".") ? normalized : `.${normalized}`;
    }));
}

function countOccurrences(value: string, search: string) {
    let count = 0;
    let index = 0;

    while ((index = value.indexOf(search, index)) !== -1) {
        count++;
        index += search.length;
    }

    return count;
}

function lineNumberAt(source: string, index: number) {
    return source.slice(0, index).split(/\r?\n/).length;
}

function clipOutput(value: string) {
    if (value.length <= MAX_PROCESS_OUTPUT_CHARS) {
        return value;
    }

    return `${value.slice(0, MAX_PROCESS_OUTPUT_CHARS)}\n...[output truncated]`;
}

async function buildProcessEnv() {
    const env = { ...process.env } as Record<string, string | undefined>;
    const pathParts = (env.PATH ?? "").split(path.delimiter).filter(Boolean);

    const explicitSdk =
        env.CONNECTIQ_HOME?.trim() ||
        env.CIQ_HOME?.trim() ||
        env.CONNECT_IQ_HOME?.trim();

    const sdkCandidates: string[] = [];

    if (explicitSdk) {
        sdkCandidates.push(explicitSdk);
    }

    const currentSdkConfig = path.join(
        os.homedir(),
        ".Garmin",
        "ConnectIQ",
        "current-sdk.cfg",
    );

    try {
        const configuredSdk = (await fs.readFile(currentSdkConfig, "utf8")).trim();
        if (configuredSdk) {
            sdkCandidates.push(configuredSdk);
        }
    } catch {
        // Optional. PATH may already contain monkeyc / monkeydo.
    }

    for (const sdkPath of sdkCandidates) {
        const binPath = path.join(sdkPath, "bin");
        if (!pathParts.includes(binPath)) {
            pathParts.unshift(binPath);
        }
    }

    env.PATH = pathParts.join(path.delimiter);
    return env;
}

async function runProcess(args: string[], timeoutMs = 120_000) {
    const proc = Bun.spawn(args, {
        cwd: PROJECT_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: await buildProcessEnv(),
    });

    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    let timeout: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
            proc.kill();
            reject(new Error(`Command timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
    });

    try {
        const exitCode = await Promise.race([proc.exited, timeoutPromise]);
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

        return {
            exitCode,
            stdout: clipOutput(stdout),
            stderr: clipOutput(stderr),
        };
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

function parseXmlAttributes(value: string) {
    const attrs: Record<string, string> = {};
    const regex = /([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(value)) !== null) {
        attrs[match[1]] = match[3];
    }

    return attrs;
}

function extractManifestInfo(source: string) {
    const applicationMatch = source.match(/<(?:[A-Za-z_][\w.-]*:)?application\b([^>]*)>/i);
    const application = applicationMatch
        ? parseXmlAttributes(applicationMatch[1])
        : {};

    const products = new Set<string>();
    const permissions = new Set<string>();
    const languages = new Set<string>();

    for (const match of source.matchAll(/<(?:[A-Za-z_][\w.-]*:)?product\b([^>]*)\/?\s*>/gi)) {
        const attrs = parseXmlAttributes(match[1]);
        if (attrs.id) {
            products.add(attrs.id);
        }
    }

    for (const match of source.matchAll(/<(?:[A-Za-z_][\w.-]*:)?uses-permission\b([^>]*)\/?\s*>/gi)) {
        const attrs = parseXmlAttributes(match[1]);
        if (attrs.id) {
            permissions.add(attrs.id);
        }
    }

    for (const match of source.matchAll(/<(?:[A-Za-z_][\w.-]*:)?language\b([^>]*)\/?\s*>/gi)) {
        const attrs = parseXmlAttributes(match[1]);
        if (attrs.id) {
            languages.add(attrs.id);
        }
    }

    return {
        application,
        products: [...products].sort(),
        permissions: [...permissions].sort(),
        languages: [...languages].sort(),
    };
}

function extractMonkeyImports(source: string) {
    const imports = new Set<string>();

    for (const match of source.matchAll(/^\s*(?:using|import)\s+([^;]+);/gm)) {
        imports.add(match[1].trim());
    }

    return [...imports].sort();
}

function extractMonkeyDeclarations(source: string) {
    const modules = new Set<string>();
    const classes = new Set<string>();
    const enums = new Set<string>();
    const functions = new Set<string>();

    for (const match of source.matchAll(/\bmodule\s+([A-Za-z_]\w*)/g)) {
        modules.add(match[1]);
    }

    for (const match of source.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)) {
        classes.add(match[1]);
    }

    for (const match of source.matchAll(/\benum\s+([A-Za-z_]\w*)/g)) {
        enums.add(match[1]);
    }

    for (const match of source.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(/g)) {
        functions.add(match[1]);
    }

    return {
        modules: [...modules].sort(),
        classes: [...classes].sort(),
        enums: [...enums].sort(),
        functions: [...functions].sort(),
    };
}

type RezReference = {
    namespace: string;
    id: string;
    source: string;
    line: number;
};

function extractRezReferences(source: string, filePath: string): RezReference[] {
    const output: RezReference[] = [];
    const regex = /\bRez\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(source)) !== null) {
        output.push({
            namespace: match[1],
            id: match[2],
            source: filePath,
            line: lineNumberAt(source, match.index),
        });
    }

    return output;
}

function extractXmlResourceReferences(source: string, filePath: string): RezReference[] {
    const output: RezReference[] = [];
    const regex = /@([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(source)) !== null) {
        output.push({
            namespace: match[1],
            id: match[2],
            source: filePath,
            line: lineNumberAt(source, match.index),
        });
    }

    return output;
}

function resourceNamespaceForTag(tag: string) {
    switch (tag.toLowerCase()) {
        case "bitmap":
        case "drawable-list":
        case "animation":
            return "Drawables";
        case "string":
            return "Strings";
        case "layout":
            return "Layouts";
        case "font":
            return "Fonts";
        case "menu":
            return "Menus";
        case "jsondata":
        case "json-data":
            return "JsonData";
        default:
            return null;
    }
}

type ResourceDefinition = {
    tag: string;
    namespace: string | null;
    id: string;
    file: string;
    line: number;
};

function extractResourceDefinitions(source: string, filePath: string) {
    const definitions: ResourceDefinition[] = [];
    const filenameRefs: Array<{
        file: string;
        line: number;
        tag: string;
        filename: string;
    }> = [];

    const tagRegex = /<([A-Za-z_][\w:.-]*)\b([^>]*)>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRegex.exec(source)) !== null) {
        const rawTag = match[1];
        const tag = rawTag.includes(":") ? rawTag.split(":").pop()! : rawTag;
        const attrs = parseXmlAttributes(match[2]);
        const line = lineNumberAt(source, match.index);

        if (attrs.id) {
            definitions.push({
                tag,
                namespace: resourceNamespaceForTag(tag),
                id: attrs.id,
                file: filePath,
                line,
            });
        }

        if (attrs.filename) {
            filenameRefs.push({
                file: filePath,
                line,
                tag,
                filename: attrs.filename,
            });
        }
    }

    return { definitions, filenameRefs };
}

function findNearestResourcesRoot(xmlPath: string) {
    let current = path.dirname(xmlPath);

    while (true) {
        const base = path.basename(current).toLowerCase();
        if (base === "resources" || base.startsWith("resources-")) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current || !current.startsWith(PROJECT_ROOT)) {
            return null;
        }
        current = parent;
    }
}

async function resolveResourceFilename(xmlRelativePath: string, filename: string) {
    if (/^[a-z]+:\/\//i.test(filename)) {
        return { exists: true, resolved: filename, external: true };
    }

    const xmlAbsolute = path.join(PROJECT_ROOT, xmlRelativePath);
    const resourcesRoot = findNearestResourcesRoot(xmlAbsolute);

    const candidates = [
        path.resolve(path.dirname(xmlAbsolute), filename),
        ...(resourcesRoot ? [path.resolve(resourcesRoot, filename)] : []),
        path.resolve(PROJECT_ROOT, filename),
    ];

    for (const candidate of [...new Set(candidates)]) {
        const relative = path.relative(PROJECT_ROOT, candidate);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            continue;
        }

        if (await pathExists(candidate)) {
            return {
                exists: true,
                resolved: toProjectRelative(candidate),
                external: false,
            };
        }
    }

    return {
        exists: false,
        resolved: null,
        external: false,
    };
}

async function getManifestInfo() {
    const manifestPath = path.join(PROJECT_ROOT, "manifest.xml");

    if (!await pathExists(manifestPath)) {
        return null;
    }

    const source = await readTextFile(manifestPath);
    return extractManifestInfo(source);
}

async function resolveTargetDevice(inputDevice?: string) {
    const explicit = inputDevice?.trim();
    if (explicit) {
        return explicit;
    }

    const fromEnv = process.env.GARMIN_DEVICE?.trim();
    if (fromEnv) {
        return fromEnv;
    }

    const manifest = await getManifestInfo();
    const products = manifest?.products ?? [];

    if (products.length === 1) {
        return products[0];
    }

    if (products.length > 1) {
        throw new Error(
            `Target device is required because manifest.xml supports multiple products: ${products.join(", ")}. Pass device or set GARMIN_DEVICE.`,
        );
    }

    throw new Error(
        "Target device is required. Pass device or set GARMIN_DEVICE (for example: venu3).",
    );
}

async function performBuild(deviceInput?: string) {
    const device = await resolveTargetDevice(deviceInput);
    const jungle = resolveBuildProjectPath(JUNGLE_FILE);
    const output = resolveBuildProjectPath(BUILD_OUTPUT);
    const developerKey = resolveDeveloperKeyPath();

    if (!await pathExists(jungle.targetPath)) {
        throw new Error(`Jungle file not found: ${JUNGLE_FILE}`);
    }

    if (!await pathExists(developerKey)) {
        throw new Error(
            `Developer key not found at configured path: ${DEVELOPER_KEY}. Set GARMIN_DEVELOPER_KEY if needed.`,
        );
    }

    await fs.mkdir(path.dirname(output.targetPath), { recursive: true });

    const args = [
        "monkeyc",
        "-d",
        device,
        "-f",
        jungle.targetPath,
        "-o",
        output.targetPath,
        "-y",
        developerKey,
    ];

    const result = await runProcess(args, 600_000);

    let artifact: null | {
        path: string;
        bytes: number;
        sha256: string;
        url: string;
    } = null;

    if (result.exitCode === 0 && await pathExists(output.targetPath)) {
        const stat = await fs.stat(output.targetPath);
        const data = new Uint8Array(await fs.readFile(output.targetPath));

        artifact = {
            path: output.relativePath.split(path.sep).join("/"),
            bytes: stat.size,
            sha256: sha256(data),
            url: buildStaticUrl(output.relativePath),
        };
    }

    return {
        device,
        command: [
            "monkeyc",
            "-d",
            device,
            "-f",
            JUNGLE_FILE,
            "-o",
            BUILD_OUTPUT,
            "-y",
            DEVELOPER_KEY,
        ].join(" "),
        cwd: PROJECT_ROOT,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        artifact,
    };
}

const server = new McpServer({
    name: "Garmin Monkey C Watch Face Development MCP",
    version: "1.0.0",
});

const registerTools = () => {
    server.registerTool(
        "get_all_file_structure",
        {
            title: "List Garmin Project Files",
            description:
                "List visible files in the Garmin Connect IQ project. Dependencies, secrets, caches, and denied directories are excluded.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            try {
                const files = await walkFiles({ rootPath: "." });

                return {
                    content: [{
                        type: "text" as const,
                        text:
                            `project root: ${PROJECT_ROOT}\n\n` +
                            `visible project files:\n${files.map((file) => `./${file}`).join("\n")}`,
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "project_search",
        {
            title: "Search Garmin Project Text",
            description:
                "Search readable project files including Monkey C (.mc), Jungle, manifest/resource XML, MCP TypeScript, and text/config files. Supports literal or regex search and bounded context.",
            inputSchema: z.object({
                query: z.string().min(1),
                path: z.string().default("."),
                extensions: z.array(z.string().min(1)).optional(),
                caseSensitive: z.boolean().default(false),
                regex: z.boolean().default(false),
                maxResults: z.number().int().min(1).max(300).default(50),
                contextLines: z.number().int().min(0).max(5).default(0),
            }).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({
            query,
            path: searchPath,
            extensions,
            caseSensitive,
            regex,
            maxResults,
            contextLines,
        }) => {
            try {
                const requestedExts = normalizeExtensions(extensions);

                if (requestedExts) {
                    const invalid = [...requestedExts].filter((ext) => !textExts.has(ext));
                    if (invalid.length) {
                        throw new Error(
                            `Unsupported text extensions: ${invalid.join(", ")}`,
                        );
                    }
                }

                const files = await walkFiles({
                    rootPath: searchPath,
                    extensions: requestedExts,
                    textOnly: true,
                });

                const flags = caseSensitive ? "g" : "gi";
                const matcher = regex ? new RegExp(query, flags) : null;
                const needle = caseSensitive ? query : query.toLowerCase();
                const results: string[] = [];

                for (const file of files) {
                    if (results.length >= maxResults) {
                        break;
                    }

                    const targetPath = path.join(PROJECT_ROOT, file);
                    const stat = await fs.stat(targetPath);
                    if (!stat.isFile() || stat.size > MAX_TEXT_FILE_SIZE) {
                        continue;
                    }

                    const source = await fs.readFile(targetPath, "utf8");
                    const lines = source.split(/\r?\n/);

                    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                        const line = lines[i];
                        const matched = regex
                            ? (() => {
                                matcher!.lastIndex = 0;
                                return matcher!.test(line);
                            })()
                            : (caseSensitive ? line : line.toLowerCase()).includes(needle);

                        if (!matched) {
                            continue;
                        }

                        const start = Math.max(0, i - contextLines);
                        const end = Math.min(lines.length - 1, i + contextLines);
                        const context = lines
                            .slice(start, end + 1)
                            .map((value, offset) => `${start + offset + 1}: ${value}`)
                            .join("\n");

                        results.push(`${file}:${i + 1}\n${context}`);
                    }
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: results.length
                            ? `Found ${results.length} result(s):\n\n${results.join("\n\n---\n\n")}`
                            : "No matches found.",
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    // Monkey C-specific tool #1
    server.registerTool(
        "watchface_context",
        {
            title: "Inspect Monkey C Watch Face Context",
            description:
                "Summarize the Garmin watch-face project: manifest metadata/products/permissions, Jungle file, Monkey C source files, imports/usings, modules/classes/enums/functions, Rez resource references, and resource XML files. Optionally include bounded file contents.",
            inputSchema: z.object({
                path: z.string().default("."),
                includeContent: z.boolean().default(false),
                maxCharsPerFile: z.number().int().min(1000).max(30000).default(8000),
                maxFilesWithContent: z.number().int().min(1).max(20).default(8),
            }).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ path: contextPath, includeContent, maxCharsPerFile, maxFilesWithContent }) => {
            try {
                const files = await walkFiles({
                    rootPath: contextPath,
                    textOnly: true,
                });

                const monkeyFiles = files.filter((file) => file.endsWith(".mc"));
                const resourceXmlFiles = files.filter((file) => {
                    if (!file.endsWith(".xml")) {
                        return false;
                    }
                    return normalizeRelativeForCheck(file)
                        .some((part) => part === "resources" || part.startsWith("resources-"));
                });

                const imports = new Set<string>();
                const modules = new Set<string>();
                const classes = new Set<string>();
                const enums = new Set<string>();
                const functions = new Set<string>();
                const rezReferences: RezReference[] = [];
                const contentBlocks: string[] = [];

                for (const file of monkeyFiles) {
                    const source = await readTextFile(path.join(PROJECT_ROOT, file));

                    extractMonkeyImports(source).forEach((value) => imports.add(value));
                    const declarations = extractMonkeyDeclarations(source);
                    declarations.modules.forEach((value) => modules.add(value));
                    declarations.classes.forEach((value) => classes.add(value));
                    declarations.enums.forEach((value) => enums.add(value));
                    declarations.functions.forEach((value) => functions.add(value));
                    rezReferences.push(...extractRezReferences(source, file));
                }

                const manifestPath = path.join(PROJECT_ROOT, "manifest.xml");
                const manifest = await pathExists(manifestPath)
                    ? extractManifestInfo(await readTextFile(manifestPath))
                    : null;

                const junglePath = path.join(PROJECT_ROOT, JUNGLE_FILE);
                const jungle = await pathExists(junglePath)
                    ? (await readTextFile(junglePath)).slice(0, 20_000)
                    : null;

                if (includeContent) {
                    const candidates = files
                        .filter((file) => isAllowedTextFilePath(path.join(PROJECT_ROOT, file)))
                        .slice(0, maxFilesWithContent);

                    for (const file of candidates) {
                        const source = await readTextFile(path.join(PROJECT_ROOT, file));
                        const clipped = source.length > maxCharsPerFile
                            ? `${source.slice(0, maxCharsPerFile)}\n...[truncated]`
                            : source;
                        contentBlocks.push(`### ${file}\n${clipped}`);
                    }
                }

                const payload = {
                    path: contextPath,
                    manifest,
                    jungleFile: JUNGLE_FILE,
                    jungle,
                    files,
                    monkeyFiles,
                    resourceXmlFiles,
                    imports: [...imports].sort(),
                    declarations: {
                        modules: [...modules].sort(),
                        classes: [...classes].sort(),
                        enums: [...enums].sort(),
                        functions: [...functions].sort(),
                    },
                    rezReferences,
                };

                return {
                    content: [{
                        type: "text" as const,
                        text:
                            JSON.stringify(payload, null, 2) +
                            (contentBlocks.length
                                ? `\n\n${contentBlocks.join("\n\n")}`
                                : ""),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    // Monkey C-specific tool #2
    server.registerTool(
        "resource_audit",
        {
            title: "Audit Garmin Resources",
            description:
                "Audit Connect IQ resources. Detects Rez.* references used by Monkey C source, resource IDs declared in resource XML files, missing referenced resource IDs, duplicate resource IDs, unused declared resources, and missing files referenced by filename attributes.",
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async () => {
            try {
                const allTextFiles = await walkFiles({ rootPath: ".", textOnly: true });
                const monkeyFiles = allTextFiles.filter((file) => file.endsWith(".mc"));
                const resourceXmlFiles = allTextFiles.filter((file) => {
                    if (!file.endsWith(".xml")) {
                        return false;
                    }
                    return normalizeRelativeForCheck(file)
                        .some((part) => part === "resources" || part.startsWith("resources-"));
                });

                const references: RezReference[] = [];
                for (const file of monkeyFiles) {
                    const source = await readTextFile(path.join(PROJECT_ROOT, file));
                    references.push(...extractRezReferences(source, file));
                }

                const xmlReferenceFiles = allTextFiles.filter((file) => file.endsWith(".xml"));
                for (const file of xmlReferenceFiles) {
                    const source = await readTextFile(path.join(PROJECT_ROOT, file));
                    references.push(...extractXmlResourceReferences(source, file));
                }

                const definitions: ResourceDefinition[] = [];
                const filenameRefs: Array<{
                    file: string;
                    line: number;
                    tag: string;
                    filename: string;
                }> = [];

                for (const file of resourceXmlFiles) {
                    const source = await readTextFile(path.join(PROJECT_ROOT, file));
                    const extracted = extractResourceDefinitions(source, file);
                    definitions.push(...extracted.definitions);
                    filenameRefs.push(...extracted.filenameRefs);
                }

                const definedKeys = new Map<string, ResourceDefinition[]>();
                for (const item of definitions) {
                    if (!item.namespace) {
                        continue;
                    }
                    const key = `${item.namespace}.${item.id}`;
                    const bucket = definedKeys.get(key) ?? [];
                    bucket.push(item);
                    definedKeys.set(key, bucket);
                }

                const referencedKeys = new Set(
                    references.map((item) => `${item.namespace}.${item.id}`),
                );

                const missingReferences = references.filter(
                    (item) => !definedKeys.has(`${item.namespace}.${item.id}`),
                );

                const duplicates = [...definedKeys.entries()]
                    .filter(([, items]) => items.length > 1)
                    .map(([key, items]) => ({ key, definitions: items }));

                const unusedDefinitions = [...definedKeys.entries()]
                    .filter(([key]) => !referencedKeys.has(key))
                    .map(([key, items]) => ({ key, definitions: items }));

                const missingFiles: Array<{
                    file: string;
                    line: number;
                    tag: string;
                    filename: string;
                }> = [];

                for (const ref of filenameRefs) {
                    const resolved = await resolveResourceFilename(ref.file, ref.filename);
                    if (!resolved.exists) {
                        missingFiles.push(ref);
                    }
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify({
                            summary: {
                                monkeyFiles: monkeyFiles.length,
                                resourceXmlFiles: resourceXmlFiles.length,
                                rezReferences: references.length,
                                resourceDefinitions: definitions.length,
                                missingReferences: missingReferences.length,
                                duplicateIds: duplicates.length,
                                unusedDefinitions: unusedDefinitions.length,
                                missingResourceFiles: missingFiles.length,
                            },
                            missingReferences,
                            duplicates,
                            unusedDefinitions,
                            missingResourceFiles: missingFiles,
                        }, null, 2),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "build",
        {
            title: "Build Garmin Watch Face PRG",
            description:
                "Compile the Monkey C project into one device-specific .prg file ready for sideloading to a supported Garmin watch. Uses monkeyc with monkey.jungle and the configured developer key. There is intentionally only one build tool; no Flutter-style debug/release split.",
            inputSchema: z.object({
                device: z.string().min(1).optional().describe(
                    "Garmin product id, e.g. venu3. Optional when GARMIN_DEVICE is set or manifest.xml contains exactly one product.",
                ),
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ device }) => {
            try {
                const result = await performBuild(device);

                return {
                    isError: result.exitCode !== 0,
                    content: [{
                        type: "text" as const,
                        text: JSON.stringify(result, null, 2),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    // Monkey C-specific tool #3
    server.registerTool(
        "simulator_run",
        {
            title: "Run PRG in Garmin Simulator",
            description:
                "Run the current built PRG with monkeydo for a target Garmin device. The Connect IQ simulator must already be running. This tool does not build automatically; call build first.",
            inputSchema: z.object({
                device: z.string().min(1).optional().describe(
                    "Garmin product id. Optional when GARMIN_DEVICE is set or manifest.xml contains exactly one product.",
                ),
                timeoutMs: z.number().int().min(1000).max(120000).default(30000),
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
        },
        async ({ device, timeoutMs }) => {
            try {
                const targetDevice = await resolveTargetDevice(device);
                const output = resolveBuildProjectPath(BUILD_OUTPUT);

                if (!await pathExists(output.targetPath)) {
                    throw new Error(
                        `Build artifact not found: ${BUILD_OUTPUT}. Call build first.`,
                    );
                }

                const args = ["monkeydo", output.targetPath, targetDevice];
                const result = await runProcess(args, timeoutMs);

                return {
                    isError: result.exitCode !== 0,
                    content: [{
                        type: "text" as const,
                        text: [
                            `command: monkeydo ${BUILD_OUTPUT} ${targetDevice}`,
                            `cwd: ${PROJECT_ROOT}`,
                            `exitCode: ${result.exitCode}`,
                            result.stdout ? `stdout:\n${result.stdout}` : "stdout: <empty>",
                            result.stderr ? `stderr:\n${result.stderr}` : "stderr: <empty>",
                        ].join("\n\n"),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "file_read",
        {
            title: "Read Project Text File",
            description:
                "Safely read a UTF-8 text/source file inside the Garmin project. Supports .mc, .jungle, .xml, MCP TypeScript, and common config/docs. Developer keys and other sensitive files are blocked.",
            inputSchema: z.object({
                filePath: z.string().min(1),
                lineStart: z.number().int().min(1).optional(),
                lineEnd: z.number().int().min(1).optional(),
                includeLineNumbers: z.boolean().default(false),
            }).strict().superRefine((value, ctx) => {
                if ((value.lineStart === undefined) !== (value.lineEnd === undefined)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "lineStart and lineEnd must be provided together.",
                    });
                }

                if (
                    value.lineStart !== undefined &&
                    value.lineEnd !== undefined &&
                    value.lineEnd < value.lineStart
                ) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ["lineEnd"],
                        message: "lineEnd must be greater than or equal to lineStart.",
                    });
                }
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ filePath, lineStart, lineEnd, includeLineNumbers }) => {
            try {
                const { targetPath } = await resolveSafeTextPath(filePath);
                const source = await readTextFile(targetPath);
                const hash = sha256(source);
                const lines = source.split(/\r?\n/);

                let start = 1;
                let end = lines.length;

                if (lineStart !== undefined && lineEnd !== undefined) {
                    if (lineStart > lines.length || lineEnd > lines.length) {
                        throw new Error(
                            `Requested range ${lineStart}-${lineEnd} exceeds file line count ${lines.length}.`,
                        );
                    }

                    start = lineStart;
                    end = lineEnd;
                }

                const selected = lines.slice(start - 1, end);
                const text = includeLineNumbers
                    ? selected.map((line, index) => `${start + index}: ${line}`).join("\n")
                    : selected.join("\n");

                return {
                    content: [{
                        type: "text" as const,
                        text: `sha256: ${hash}\nlines: ${start}-${end}/${lines.length}\n\n${text}`,
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "file_edit",
        {
            title: "Edit Project Text File",
            description:
                "Safely edit a Monkey C/project text file using line-range replacement or exact text replacement. Optional expectedSha256 protects against overwriting concurrent changes.",
            inputSchema: z.object({
                filePath: z.string().min(1),
                content: z.string().optional(),
                lineStart: z.number().int().min(1).optional(),
                lineEnd: z.number().int().min(1).optional(),
                oldText: z.string().min(1).optional(),
                newText: z.string().optional(),
                expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
            }).strict().superRefine((value, ctx) => {
                const lineMode =
                    value.content !== undefined ||
                    value.lineStart !== undefined ||
                    value.lineEnd !== undefined;
                const textMode =
                    value.oldText !== undefined ||
                    value.newText !== undefined;

                if (lineMode === textMode) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message:
                            "Use exactly one edit mode: line range (content + lineStart + lineEnd) OR text patch (oldText + newText).",
                    });
                    return;
                }

                if (lineMode) {
                    if (
                        value.content === undefined ||
                        value.lineStart === undefined ||
                        value.lineEnd === undefined
                    ) {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            message:
                                "Line-range mode requires content, lineStart, and lineEnd.",
                        });
                    } else if (value.lineEnd < value.lineStart) {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            path: ["lineEnd"],
                            message:
                                "lineEnd must be greater than or equal to lineStart.",
                        });
                    }
                }

                if (textMode && (value.oldText === undefined || value.newText === undefined)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: "Text-patch mode requires oldText and newText.",
                    });
                }
            }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
        },
        async ({
            filePath,
            content,
            lineStart,
            lineEnd,
            oldText,
            newText,
            expectedSha256,
        }) => {
            try {
                const { targetPath } = await resolveSafeTextPath(filePath);
                const currentText = await readTextFile(targetPath);
                const currentHash = sha256(currentText);

                if (
                    expectedSha256 &&
                    currentHash.toLowerCase() !== expectedSha256.toLowerCase()
                ) {
                    throw new Error(
                        `PATCH_CONFLICT: file hash changed. expected=${expectedSha256} actual=${currentHash}`,
                    );
                }

                let nextText: string;
                let mode: string;

                if (oldText !== undefined && newText !== undefined) {
                    const matches = countOccurrences(currentText, oldText);

                    if (matches === 0) {
                        throw new Error(
                            "PATCH_CONFLICT: oldText was not found in the current file.",
                        );
                    }

                    if (matches > 1) {
                        throw new Error(
                            `PATCH_CONFLICT: oldText matched ${matches} locations. Provide a more specific oldText.`,
                        );
                    }

                    nextText = currentText.replace(oldText, newText);
                    mode = "text-patch";
                } else {
                    nextText = replaceLineRange({
                        currentText,
                        replacementContent: content!,
                        lineStart: lineStart!,
                        lineEnd: lineEnd!,
                    });
                    mode = `lines ${lineStart}-${lineEnd}`;
                }

                await fs.writeFile(targetPath, nextText, "utf8");

                return {
                    content: [{
                        type: "text" as const,
                        text: `OK: edited ${filePath} (${mode})\nsha256: ${sha256(nextText)}`,
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "file_create",
        {
            title: "Create Project Text Files",
            description:
                "Create one or more text/source files inside the Garmin project. Supports Monkey C, Jungle, XML, MCP TypeScript, and common text/config extensions. Parent directories are created automatically.",
            inputSchema: z.object({
                files: z.array(z.object({
                    filePath: z.string().min(1),
                    content: z.string(),
                }).strict()).min(1),
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ files }) => {
            try {
                const results: string[] = [];

                for (const file of files) {
                    const targetPath = await resolveSafeCreatePath(file.filePath);

                    if (!isAllowedTextFilePath(targetPath)) {
                        const ext = path.extname(targetPath).toLowerCase();
                        throw new Error(
                            `Text file '${file.filePath}' (${ext || "no extension"}) is not allowed.`,
                        );
                    }

                    await fs.mkdir(path.dirname(targetPath), { recursive: true });
                    await fs.writeFile(targetPath, file.content, "utf8");
                    results.push(`OK: wrote ${file.filePath}`);
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: results.join("\n"),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    const isAllowedOpenAIImageUrl = (value: string) => {
        const url = new URL(value);

        if (url.protocol !== "https:") {
            return false;
        }

        const hostname = url.hostname.toLowerCase();

        return (
            hostname === "openai.com" ||
            hostname.endsWith(".openai.com") ||
            hostname === "oaiusercontent.com" ||
            hostname.endsWith(".oaiusercontent.com") ||
            (hostname.startsWith("oaidalleapi") && hostname.endsWith(".blob.core.windows.net"))
        );
    };

    server.registerTool(
        "image_file_create",
        {
            title: "Create Garmin Image Resources",
            description:
                "Create one or more watch-face image files from raw bytes or an allowed OpenAI/OAI HTTPS image URL. Supports PNG, JPG, JPEG, GIF, and SVG.",
            inputSchema: z.object({
                files: z.array(z.object({
                    filePath: z.string().min(1),
                    bytes: z.array(z.number().int().min(0).max(255)).optional(),
                    url: z.string().url().optional(),
                }).strict().superRefine((value, ctx) => {
                    const sourceCount =
                        Number(value.bytes !== undefined) +
                        Number(value.url !== undefined);

                    if (sourceCount !== 1) {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            message: "Provide exactly one image source: bytes or url.",
                        });
                    }
                })).min(1),
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ files }) => {
            try {
                const results: string[] = [];

                for (const file of files) {
                    const targetPath = await resolveSafeCreatePath(file.filePath);
                    const ext = path.extname(targetPath).toLowerCase();

                    if (!imageExts.has(ext)) {
                        throw new Error(
                            `Image extension '${ext || "(none)"}' is not allowed: ${file.filePath}`,
                        );
                    }

                    let imageBytes: Uint8Array;

                    if (file.bytes !== undefined) {
                        imageBytes = Uint8Array.from(file.bytes);
                    } else {
                        if (!file.url || !isAllowedOpenAIImageUrl(file.url)) {
                            throw new Error(
                                `Image URL is not an allowed OpenAI/OAI HTTPS URL: ${file.filePath}`,
                            );
                        }

                        const response = await fetch(file.url, { redirect: "follow" });
                        if (!response.ok) {
                            throw new Error(
                                `Failed to download image for ${file.filePath}: HTTP ${response.status}`,
                            );
                        }

                        const contentType =
                            response.headers.get("content-type")?.toLowerCase() ?? "";
                        if (contentType && !contentType.startsWith("image/")) {
                            throw new Error(
                                `Downloaded content is not an image for ${file.filePath}: ${contentType}`,
                            );
                        }

                        imageBytes = new Uint8Array(await response.arrayBuffer());
                    }

                    if (imageBytes.byteLength > MAX_BINARY_FILE_SIZE) {
                        throw new Error(
                            `Image exceeds maximum size of ${MAX_BINARY_FILE_SIZE} bytes: ${file.filePath}`,
                        );
                    }

                    await fs.mkdir(path.dirname(targetPath), { recursive: true });
                    await fs.writeFile(targetPath, imageBytes);
                    results.push(
                        `OK: wrote ${file.filePath} (${imageBytes.byteLength} bytes)`,
                    );
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: results.join("\n"),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "binary_file_create",
        {
            title: "Create Project Binary Files",
            description:
                "Create binary files inside the Garmin project from an HTTPS URL, base64 content, or raw bytes. Useful for generated assets and non-text resources. Local/private-network URLs and files larger than 50 MB are rejected.",
            inputSchema: z.object({
                files: z.array(z.object({
                    filePath: z.string().min(1),
                    url: z.string().url().optional(),
                    base64: z.string().min(1).optional(),
                    bytes: z.array(z.number().int().min(0).max(255)).optional(),
                }).strict().superRefine((value, ctx) => {
                    const sourceCount =
                        Number(value.url !== undefined) +
                        Number(value.base64 !== undefined) +
                        Number(value.bytes !== undefined);

                    if (sourceCount !== 1) {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            message:
                                "Provide exactly one binary source: url, base64, or bytes.",
                        });
                    }
                })).min(1),
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
            },
        },
        async ({ files }) => {
            const MAX_REDIRECTS = 5;

            const assertSafeRemoteUrl = (value: string) => {
                const url = new URL(value);

                if (url.protocol !== "https:") {
                    throw new Error("Binary file URL must use HTTPS.");
                }

                const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
                const parts = hostname.split(".").map(Number);
                const isPrivateIpv4 =
                    parts.length === 4 &&
                    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
                    (
                        parts[0] === 10 ||
                        parts[0] === 127 ||
                        (parts[0] === 169 && parts[1] === 254) ||
                        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
                        (parts[0] === 192 && parts[1] === 168)
                    );

                const isPrivateIpv6 =
                    hostname === "::1" ||
                    hostname.startsWith("fc") ||
                    hostname.startsWith("fd") ||
                    hostname.startsWith("fe80:");

                if (
                    hostname === "localhost" ||
                    hostname.endsWith(".localhost") ||
                    hostname.endsWith(".local") ||
                    isPrivateIpv4 ||
                    isPrivateIpv6
                ) {
                    throw new Error(
                        "Binary file URL cannot target localhost or a private network address.",
                    );
                }

                return url;
            };

            const downloadBinary = async (value: string) => {
                let currentUrl = assertSafeRemoteUrl(value);

                for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
                    const response = await fetch(currentUrl, { redirect: "manual" });

                    if (response.status >= 300 && response.status < 400) {
                        const location = response.headers.get("location");
                        if (!location) {
                            throw new Error(
                                `Redirect response from ${currentUrl.toString()} has no Location header.`,
                            );
                        }
                        if (redirectCount === MAX_REDIRECTS) {
                            throw new Error(
                                "Too many redirects while downloading binary file.",
                            );
                        }
                        currentUrl = assertSafeRemoteUrl(
                            new URL(location, currentUrl).toString(),
                        );
                        continue;
                    }

                    if (!response.ok) {
                        throw new Error(
                            `Failed to download binary file: HTTP ${response.status}`,
                        );
                    }

                    const contentLength = Number(
                        response.headers.get("content-length") ?? 0,
                    );
                    if (contentLength > MAX_BINARY_FILE_SIZE) {
                        throw new Error(
                            `Remote file exceeds maximum size of ${MAX_BINARY_FILE_SIZE} bytes.`,
                        );
                    }

                    const data = new Uint8Array(await response.arrayBuffer());
                    if (data.byteLength > MAX_BINARY_FILE_SIZE) {
                        throw new Error(
                            `Downloaded file exceeds maximum size of ${MAX_BINARY_FILE_SIZE} bytes.`,
                        );
                    }
                    return data;
                }

                throw new Error("Unable to download binary file.");
            };

            const decodeBase64 = (value: string) => {
                const normalized = value.replace(/\s+/g, "");

                if (
                    normalized.length === 0 ||
                    normalized.length % 4 !== 0 ||
                    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
                ) {
                    throw new Error("Invalid base64 content.");
                }

                const data = Buffer.from(normalized, "base64");
                if (data.byteLength > MAX_BINARY_FILE_SIZE) {
                    throw new Error(
                        `Base64 file exceeds maximum size of ${MAX_BINARY_FILE_SIZE} bytes.`,
                    );
                }
                return data;
            };

            try {
                const results: string[] = [];

                for (const file of files) {
                    const targetPath = await resolveSafeCreatePath(file.filePath);

                    if (isAllowedTextFilePath(targetPath)) {
                        throw new Error(
                            `binary_file_create cannot overwrite text/source file: ${file.filePath}. Use file_create or file_edit instead.`,
                        );
                    }

                    let binaryData: Uint8Array;
                    let sourceType: "url" | "base64" | "bytes";

                    if (file.url !== undefined) {
                        binaryData = await downloadBinary(file.url);
                        sourceType = "url";
                    } else if (file.base64 !== undefined) {
                        binaryData = decodeBase64(file.base64);
                        sourceType = "base64";
                    } else {
                        const bytes = file.bytes ?? [];
                        if (bytes.length > MAX_BINARY_FILE_SIZE) {
                            throw new Error(
                                `Byte array exceeds maximum size of ${MAX_BINARY_FILE_SIZE} bytes.`,
                            );
                        }
                        binaryData = Uint8Array.from(bytes);
                        sourceType = "bytes";
                    }

                    await fs.mkdir(path.dirname(targetPath), { recursive: true });
                    await fs.writeFile(targetPath, binaryData);
                    results.push(
                        `OK: wrote ${file.filePath} (${binaryData.byteLength} bytes, source=${sourceType})`,
                    );
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: results.join("\n"),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "file_delete",
        {
            title: "Delete Project Files or Folders",
            description:
                "Delete files or folders inside the Garmin project. Project root, developer keys/secrets, denied directories, and symbolic links are protected.",
            inputSchema: z.object({
                paths: z.array(z.string().min(1)).min(1),
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ paths }) => {
            try {
                const results: string[] = [];
                const uniquePaths = [...new Set<string>(paths as string[])];

                for (const filePath of uniquePaths) {
                    let resolved: Awaited<ReturnType<typeof resolveSafeDeletePath>>;

                    try {
                        resolved = await resolveSafeDeletePath(filePath);
                    } catch (error: any) {
                        if (error?.code === "ENOENT") {
                            results.push(`SKIPPED: ${filePath} does not exist`);
                            continue;
                        }
                        throw error;
                    }

                    await assertDeleteTreeSafe(resolved.targetPath);
                    await fs.rm(resolved.targetPath, {
                        recursive: resolved.stat.isDirectory(),
                        force: false,
                    });
                    results.push(
                        `OK: deleted ${resolved.relativePath}${resolved.stat.isDirectory() ? "/" : ""}`,
                    );
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: results.join("\n"),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "document_reader",
        {
            title: "Project File URL",
            description:
                "Return a static URL for a supported project file, including built .prg/.iq artifacts and text/XML/PDF files. Use image_reader for image files.",
            inputSchema: z.object({
                filePath: z.string().min(1),
            }).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ filePath }) => {
            try {
                const { targetPath, relativePath, ext } =
                    await resolveSafeServablePath(filePath);

                if (imageExts.has(ext)) {
                    throw new Error("Image files must be read with image_reader.");
                }

                const stat = await fs.stat(targetPath);
                if (!stat.isFile()) {
                    throw new Error("Target path is not a file.");
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: buildStaticUrl(relativePath),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );

    server.registerTool(
        "image_reader",
        {
            title: "Image Reader",
            description:
                "Return a static URL for a project image. Supports PNG, JPG, JPEG, GIF, and SVG.",
            inputSchema: z.object({
                filePath: z.string().min(1),
            }).strict(),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ filePath }) => {
            try {
                const { targetPath, relativePath, ext } =
                    await resolveSafeServablePath(filePath);

                if (!imageExts.has(ext)) {
                    throw new Error("Non-image files must be read with document_reader.");
                }

                const stat = await fs.stat(targetPath);
                if (!stat.isFile()) {
                    throw new Error("Target path is not a file.");
                }

                return {
                    content: [{
                        type: "text" as const,
                        text: buildStaticUrl(relativePath),
                    }],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [{
                        type: "text" as const,
                        text: error instanceof Error ? error.message : String(error),
                    }],
                };
            }
        },
    );
};

registerTools();

const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
});

await server.connect(transport);

Bun.serve({
    port,
    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname.startsWith(`${STATIC_ROUTE_PREFIX}/`)) {
            if (request.method !== "GET" && request.method !== "HEAD") {
                return new Response("Method Not Allowed", { status: 405 });
            }

            try {
                const encodedRelativePath = url.pathname.slice(
                    `${STATIC_ROUTE_PREFIX}/`.length,
                );
                const relativePath = encodedRelativePath
                    .split("/")
                    .map((segment) => decodeURIComponent(segment))
                    .join(path.sep);

                const { targetPath, ext } =
                    await resolveSafeServablePath(relativePath);
                const stat = await fs.stat(targetPath);

                if (!stat.isFile()) {
                    return new Response("Not Found", { status: 404 });
                }

                const file = Bun.file(targetPath);
                const headers = new Headers({
                    "Content-Type":
                        mimeTypes.get(ext) ?? "application/octet-stream",
                    "Content-Disposition":
                        `inline; filename*=UTF-8''${encodeURIComponent(path.basename(targetPath))}`,
                    "Cache-Control": "private, no-store",
                });

                return request.method === "HEAD"
                    ? new Response(null, { status: 200, headers })
                    : new Response(file, { status: 200, headers });
            } catch {
                return new Response("Not Found", { status: 404 });
            }
        }

        if (url.pathname === "/mcp") {
            return transport.handleRequest(request);
        }

        return new Response("Not Found", { status: 404 });
    },
});

console.log(`Garmin Monkey C MCP project root: ${PROJECT_ROOT}`);
console.log(`MCP server running at ${MCP_BASE_URL}/mcp`);
console.log(`Static files running at ${MCP_BASE_URL}${STATIC_ROUTE_PREFIX}`);
console.log(`Build jungle: ${JUNGLE_FILE}`);
console.log(`Build output: ${BUILD_OUTPUT}`);
