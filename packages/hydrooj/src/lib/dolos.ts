/* eslint-disable max-len */
/**
 * PTA fork — Dolos code-similarity engine wrapper.
 *
 * Dolos (https://dolos.ugent.be, Ghent University) is an open-source
 * source-code plagiarism detector in the spirit of MOSS: it tokenizes each
 * program with tree-sitter, fingerprints k-grams of the token stream with
 * winnowing, and reports for every pair of files a `similarity` (0..1,
 * the fraction of shared fingerprints), the `totalOverlap` (number of
 * shared k-grams) and the `longestFragment` (longest run of consecutive
 * shared k-grams). Unlike MOSS it runs LOCALLY — no account, no upload of
 * student code to a third party, no expiring result pages.
 *
 * This module runs the Dolos COMMAND-LINE SCRIPT as a child process
 * (`dolos run -f csv ...`) and parses the CSV report it writes. Running it
 * out of process keeps its native tree-sitter parsers out of the web
 * server: a missing parser or a crash inside Dolos fails one check, never
 * the site.
 *
 * INSTALLING. `@dodona/dolos` is an OPTIONAL dependency of hydrooj
 * (package.json), so a plain `yarn install` fetches it and compiles its
 * tree-sitter parsers — that needs python3, a C++ compiler and the Node
 * headers (all present in Dockerfile.dev's node image); if the build
 * fails, the install still succeeds and only this feature is unavailable.
 * Alternatively install it on the web server with
 *
 *     npm install -g @dodona/dolos
 *
 * With the system setting `similarity.dolos_path` left BLANK the script is
 * auto-detected (resolveCommand): the workspace copy, then a global npm
 * install, then `dolos` on the PATH of the Hydro process. Nothing here
 * touches the database; handler/similarity.ts decides WHAT to compare and
 * stores the results.
 */
import { spawn } from 'child_process';
import { existsSync, promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { Logger } from '../logger';

const logger = new Logger('lib/dolos');

/* ------------------------------------------------------------------ */
/*  Languages                                                          */
/* ------------------------------------------------------------------ */
/**
 * Dolos analyzes one language per run and names them its own way. Hydro's
 * judge language keys (`cc.cc14o2`, `py.py3`, ...) are mapped by their base
 * key first, then by the language's PrismJS `highlight` mode (custom keys
 * such as `mycpp` with `highlight: cpp` still land on the right parser).
 * Anything Dolos cannot parse (Pascal, Kotlin, Haskell, Ruby, ...) falls
 * back to Dolos' character-level comparison (`char`), which is noisier but
 * still catches verbatim copies.
 */
const DOLOS_BY_KEY: Record<string, string> = {
    bash: 'bash',
    sh: 'bash',
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cxx: 'cpp',
    cs: 'c-sharp',
    csharp: 'c-sharp',
    py: 'python',
    python: 'python',
    php: 'php',
    java: 'java',
    js: 'javascript',
    javascript: 'javascript',
    ts: 'typescript',
    typescript: 'typescript',
    tsx: 'tsx',
    go: 'go',
    rs: 'rust',
    rust: 'rust',
    r: 'r',
    scala: 'scala',
    groovy: 'groovy',
    sql: 'sql',
    elm: 'elm',
    ml: 'ocaml',
    ocaml: 'ocaml',
    v: 'verilog',
    verilog: 'verilog',
    mo: 'modelica',
    modelica: 'modelica',
};
const DOLOS_BY_HIGHLIGHT: Record<string, string> = {
    bash: 'bash',
    c: 'c',
    cpp: 'cpp',
    csharp: 'c-sharp',
    python: 'python',
    php: 'php',
    java: 'java',
    javascript: 'javascript',
    typescript: 'typescript',
    tsx: 'tsx',
    go: 'go',
    rust: 'rust',
    r: 'r',
    scala: 'scala',
    groovy: 'groovy',
    sql: 'sql',
    elm: 'elm',
    ocaml: 'ocaml',
    verilog: 'verilog',
    modelica: 'modelica',
};
/** The extension Dolos associates with each of its languages (staged file names). */
const DOLOS_EXT: Record<string, string> = {
    bash: '.sh',
    c: '.c',
    cpp: '.cpp',
    'c-sharp': '.cs',
    python: '.py',
    php: '.php',
    modelica: '.mo',
    ocaml: '.ml',
    java: '.java',
    javascript: '.js',
    elm: '.elm',
    go: '.go',
    groovy: '.groovy',
    r: '.r',
    rust: '.rs',
    scala: '.scala',
    sql: '.sql',
    typescript: '.ts',
    tsx: '.tsx',
    verilog: '.v',
    char: '.txt',
};

export interface DolosLanguage {
    /** The value passed to `dolos run -l`. */
    id: string;
    /** File extension used when staging the submissions. */
    ext: string;
    /** True when Dolos has no parser for this language and compares characters instead. */
    charFallback: boolean;
}

/**
 * Map a Hydro judge language key (plus its `highlight` mode, when known) to
 * the Dolos language that should analyze it.
 */
export function dolosLanguageFor(langKey: string, highlight?: string): DolosLanguage {
    const base = String(langKey || '').split('.')[0].toLowerCase();
    // `highlight` may carry extra modes ("java astyle-java"): the first token names the language.
    const hl = String(highlight || '').trim().split(/\s+/)[0].toLowerCase();
    const id = DOLOS_BY_KEY[base] || DOLOS_BY_HIGHLIGHT[hl] || DOLOS_BY_KEY[hl] || 'char';
    return { id, ext: DOLOS_EXT[id] || '.txt', charFallback: id === 'char' };
}

/* ------------------------------------------------------------------ */
/*  CSV (RFC 4180) — Dolos' files.csv carries multi-line quoted cells   */
/* ------------------------------------------------------------------ */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    let i = 0;
    const src = String(text || '');
    while (i < src.length) {
        const c = src[i];
        if (quoted) {
            if (c === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                quoted = false;
                i++;
                continue;
            }
            field += c;
            i++;
            continue;
        }
        if (c === '"') {
            quoted = true;
            i++;
            continue;
        }
        if (c === ',') {
            row.push(field);
            field = '';
            i++;
            continue;
        }
        if (c === '\n' || c === '\r') {
            if (c === '\r' && src[i + 1] === '\n') i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            i++;
            continue;
        }
        field += c;
        i++;
    }
    if (field.length || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/** Rows as objects keyed by the header row; blank trailing rows are dropped. */
export function csvObjects(text: string): Record<string, string>[] {
    const rows = parseCsv(text).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => {
        const o: Record<string, string> = {};
        header.forEach((h, k) => { o[h] = r[k] ?? ''; });
        return o;
    });
}

export function csvCell(v: any): string {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ------------------------------------------------------------------ */
/*  Running the script                                                 */
/* ------------------------------------------------------------------ */
export interface DolosInputFile {
    /** Base name inside the staging directory (the caller keeps it unique). */
    name: string;
    content: string;
    /** Roster metadata for info.csv (informational only). */
    label?: string;
    fullName?: string;
    createdAt?: Date;
}

export interface DolosRunOptions {
    /** The `dolos` command: an executable name on PATH or a path; may carry leading arguments. */
    command?: string;
    /** Dolos language id (`dolosLanguageFor().id`). */
    language: string;
    /** Extra `dolos run` arguments, e.g. `['-M', '0.8']`. */
    extraArgs?: string[];
    /** Kill the run after this long. */
    timeoutMs?: number;
    /** Report name written into metadata.csv. */
    name?: string;
}

export interface DolosFileResult {
    id: number;
    /** Base name of the staged file (as given in DolosInputFile.name). */
    name: string;
    kgrams: number;
    ignored: boolean;
}

export interface DolosPairResult {
    leftId: number;
    rightId: number;
    leftName: string;
    rightName: string;
    /** 0..1 */
    similarity: number;
    totalOverlap: number;
    longestFragment: number;
    leftCovered: number;
    rightCovered: number;
}

export interface DolosRunResult {
    files: DolosFileResult[];
    pairs: DolosPairResult[];
    metadata: Record<string, string>;
    /** Last lines of the script's console output, for the report's audit trail. */
    log: string;
}

export class DolosError extends Error {
    constructor(message: string, public readonly kind: 'missing' | 'timeout' | 'failed' | 'output') {
        super(message);
        this.name = 'DolosError';
    }
}

interface ResolvedCommand { file: string, leading: string[], display: string }

/** `@dodona/dolos` resolvable from this process (workspace dependency, NODE_PATH, ~/.hydro/addons). */
function localPackageCli(): string | null {
    try {
        const pkg = require.resolve('@dodona/dolos/package.json');
        return path.join(path.dirname(pkg), 'dist', 'cli.js');
    } catch (e) {
        return null;
    }
}

/** A global npm install, looked up in the common prefixes without shelling out to npm. */
function globalPackageCli(): string | null {
    const prefixes = new Set<string>();
    for (const p of [process.env.NPM_CONFIG_PREFIX, process.env.npm_config_prefix, '/usr/local', '/usr', path.join(os.homedir(), '.npm-global')]) {
        if (p) prefixes.add(p);
    }
    // node's own prefix (e.g. /usr/local/bin/node → /usr/local; nvm installs land here too)
    prefixes.add(path.resolve(path.dirname(process.execPath), '..'));
    const rels = ['lib/node_modules/@dodona/dolos/dist/cli.js', 'node_modules/@dodona/dolos/dist/cli.js'];
    for (const prefix of prefixes) {
        for (const rel of rels) {
            const candidate = path.join(prefix, rel);
            if (existsSync(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * The configured command, split into executable + leading arguments
 * (`node /opt/dolos/dist/cli.js` is a valid setting). Blank = auto-detect:
 * the `@dodona/dolos` package installed next to Hydro (a workspace or
 * addon dependency), then a global `npm install -g @dodona/dolos` in the
 * usual prefixes, then `dolos` on the PATH of the Hydro process.
 */
export function resolveCommand(configured?: string): ResolvedCommand {
    const raw = String(configured || '').trim();
    if (raw) {
        const parts = raw.split(/\s+/);
        // A bare path to Dolos' cli.js is run with the current Node binary.
        if (parts.length === 1 && /\.[cm]?js$/i.test(parts[0])) return { file: process.execPath, leading: [parts[0]], display: `node ${parts[0]}` };
        return { file: parts[0], leading: parts.slice(1), display: raw };
    }
    const local = localPackageCli() || globalPackageCli();
    if (local) return { file: process.execPath, leading: [local], display: `node ${local}` };
    return { file: 'dolos', leading: [], display: 'dolos' };
}

/** Console colors off, but Dolos still prints ANSI sequences for its [error] tag. */
function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return String(s || '').replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

function tail(s: string, n = 4000): string {
    return s.length > n ? s.slice(-n) : s;
}

/** Run the executable, capturing output; rejects on ENOENT, timeout or non-zero exit. */
function exec(cmd: ResolvedCommand, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let finished = false;
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(cmd.file, [...cmd.leading, ...args], {
                cwd,
                env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) {
            reject(new DolosError(`Could not start "${cmd.display}": ${e.message}`, 'missing'));
            return;
        }
        const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
            reject(new DolosError(`Dolos did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped.`, 'timeout'));
        }, timeoutMs);
        child.stdout.on('data', (d) => { stdout = tail(stdout + stripAnsi(d.toString()), 65536); });
        child.stderr.on('data', (d) => { stderr = tail(stderr + stripAnsi(d.toString()), 65536); });
        child.on('error', (e: NodeJS.ErrnoException) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (e.code === 'ENOENT') {
                reject(new DolosError(`Dolos is not installed or not found: "${cmd.display}". Install it with "npm install -g @dodona/dolos" and check the system setting similarity.dolos_path.`, 'missing'));
            } else reject(new DolosError(`Could not start "${cmd.display}": ${e.message}`, 'missing'));
        });
        child.on('close', (code, signal) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new DolosError(`Dolos exited with ${signal ? `signal ${signal}` : `code ${code}`}.\n${tail(stderr || stdout, 1500).trim()}`, 'failed'));
        });
    });
}

/** `dolos --version` → e.g. "2.9.3" (null when the script is unavailable). */
export async function dolosVersion(configured?: string, timeoutMs = 20000): Promise<string | null> {
    try {
        const { stdout } = await exec(resolveCommand(configured), ['--version'], os.tmpdir(), timeoutMs);
        const m = /Dolos\s+v?([\d.]+)/i.exec(stdout) || /^v?(\d+\.\d+\.\d+)/m.exec(stdout);
        return m ? m[1] : stdout.trim().split('\n')[0] || null;
    } catch (e) {
        return null;
    }
}

/** Sanitize a file name for the staging directory (no separators, no traversal). */
export function safeFileName(name: string): string {
    return String(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';
}

function clamp01(x: number): number {
    if (!Number.isFinite(x)) return 0;
    return Math.min(1, Math.max(0, x));
}

/**
 * Stage the files in a fresh temporary directory, run
 * `dolos run -f csv -o out -l <language> info.csv`, parse the report and
 * remove the directory again. Every file's `name` must be unique; the
 * results refer to files by that name.
 */
export async function runDolos(files: DolosInputFile[], options: DolosRunOptions): Promise<DolosRunResult> {
    if (files.length < 2) throw new DolosError('At least two files are needed for a comparison.', 'failed');
    const cmd = resolveCommand(options.command);
    const timeoutMs = Math.max(10000, options.timeoutMs || 15 * 60 * 1000);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hydro-dolos-'));
    try {
        const seen = new Set<string>();
        const lines = ['filename,label,created_at,full_name'];
        for (const f of files) {
            const name = safeFileName(f.name);
            if (seen.has(name)) throw new DolosError(`Duplicate staged file name: ${name}`, 'failed');
            seen.add(name);
            // eslint-disable-next-line no-await-in-loop
            await fsp.writeFile(path.join(dir, name), f.content, 'utf8');
            const created = f.createdAt instanceof Date && !Number.isNaN(f.createdAt.getTime())
                ? f.createdAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
                : '';
            lines.push([name, f.label || '', created, f.fullName || ''].map(csvCell).join(','));
        }
        await fsp.writeFile(path.join(dir, 'info.csv'), `${lines.join('\n')}\n`, 'utf8');
        const args = ['run', '-f', 'csv', '-o', 'out', '-l', options.language];
        if (options.name) args.push('-n', safeFileName(options.name));
        for (const a of options.extraArgs || []) if (a) args.push(a);
        args.push('info.csv');
        logger.info('[dolos] %s %s (%d files, cwd %s)', cmd.display, args.join(' '), files.length, dir);
        const { stdout, stderr } = await exec(cmd, args, dir, timeoutMs);
        const out = path.join(dir, 'out');
        let pairsCsv: string;
        let filesCsv: string;
        let metaCsv = '';
        try {
            pairsCsv = await fsp.readFile(path.join(out, 'pairs.csv'), 'utf8');
            filesCsv = await fsp.readFile(path.join(out, 'files.csv'), 'utf8');
        } catch (e) {
            throw new DolosError(`Dolos finished but wrote no CSV report (${e.message}).\n${tail(stderr || stdout, 1000).trim()}`, 'output');
        }
        try { metaCsv = await fsp.readFile(path.join(out, 'metadata.csv'), 'utf8'); } catch (e) { /* optional */ }
        const fileRows = csvObjects(filesCsv);
        const filesById = new Map<number, DolosFileResult>();
        const result: DolosFileResult[] = fileRows.map((r) => {
            const f: DolosFileResult = {
                id: +r.id,
                name: path.basename(r.path || ''),
                kgrams: +r.amountOfKgrams || 0,
                ignored: String(r.ignored).toLowerCase() === 'true',
            };
            filesById.set(f.id, f);
            return f;
        });
        const pairs: DolosPairResult[] = csvObjects(pairsCsv).map((r) => ({
            leftId: +r.leftFileId,
            rightId: +r.rightFileId,
            leftName: filesById.get(+r.leftFileId)?.name || path.basename(r.leftFilePath || ''),
            rightName: filesById.get(+r.rightFileId)?.name || path.basename(r.rightFilePath || ''),
            similarity: clamp01(+r.similarity),
            totalOverlap: +r.totalOverlap || 0,
            longestFragment: +r.longestFragment || 0,
            leftCovered: +r.leftCovered || 0,
            rightCovered: +r.rightCovered || 0,
        })).filter((p) => Number.isFinite(p.leftId) && Number.isFinite(p.rightId) && p.leftId !== p.rightId);
        const metadata: Record<string, string> = {};
        for (const r of csvObjects(metaCsv)) if (r.property) metadata[r.property] = r.value ?? '';
        return {
            files: result, pairs, metadata, log: tail(`${stdout}\n${stderr}`.trim(), 2000),
        };
    } finally {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    }
}
